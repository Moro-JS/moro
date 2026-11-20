// Worker Thread Manager - Offload CPU-intensive operations
import type { Worker, ResourceLimits } from 'worker_threads';
import { requireBuiltin } from '../utilities/builtin.js';

// worker_threads on first use (core/utilities/builtin.ts).
const wt = () => requireBuiltin<typeof import('worker_threads')>('worker_threads');
import { createFrameworkLogger } from '../logger/index.js';
import { usableCpuCount } from '../cluster/thread-cluster.js';
import { isPackageAvailable } from '../utilities/package-utils.js';
// WORKER_ENTRY resolves to worker.js, this file's compiled sibling in dist/**,
// via import.meta in ./worker-entry.js. That ESM-only syntax is isolated in its
// own module (mapped to a stub in jest.config) so importing WorkerManager under
// ts-jest's CommonJS transform never hits a load-time import.meta SyntaxError.
import { WORKER_ENTRY } from './worker-entry.js';

// Optional JWT import
const jwtAvailable = isPackageAvailable('jsonwebtoken');

// transformJSON runs caller-supplied function text, and only ever inside an
// isolated-vm isolate
const isolatedVMAvailable = isPackageAvailable('isolated-vm');

/**
 * Why transformJSON cannot run without isolated-vm. Shared with the worker so
 * the refusal reads the same wherever it is raised.
 * @internal
 */
export const TRANSFORM_JSON_NEEDS_ISOLATED_VM =
  'transformJSON requires the "isolated-vm" package, which runs the transformer in a separate ' +
  'V8 isolate. Install it with: npm install isolated-vm. Without it the transformer is not run.';

/**
 * Options of the worker pool.
 */
export interface WorkerPoolOptions {
  workerCount?: number;
  maxQueueSize?: number;
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
  /**
   * V8 limits for each worker thread, passed to `new Worker()` as given
   * (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `codeRangeSizeMb`,
   * `stackSizeMb`). A worker that reaches a limit is terminated by Node: its
   * running task is rejected and the worker is replaced.
   *
   * Not set by default: each worker then has the heap ceiling Node gives any
   * thread of the process.
   */
  resourceLimits?: ResourceLimits;
}

const logger = createFrameworkLogger('WorkerManager');

// Upper bound on the exponential restart backoff
const MAX_RESTART_BACKOFF_MS = 5000;

// Hoisted constants — avoids object allocation inside sort comparator on every call
const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };

// Simple counter for task IDs — avoids expensive crypto.randomBytes for non-security IDs
let taskIdCounter = 0;

/**
 * Worker task definitions
 */
export interface WorkerTask {
  id: string;
  type: string;
  data: any;
  priority?: 'low' | 'normal' | 'high';
  timeout?: number;
}

/**
 * Worker result
 */
export interface WorkerResult {
  taskId: string;
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
}

/**
 * Active task tracking
 */
interface ActiveTask {
  // The task itself, kept so it can be re-queued if its worker is replaced
  task: WorkerTask;
  resolve: CallableFunction;
  reject: CallableFunction;
  timeout: NodeJS.Timeout | null;
  // The worker a task was dispatched to (set once it leaves the queue). Used so a
  // crashed worker only rejects its own in-flight tasks, not everyone else's.
  assignedWorker?: Worker;
}

/**
 * Built-in worker tasks
 */
export const WORKER_TASKS = {
  JWT_VERIFY: 'jwt:verify',
  JWT_SIGN: 'jwt:sign',
  CRYPTO_HASH: 'crypto:hash',
  CRYPTO_ENCRYPT: 'crypto:encrypt',
  CRYPTO_DECRYPT: 'crypto:decrypt',
  DATA_COMPRESS: 'data:compress',
  DATA_DECOMPRESS: 'data:decompress',
  IMAGE_PROCESS: 'image:process',
  HEAVY_COMPUTATION: 'computation:heavy',
  JSON_TRANSFORM: 'json:transform',
} as const;

/**
 * Worker Thread Manager
 * Manages a pool of worker threads for CPU-intensive operations
 */
