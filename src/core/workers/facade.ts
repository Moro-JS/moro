// Worker Threads Facade - Clean API for optional worker thread functionality
// Provides a clean interface that gracefully degrades when workers aren't available

export interface WorkerTask {
  id: string;
  type: string;
  data: any;
  priority?: 'low' | 'normal' | 'high';
  timeout?: number;
}

export interface WorkerStats {
  workerCount: number;
  /** Workers with at least one dispatched task that has not settled */
  busyWorkers: number;
  /** Workers with no dispatched task */
  idleWorkers: number;
  activeTasks: number;
  queuedTasks: number;
  isShuttingDown: boolean;
}

export interface WorkerAPI {
  executeTask<T = any>(task: WorkerTask): Promise<T>;
  getStats(): WorkerStats;
  shutdown(): Promise<void>;
}

export interface WorkerHelpers {
  verifyJWT(token: string, secret: string, options?: any): Promise<any>;
  signJWT(payload: any, secret: string, options?: any): Promise<string>;
  hash(data: string, algorithm?: string): Promise<string>;
  compress(
    data: string | Buffer | Uint8Array,
    options?: { format?: 'gzip' | 'deflate' | 'brotli' }
  ): Promise<Buffer>;
  decompress(
    data: Buffer | Uint8Array,
    options?: { format?: 'gzip' | 'deflate' | 'brotli'; maxOutputLength?: number }
  ): Promise<Buffer>;
  heavyComputation(data: any): Promise<any>;
  transformJSON(data: any, transformer: (data: any) => any): Promise<any>;
}

export interface WorkerPoolOptions {
  workerCount?: number;
  maxQueueSize?: number;
  /** V8 limits for each worker thread, passed to `new Worker()` as given */
  resourceLimits?: import('worker_threads').ResourceLimits;
}

// The pool is one per process and every app's facade uses the same one. How
// many of them have it in use, per pool: it is shut down when the last of
// those apps is closed, not when the first is. An app that asks for it after
// that gets a new pool (getWorkerManager), counted here from one again.
const poolUsers = new WeakMap<WorkerAPI, number>();

/**
 * Worker Threads Facade - Provides clean access to optional worker functionality
 */
export class WorkerThreadsFacade {
  private workerManager: WorkerAPI | null = null;
  private workerTasks: WorkerHelpers | null = null;
  private executeOnWorker: ((task: WorkerTask) => Promise<any>) | null = null;
  private initialized = false;
  // shutdown() has run: this facade no longer counts as a user of the pool
  private released = false;
  // The initialisation under way, shared by every call that arrives before
  // it has finished. An app sets its pool up in the background and may be
  // used, or closed, straight away: that must count as one user of the pool,
  // which close() then releases.
  private initializing: Promise<void> | null = null;

  /**
   * Lazy initialize worker threads.
   * Pool options only take effect on the first initialization (the underlying
   * manager is a singleton).
   */
  async ensureInitialized(options?: WorkerPoolOptions): Promise<void> {
    if (this.initialized) return;
    if (this.initializing === null) this.initializing = this.initialize(options);
    await this.initializing;
  }

  private async initialize(options?: WorkerPoolOptions): Promise<void> {
    try {
      const workers = await import('./index.js');
      const manager: WorkerAPI = workers.getWorkerManager(options);
      this.workerManager = manager;
      this.workerTasks = workers.workerTasks;
      this.executeOnWorker = workers.executeOnWorker;
      if (!this.released) {
        poolUsers.set(manager, (poolUsers.get(manager) ?? 0) + 1);
        // A pool started after the previous one was shut down belongs to
        // nobody until an app takes it: from here on it is this app's too.
        (manager as { retain?: () => void }).retain?.();
      }
    } catch {
      // Workers not available - graceful degradation
      this.workerManager = null;
      this.workerTasks = null;
      this.executeOnWorker = null;
    }

    this.initialized = true;
  }

  /**
   * Execute a task on worker threads
   */
  async executeTask<T = any>(task: WorkerTask): Promise<T> {
    await this.ensureInitialized();

    if (!this.workerManager) {
      throw new Error('Worker threads are not available in this environment');
    }

    return this.workerManager.executeTask<T>(task);
  }

  /**
   * Get worker thread statistics.
   * Returns null when workers were never initialized — observing stats
   * must not spawn a pool.
   */
  async getStats(): Promise<WorkerStats | null> {
    if (!this.initialized) return null;
    return this.workerManager?.getStats() || null;
  }

  /**
   * Shutdown worker threads.
   * A no-op when workers were never initialized — never spin up a pool
   * just to tear it down. The pool is shared by every app in the process, so
   * it keeps running while another app that uses it is still open, and is
   * shut down with the last of them.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      if (this.initializing === null) return;
      // Closed while the pool was still being set up: it is released below
      await this.initializing;
    }
    const manager = this.workerManager;
    if (!manager) return;
    if (!this.released) {
      this.released = true;
      const others = (poolUsers.get(manager) ?? 1) - 1;
      poolUsers.set(manager, others);
      if (others > 0) return;
    }
    await manager.shutdown();
  }

  /**
   * JWT operations using worker threads
   */
  async getJwtWorker(): Promise<{
    verify: WorkerHelpers['verifyJWT'];
    sign: WorkerHelpers['signJWT'];
  } | null> {
    await this.ensureInitialized();

    if (!this.workerTasks) return null;

    return {
      verify: this.workerTasks.verifyJWT.bind(this.workerTasks),
      sign: this.workerTasks.signJWT.bind(this.workerTasks),
    };
  }

  /**
   * Crypto operations using worker threads
   */
  async getCryptoWorker(): Promise<{ hash: WorkerHelpers['hash'] } | null> {
    await this.ensureInitialized();

    if (!this.workerTasks) return null;

    return {
      hash: this.workerTasks.hash.bind(this.workerTasks),
    };
  }

  /**
   * Heavy computation operations using worker threads
   */
  async getComputeWorker(): Promise<{
    heavy: WorkerHelpers['heavyComputation'];
    transformJSON: WorkerHelpers['transformJSON'];
  } | null> {
    await this.ensureInitialized();

    if (!this.workerTasks) return null;

    return {
      heavy: this.workerTasks.heavyComputation.bind(this.workerTasks),
      transformJSON: this.workerTasks.transformJSON.bind(this.workerTasks),
    };
  }

  /**
   * Check if worker threads are available
   */
  async isAvailable(): Promise<boolean> {
    await this.ensureInitialized();
    return this.workerManager !== null;
  }
}
