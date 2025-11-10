// Worker Thread Manager - Offload CPU-intensive operations
import { Worker } from 'worker_threads';
import { createFrameworkLogger } from '../logger/index.js';
import { cpus } from 'os';
import { join } from 'path';
import { isPackageAvailable } from '../utilities/package-utils.js';

// Optional JWT import
const jwtAvailable = isPackageAvailable('jsonwebtoken');

const logger = createFrameworkLogger('WorkerManager');

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
  resolve: CallableFunction;
  reject: CallableFunction;
  timeout: NodeJS.Timeout | null;
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
  private workerCount: number;
  private maxQueueSize: number;
  private isShuttingDown = false;

  constructor(
    options: {
      workerCount?: number;
      maxQueueSize?: number;
    } = {}
  ) {
    this.workerCount = options.workerCount || Math.max(1, cpus().length - 1); // Leave 1 core for main thread
    this.maxQueueSize = options.maxQueueSize || 1000;

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
    const workerPath = join(process.cwd(), 'src/core/workers/worker.ts');

    const worker = new Worker(workerPath, {
      workerData: { type: 'worker' },
    });

    worker.on('message', (result: WorkerResult) => {
      this.handleWorkerResult(result);
    });

    worker.on('error', error => {
      logger.error('Worker thread error', 'WorkerError', { error: error.message });
      this.restartWorker(worker);
    });

    worker.on('exit', code => {
      if (code !== 0 && !this.isShuttingDown) {
        logger.warn(`Worker exited with code ${code}, restarting`, 'WorkerExit');
        this.restartWorker(worker);
      }
    });

    this.workers.set(worker.threadId, worker);
    logger.debug(`Created worker thread ${worker.threadId}`, 'WorkerCreate');
  }

  /**
   * Restart a failed worker
   */
  private restartWorker(oldWorker: Worker): void {
    const threadId = oldWorker.threadId;
    this.workers.delete(threadId);

    // Clean up any pending tasks for this worker
    for (const [taskId, taskInfo] of this.activeTasks.entries()) {
      if (taskInfo.timeout) {
        clearTimeout(taskInfo.timeout);
      }
      taskInfo.reject(new Error('Worker thread failed'));
      this.activeTasks.delete(taskId);
    }

    // Create new worker
    this.createWorker();
  }

  /**
   * Execute a task on a worker thread
   */
  async executeTask<T = any>(task: WorkerTask): Promise<T> {
    if (this.isShuttingDown) {
      throw new Error('Worker manager is shutting down');
    }

    return new Promise<T>((resolve, reject) => {
      // Check queue size limit
      if (this.taskQueue.length >= this.maxQueueSize) {
        reject(new Error('Worker queue is full'));
        return;
      }

      // Add to queue
      this.taskQueue.push(task);

      // Set up promise handlers
      const timeout = task.timeout
        ? setTimeout(() => {
            this.activeTasks.delete(task.id);
            reject(new Error(`Task ${task.id} timed out`));
          }, task.timeout)
        : null;

      // Don't keep process alive for worker timeouts
      if (timeout) {
        timeout.unref();
      }

      this.activeTasks.set(task.id, { resolve, reject, timeout });

      // Try to assign task to available worker
      this.processQueue();
    });
  }

  /**
   * Process the task queue
   */
  private processQueue(): void {
    // Sort queue by priority (high first)
    this.taskQueue.sort((a, b) => {
      const priorityOrder = { high: 3, normal: 2, low: 1 };
      return priorityOrder[b.priority || 'normal'] - priorityOrder[a.priority || 'normal'];
    });

    // Assign tasks to available workers
    for (const [threadId, worker] of this.workers.entries()) {
      if (this.taskQueue.length === 0) break;

      // Check if worker is available (not currently processing)
      // For simplicity, we'll send tasks and let workers handle queuing
      const task = this.taskQueue.shift();
      if (task) {
        worker.postMessage(task);
        logger.debug(`Assigned task ${task.id} to worker ${threadId}`, 'TaskAssigned');
      }
    }
  }

  /**
   * Handle result from worker thread
   */
  private handleWorkerResult(result: WorkerResult): void {
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
   * Shutdown all workers
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

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
          worker.terminate();
        })
    );

    await Promise.all(shutdownPromises);
    this.workers.clear();
    this.activeTasks.clear();
    this.taskQueue.length = 0;

    logger.info('Worker manager shutdown complete', 'WorkerShutdown');
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      workerCount: this.workers.size,
      activeTasks: this.activeTasks.size,
      queuedTasks: this.taskQueue.length,
      isShuttingDown: this.isShuttingDown,
    };
  }
}

// Singleton instance
let workerManagerInstance: WorkerManager | null = null;

/**
 * Get or create the worker manager instance
 */
export function getWorkerManager(options?: {
  workerCount?: number;
  maxQueueSize?: number;
}): WorkerManager {
  if (!workerManagerInstance) {
    workerManagerInstance = new WorkerManager(options);
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
      id: `jwt-verify-${Date.now()}-${Math.random()}`,
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
      id: `jwt-sign-${Date.now()}-${Math.random()}`,
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
      id: `crypto-hash-${Date.now()}-${Math.random()}`,
      type: WORKER_TASKS.CRYPTO_HASH,
      data: { data, algorithm },
      priority: 'normal',
      timeout: 10000,
    });
  },

  /**
   * Heavy computation example
   */
  async heavyComputation(data: any): Promise<any> {
    return executeOnWorker({
      id: `computation-${Date.now()}-${Math.random()}`,
      type: WORKER_TASKS.HEAVY_COMPUTATION,
      data,
      priority: 'normal',
      timeout: 30000,
    });
  },

  /**
   * JSON transformation (can be CPU-intensive for large objects)
   */
  async transformJSON(data: any, transformer: (data: any) => any): Promise<any> {
    return executeOnWorker({
      id: `json-transform-${Date.now()}-${Math.random()}`,
      type: WORKER_TASKS.JSON_TRANSFORM,
      data: { data, transformer: transformer.toString() },
      priority: 'normal',
      timeout: 15000,
    });
  },
};