export class WorkerManager {
  private workers: Map<number, Worker> = new Map();
  private taskQueue: WorkerTask[] = [];
  private activeTasks: Map<string, ActiveTask> = new Map();
  // Tasks dispatched to each live worker that have not settled yet. A worker
  // runs one task at a time; the rest wait in taskQueue, in priority order.
  private inFlight: Map<Worker, number> = new Map();
  private workerCount: number;
  private maxQueueSize: number;
  private isShuttingDown = false;
  private maxRestartAttempts: number;
  private restartBackoffMs: number;
  private restartAttempts = 0;
  private restartTimers = new Set<NodeJS.Timeout>();
  private handledFailures = new WeakSet<Worker>();
  private poolFailed = false;
  private resourceLimits: ResourceLimits | undefined;
  // A pool nobody holds (see detach()): its threads do not keep the process
  // alive, except the one that is running a task.
  private detached = false;

  constructor(options: WorkerPoolOptions = {}) {
    this.workerCount = options.workerCount || Math.max(1, usableCpuCount() - 1); // Leave 1 core for main thread
    this.maxQueueSize = options.maxQueueSize || 1000;
    this.maxRestartAttempts = options.maxRestartAttempts ?? 10;
    this.restartBackoffMs = options.restartBackoffMs ?? 100;
    this.resourceLimits =
      options.resourceLimits && typeof options.resourceLimits === 'object'
        ? { ...options.resourceLimits }
        : undefined;

    this.initializeWorkers();
  }

  /**
   * Initialize worker threads
   */
  private initializeWorkers(): void {
    for (let i = 0; i < this.workerCount; i++) {
      this.createWorker();
    }

    logger.info(`Initialized ${this.workerCount} worker threads`, 'WorkerInit', {
      totalWorkers: this.workerCount,
      maxQueueSize: this.maxQueueSize,
    });
  }

  /**
   * Create a single worker thread
   */
  private createWorker(): void {
    if (this.isShuttingDown || this.poolFailed) {
      return;
    }

    let worker: Worker;
    try {
      worker = new (wt().Worker)(WORKER_ENTRY, {
        workerData: { type: 'worker' },
        ...(this.resourceLimits ? { resourceLimits: this.resourceLimits } : {}),
      });
    } catch (error) {
      // Spawning can fail synchronously (e.g. a missing entry file). Treat it the
      // same as a runtime failure so we back off instead of throwing.
      logger.error('Failed to spawn worker thread', 'WorkerSpawn', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleRestart();
      return;
    }

    worker.on('message', (result: WorkerResult) => {
      // A successful message proves the pool is healthy; reset the restart budget.
      this.restartAttempts = 0;
      this.handleWorkerResult(result, worker);
    });

    worker.on('error', error => {
      logger.error('Worker thread error', 'WorkerError', { error: error.message });
      this.handleWorkerFailure(worker);
    });

    worker.on('exit', code => {
      if (code !== 0 && !this.isShuttingDown) {
        logger.warn(`Worker exited with code ${code}, restarting`, 'WorkerExit');
        this.handleWorkerFailure(worker);
      }
    });

    this.workers.set(worker.threadId, worker);
    this.inFlight.set(worker, 0);
    if (this.detached) worker.unref();
    logger.debug(`Created worker thread ${worker.threadId}`, 'WorkerCreate');
  }

  /**
   * Stop the pool's idle threads from keeping the process alive. For a pool
   * that no app holds: the one getWorkerManager() starts after the previous
   * pool was shut down with the last app that used it. A thread counts again
   * while it runs a task, so a task that was handed in is still answered.
   * @internal
   */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    for (const [worker, load] of this.inFlight) {
      if (load === 0) worker.unref();
    }
  }

  /**
   * The opposite of detach(): an app has taken the pool, and its threads
   * keep the process alive until shutdown(), as those of a first pool do.
   * @internal
   */
  retain(): void {
    if (!this.detached) return;
    this.detached = false;
    for (const worker of this.workers.values()) worker.ref();
  }

