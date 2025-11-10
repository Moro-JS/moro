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
  heavyComputation(data: any): Promise<any>;
  transformJSON(data: any, transformer: (data: any) => any): Promise<any>;
}

/**
 * Worker Threads Facade - Provides clean access to optional worker functionality
 */
export class WorkerThreadsFacade {
  private workerManager: WorkerAPI | null = null;
  private workerTasks: WorkerHelpers | null = null;
  private executeOnWorker: ((task: WorkerTask) => Promise<any>) | null = null;
  private initialized = false;

  /**
   * Lazy initialize worker threads
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      const workers = await import('./index.js');
      this.workerManager = workers.getWorkerManager();
      this.workerTasks = workers.workerTasks;
      this.executeOnWorker = workers.executeOnWorker;
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
   * Get worker thread statistics
   */
  async getStats(): Promise<WorkerStats | null> {
    await this.ensureInitialized();
    return this.workerManager?.getStats() || null;
  }

  /**
   * Shutdown worker threads
   */
  async shutdown(): Promise<void> {
    await this.ensureInitialized();
    await this.workerManager?.shutdown();
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