  /**
   * Handle a crashed worker: reject only the tasks that were assigned to it and
   * schedule a backed-off restart. A failed worker emits both 'error' and 'exit',
   * so this is guarded to run at most once per worker.
   */
  private handleWorkerFailure(worker: Worker): void {
    if (this.handledFailures.has(worker)) {
      return;
    }
    this.handledFailures.add(worker);

    this.removeWorker(worker);

    if (this.isShuttingDown) {
      return;
    }

    // Reject only the tasks that were dispatched to this specific worker. Tasks
    // still queued (or running on other workers) are intentionally left alone.
    for (const [taskId, taskInfo] of this.activeTasks.entries()) {
      if (taskInfo.assignedWorker === worker) {
        if (taskInfo.timeout) {
          clearTimeout(taskInfo.timeout);
        }
        taskInfo.reject(new Error('Worker thread failed'));
        this.activeTasks.delete(taskId);
      }
    }

    this.scheduleRestart();
  }

  /**
   * Remove a worker from the pool. Looked up by identity: `worker.threadId`
   * reads -1 once the thread has exited, so it cannot be used as the key from
   * an 'exit' handler.
   */
  private removeWorker(worker: Worker): void {
    this.inFlight.delete(worker);
    for (const [threadId, candidate] of this.workers.entries()) {
      if (candidate === worker) {
        this.workers.delete(threadId);
        return;
      }
    }
  }

  /**
   * Schedule a replacement worker with exponential backoff, capping the number of
   * consecutive restart attempts so a persistently broken worker entry can never
   * spin into an unbounded restart loop.
   */
  private scheduleRestart(): void {
    if (this.isShuttingDown || this.poolFailed) {
      return;
    }

    this.restartAttempts++;

    if (this.restartAttempts > this.maxRestartAttempts) {
      this.failPool();
      return;
    }

    const delay = Math.min(
      this.restartBackoffMs * 2 ** (this.restartAttempts - 1),
      MAX_RESTART_BACKOFF_MS
    );

    logger.warn(
      `Scheduling worker restart in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`,
      'WorkerRestart'
    );

    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      this.createWorker();
      // Hand any tasks that were waiting for a worker to the replacement
      this.processQueue();
    }, delay);

    // Don't keep the process alive purely for a pending restart
    timer.unref();
    this.restartTimers.add(timer);
  }

  /**
   * Give up after too many failed restarts: fail every outstanding task cleanly
   * (rejecting their promises) instead of looping forever.
   */
  private failPool(): void {
    if (this.poolFailed) {
      return;
    }
    this.poolFailed = true;

    logger.error(
      `Worker pool failed to recover after ${this.maxRestartAttempts} restart attempts`,
      'WorkerPoolFailed'
    );

    const error = new Error(
      `Worker pool is unavailable after ${this.maxRestartAttempts} failed restart attempts`
    );

    // Every queued task also has an activeTasks entry, so this rejects both
    // in-flight and queued work.
    for (const [taskId, taskInfo] of this.activeTasks.entries()) {
      if (taskInfo.timeout) {
        clearTimeout(taskInfo.timeout);
      }
      taskInfo.reject(error);
      this.activeTasks.delete(taskId);
    }

    this.taskQueue.length = 0;
  }

  /**
   * Handle a task that exceeded its timeout.
   *
   * A task that is still waiting in the queue is simply removed. One that is
   * already running cannot be interrupted, and rejecting the caller's promise
   * would leave its thread occupied, so the worker it was dispatched to is
   * terminated and replaced. Only the timed-out task is rejected.
   */
  private handleTaskTimeout(task: WorkerTask): void {
    const taskInfo = this.activeTasks.get(task.id);
    if (!taskInfo) {
      return;
    }

    this.activeTasks.delete(task.id);
    taskInfo.reject(new Error(`Task ${task.id} timed out`));

    const worker = taskInfo.assignedWorker;
    if (!worker) {
      // Never dispatched: drop it from the queue so it does not run later
      const queuedIndex = this.taskQueue.indexOf(task);
      if (queuedIndex !== -1) {
        this.taskQueue.splice(queuedIndex, 1);
      }
      return;
    }

    this.replaceWorker(worker, task.id);
  }

  /**
   * Terminate a worker that is stuck on a timed-out task and start a
   * replacement. This is deliberate, not a crash, so it does not consume the
   * crash-restart budget (a run of slow tasks must not fail the whole pool).
   */
  private replaceWorker(worker: Worker, timedOutTaskId: string): void {
    // Marks the worker as handled so its 'exit' event (terminate() exits with a
    // non-zero code) is not treated as a crash.
    if (this.handledFailures.has(worker)) {
      return;
    }
    this.handledFailures.add(worker);

    logger.warn(
      `Task ${timedOutTaskId} timed out; terminating worker ${worker.threadId} and starting a replacement`,
      'TaskTimeout'
    );
    this.removeWorker(worker);

    // Anything else dispatched to this worker goes back to the front of the
    // queue (normally nothing: a worker runs one task at a time). Timeouts
    // keep running from when a task was submitted.
    const requeued: WorkerTask[] = [];
    for (const taskInfo of this.activeTasks.values()) {
      if (taskInfo.assignedWorker === worker) {
        delete taskInfo.assignedWorker;
        requeued.push(taskInfo.task);
      }
    }
    if (requeued.length > 0) {
      this.taskQueue.unshift(...requeued);
    }

    void Promise.resolve()
      .then(() => worker.terminate())
      .catch(error => {
        logger.error('Failed to terminate timed-out worker', 'TaskTimeout', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    if (this.isShuttingDown || this.poolFailed) {
      return;
    }

    this.createWorker();
    this.processQueue();
  }

  /**
   * Execute a task on a worker thread
   */
  async executeTask<T = any>(task: WorkerTask): Promise<T> {
    if (this.isShuttingDown) {
      throw new Error('Worker manager is shutting down');
    }

    if (this.poolFailed) {
      throw new Error('Worker pool is unavailable (too many worker failures)');
    }

    return new Promise<T>((resolve, reject) => {
      // Tasks only wait here while every worker is busy; refuse to let that
      // backlog grow past maxQueueSize
      if (this.taskQueue.length >= this.maxQueueSize) {
        reject(new Error('Worker queue is full'));
        return;
      }

      this.enqueue(task);

      // Set up promise handlers
      const timeout = task.timeout
        ? setTimeout(() => {
            this.handleTaskTimeout(task);
          }, task.timeout)
        : null;

      // Don't keep process alive for worker timeouts
      if (timeout) {
        timeout.unref();
      }

      this.activeTasks.set(task.id, { task, resolve, reject, timeout });

      // Try to assign task to available worker
      this.processQueue();
    });
  }

  /**
   * Add a task to the queue: ahead of every waiting task of lower priority,
   * behind those of the same or higher priority (first in, first out).
   */
  private enqueue(task: WorkerTask): void {
    const rank = PRIORITY_ORDER[task.priority || 'normal'] ?? 0;
    let index = this.taskQueue.length;
    while (index > 0) {
      const ahead = this.taskQueue[index - 1] as WorkerTask;
      if ((PRIORITY_ORDER[ahead.priority || 'normal'] ?? 0) >= rank) break;
      index--;
    }
    this.taskQueue.splice(index, 0, task);
  }

  /**
   * Hand waiting tasks to idle workers, highest priority first. A worker runs
   * one task at a time, so concurrent work spreads over the pool and anything
   * beyond its capacity waits here, where priority, timeouts and maxQueueSize
   * apply to it.
   */
  private processQueue(): void {
    while (this.taskQueue.length > 0) {
      const worker = this.idleWorker();
      if (!worker) break;

      const task = this.taskQueue.shift() as WorkerTask;
      // Record the assignment so a crashed worker only rejects its own task.
      const taskInfo = this.activeTasks.get(task.id);
      if (taskInfo) {
        taskInfo.assignedWorker = worker;
      }
      this.inFlight.set(worker, (this.inFlight.get(worker) ?? 0) + 1);
      if (this.detached) worker.ref();
      worker.postMessage(task);
      logger.debug(`Assigned task ${task.id} to worker ${worker.threadId}`, 'TaskAssigned');
    }
  }

  /**
   * A live worker that is not running a task, if there is one.
   */
  private idleWorker(): Worker | undefined {
    for (const worker of this.workers.values()) {
      if ((this.inFlight.get(worker) ?? 0) === 0) {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * Handle result from worker thread
   */
  private handleWorkerResult(result: WorkerResult, sender?: Worker): void {
    // Whatever the task's fate on this side, the sending thread is done with it
    this.releaseWorkerSlot(sender);

    const taskInfo = this.activeTasks.get(result.taskId);
    if (!taskInfo) {
      logger.warn(`Received result for unknown task ${result.taskId}`, 'UnknownTaskResult');
      return;
    }

    // Clear timeout
    if (taskInfo.timeout) {
      clearTimeout(taskInfo.timeout);
    }

    // Remove from active tasks
    this.activeTasks.delete(result.taskId);

    // Handle result
    if (result.success) {
      logger.debug(`Task ${result.taskId} completed in ${result.executionTime}ms`, 'TaskCompleted');
      taskInfo.resolve(result.data);
    } else {
      logger.error(`Task ${result.taskId} failed: ${result.error}`, 'TaskFailed');
      taskInfo.reject(new Error(result.error || 'Task failed'));
    }

    // Process next task in queue
    this.processQueue();
  }

  /**
   * `worker` reported a result: free one of its slots. Workers that were
   * removed from the pool have no entry and are ignored.
   */
  private releaseWorkerSlot(worker: Worker | undefined): void {
    if (!worker) return;
    const load = this.inFlight.get(worker);
    if (load !== undefined && load > 0) {
      this.inFlight.set(worker, load - 1);
      if (this.detached && load === 1) worker.unref();
    }
  }

  /**
   * Shutdown all workers
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Cancel any pending worker restarts
    for (const timer of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    // Reject all pending tasks
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const [taskId, taskInfo] of this.activeTasks.entries()) {
      if (taskInfo.timeout) {
        clearTimeout(taskInfo.timeout);
      }
      taskInfo.reject(new Error('Worker manager shutting down'));
    }

    // Terminate all workers
    const shutdownPromises = Array.from(this.workers.values()).map(
      worker =>
        new Promise<void>(resolve => {
          worker.once('exit', () => resolve());
          void worker.terminate();
        })
    );

    await Promise.all(shutdownPromises);
    this.workers.clear();
    this.inFlight.clear();
    this.activeTasks.clear();
    this.taskQueue.length = 0;

    logger.info('Worker manager shutdown complete', 'WorkerShutdown');
  }

  /**
   * Get worker statistics
   */
  getStats() {
    // A worker is busy while at least one dispatched task has not settled
    let busyWorkers = 0;
    for (const load of this.inFlight.values()) {
      if (load > 0) busyWorkers++;
    }

    return {
      workerCount: this.workers.size,
      busyWorkers,
      idleWorkers: this.workers.size - busyWorkers,
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      isShuttingDown: this.isShuttingDown,
    };
  }
}

// Singleton instance
let workerManagerInstance: WorkerManager | null = null;

// Pool options the app was created with (createApp({ workers })). The pool is
// a singleton and whoever asks for it first creates it, so a bare
// getWorkerManager() or executeOnWorker() that runs before the app's own
// initialisation must still build the pool the app configured.
let configuredPoolOptions: WorkerPoolOptions | undefined;

/**
 * Record the pool options an app was configured with. Has no effect on a pool
 * that already exists.
 * @internal
 */
export function setConfiguredWorkerPoolOptions(options: WorkerPoolOptions | undefined): void {
  configuredPoolOptions = options;
}

/**
 * Get or create the worker manager instance.
 *
 * The pool is shut down with the last app that uses it. Whoever asks after
 * that gets a new one: an app created later takes it over like the first, and
 * until one does (a bare call from code that outlived its app) its threads
 * do not keep the process alive.
 */
export function getWorkerManager(options?: WorkerPoolOptions): WorkerManager {
  if (workerManagerInstance && workerManagerInstance.getStats().isShuttingDown) {
    workerManagerInstance = new WorkerManager(options ?? configuredPoolOptions);
    workerManagerInstance.detach();
  }
  if (!workerManagerInstance) {
    workerManagerInstance = new WorkerManager(options ?? configuredPoolOptions);
  }
  return workerManagerInstance;
}

/**
 * Execute task on worker thread (convenience function)
 */
export async function executeOnWorker<T = any>(task: WorkerTask): Promise<T> {
  const manager = getWorkerManager();
  return manager.executeTask<T>(task);
}

/**
 * Built-in task helpers
 */
export const workerTasks = {
  /**
   * JWT verification (CPU-intensive)
   */
  async verifyJWT(token: string, secret: string, options?: any): Promise<any> {
    if (!jwtAvailable) {
      throw new Error(
        'JWT verification requires the "jsonwebtoken" package. Please install it with: npm install jsonwebtoken @types/jsonwebtoken'
      );
    }
    return executeOnWorker({
      id: `jwt-verify-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.JWT_VERIFY,
      data: { token, secret, options },
      priority: 'high',
      timeout: 5000,
    });
  },

  /**
   * JWT signing (CPU-intensive)
   */
  async signJWT(payload: any, secret: string, options?: any): Promise<string> {
    if (!jwtAvailable) {
      throw new Error(
        'JWT signing requires the "jsonwebtoken" package. Please install it with: npm install jsonwebtoken @types/jsonwebtoken'
      );
    }
    return executeOnWorker({
      id: `jwt-sign-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.JWT_SIGN,
      data: { payload, secret, options },
      priority: 'high',
      timeout: 5000,
    });
  },

  /**
   * Crypto hash (CPU-intensive)
   */
  async hash(data: string, algorithm = 'sha256'): Promise<string> {
    return executeOnWorker({
      id: `crypto-hash-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.CRYPTO_HASH,
      data: { data, algorithm },
      priority: 'normal',
      timeout: 10000,
    });
  },

  /**
   * Data compression (CPU-intensive for large payloads)
   */
  async compress(
    data: string | Buffer | Uint8Array,
    options?: { format?: 'gzip' | 'deflate' | 'brotli' }
  ): Promise<Buffer> {
    const result = await executeOnWorker<Uint8Array>({
      id: `data-compress-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.DATA_COMPRESS,
      data: { input: data, format: options?.format ?? 'gzip' },
      priority: 'normal',
      timeout: 30000,
    });
    // Buffers cross the thread boundary as plain Uint8Array
    return Buffer.isBuffer(result) ? result : Buffer.from(result);
  },

  /**
   * Data decompression (CPU-intensive for large payloads)
   */
  async decompress(
    data: Buffer | Uint8Array,
    options?: {
      format?: 'gzip' | 'deflate' | 'brotli';
      /** Largest decompressed size accepted, in bytes (default: 256 MiB) */
      maxOutputLength?: number;
    }
  ): Promise<Buffer> {
    const result = await executeOnWorker<Uint8Array>({
      id: `data-decompress-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.DATA_DECOMPRESS,
      data: {
        input: data,
        format: options?.format ?? 'gzip',
        ...(options?.maxOutputLength !== undefined
          ? { maxOutputLength: options.maxOutputLength }
          : {}),
      },
      priority: 'normal',
      timeout: 30000,
    });
    return Buffer.isBuffer(result) ? result : Buffer.from(result);
  },

  /**
   * Heavy computation example
   */
  async heavyComputation(data: any): Promise<any> {
    return executeOnWorker({
      id: `computation-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.HEAVY_COMPUTATION,
      data,
      priority: 'normal',
      timeout: 30000,
    });
  },

  /**
   * JSON transformation (can be CPU-intensive for large objects).
   *
   * The transformer crosses to the worker as source text and runs inside an
   * isolated-vm isolate. Without the isolated-vm package the call is rejected
   * at once and nothing is run.
   */
  async transformJSON(data: any, transformer: (data: any) => any): Promise<any> {
    if (!isolatedVMAvailable) {
      throw new Error(TRANSFORM_JSON_NEEDS_ISOLATED_VM);
    }
    return executeOnWorker({
      id: `json-transform-${Date.now()}-${++taskIdCounter}`,
      type: WORKER_TASKS.JSON_TRANSFORM,
      data: { data, transformer: transformer.toString() },
      priority: 'normal',
      timeout: 15000,
    });
  },
};
