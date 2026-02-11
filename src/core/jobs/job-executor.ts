// Production-grade Job Executor
// Handles job execution with retry logic, timeout, circuit breaker, and memory monitoring

import { EventEmitter } from 'events';
import { Logger } from '../../types/logger.js';
import { CircuitBreaker } from '../utilities/circuit-breaker.js';

// Type definitions for native Node.js AbortController (available in Node.js 15+)
type AbortSignal = {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
};

type AbortController = {
  readonly signal: AbortSignal;
  abort(): void;
};

// Access global AbortController through globalThis
declare global {
  interface GlobalThis {
    AbortController: new () => AbortController;
  }
}

// Reference to global AbortController
const AbortControllerClass = globalThis.AbortController;

export interface JobExecutorOptions {
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: 'linear' | 'exponential';
  retryBackoffMultiplier?: number;
  maxRetryDelay?: number;
  timeout?: number;
  enableCircuitBreaker?: boolean;
  circuitBreakerThreshold?: number;
  circuitBreakerResetTimeout?: number;
  enableMemoryMonitoring?: boolean;
  memoryThreshold?: number; // MB
}

export interface JobFunction {
  (...args: any[]): Promise<any> | any;
}

export interface ExecutionContext {
  jobId: string;
  executionId: string;
  attempt: number;
  startTime: Date;
  metadata?: Record<string, any>;
}

export interface ExecutionResult {
  success: boolean;
  value?: any;
  error?: Error;
  attempts: number;
  duration: number;
  memoryUsed?: number;
  circuitBreakerTripped?: boolean;
  timedOut?: boolean;
}

/**
 * JobExecutor - Executes jobs with production-grade resilience
 * Features:
 * - Configurable retry with exponential backoff + jitter
 * - Timeout enforcement
 * - Circuit breaker integration
 * - Memory leak detection
 * - Graceful cancellation
 */
export class JobExecutor extends EventEmitter {
  private options: Required<JobExecutorOptions>;
  private logger: Logger;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private activeExecutions = new Map<string, AbortController>();
  private isShuttingDown = false;

  constructor(logger: Logger, options: JobExecutorOptions = {}) {
    super();
    this.logger = logger;

    // Set defaults
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      retryDelay: options.retryDelay ?? 1000,
      retryBackoff: options.retryBackoff ?? 'exponential',
      retryBackoffMultiplier: options.retryBackoffMultiplier ?? 2,
      maxRetryDelay: options.maxRetryDelay ?? 60000,
      timeout: options.timeout ?? 300000, // 5 minutes default
      enableCircuitBreaker: options.enableCircuitBreaker ?? true,
      circuitBreakerThreshold: options.circuitBreakerThreshold ?? 5,
      circuitBreakerResetTimeout: options.circuitBreakerResetTimeout ?? 60000,
      enableMemoryMonitoring: options.enableMemoryMonitoring ?? true,
      memoryThreshold: options.memoryThreshold ?? 512, // 512MB default
    };

    this.logger.debug('JobExecutor initialized', 'JobExecutor', { options: this.options });
  }

  /**
   * Execute a job with full resilience features
   *
   * @param jobId - Unique job identifier
   * @param executionId - Unique execution identifier
   * @param jobFn - The job function to execute
   * @param context - Execution context
   * @param optionOverrides - Per-execution option overrides (merged on top of constructor defaults)
   */
  public async execute(
    jobId: string,
    executionId: string,
    jobFn: JobFunction,
    context?: ExecutionContext,
    optionOverrides?: Partial<JobExecutorOptions>
  ): Promise<ExecutionResult> {
    if (this.isShuttingDown) {
      throw new Error('JobExecutor is shutting down');
    }

    // Merge per-execution overrides with constructor defaults
    const opts = optionOverrides ? { ...this.options, ...optionOverrides } : this.options;

    const ctx: ExecutionContext = context || {
      jobId,
      executionId,
      attempt: 1,
      startTime: new Date(),
    };

    const startTime = Date.now();
    const abortController = new AbortControllerClass();
    this.activeExecutions.set(executionId, abortController);

    let lastError: Error | undefined;
    let attempts = 0;
    let circuitBreakerTripped = false;
    let timedOut = false;

    try {
      // Check memory before execution
      if (opts.enableMemoryMonitoring) {
        await this.checkMemoryUsage(jobId);
      }

      // Execute with retries
      while (attempts <= opts.maxRetries) {
        attempts++;
        ctx.attempt = attempts;

        try {
          // Check circuit breaker
          if (opts.enableCircuitBreaker) {
            const breaker = this.getCircuitBreaker(jobId);

            if (breaker.isOpen()) {
              circuitBreakerTripped = true;
              throw new Error(`Circuit breaker open for job ${jobId}`);
            }
          }

          // Execute with timeout
          const result = await this.executeWithTimeout(
            jobFn,
            ctx,
            abortController.signal,
            opts.timeout
          );

          // Success - record in circuit breaker
          if (opts.enableCircuitBreaker) {
            const breaker = this.getCircuitBreaker(jobId);
            breaker.recordSuccess();
          }

          const duration = Date.now() - startTime;
          const memoryUsed = this.getMemoryUsage();

          this.logger.debug(`Job executed successfully: ${jobId}`, 'JobExecutor', {
            executionId,
            attempts,
            duration,
            memoryUsed,
          });

          this.emit('execution:success', {
            jobId,
            executionId,
            attempts,
            duration,
            memoryUsed,
          });

          return {
            success: true,
            value: result,
            attempts,
            duration,
            memoryUsed,
            circuitBreakerTripped: false,
            timedOut: false,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          // Check if it's a timeout
          if (lastError.name === 'TimeoutError' || lastError.message.includes('timeout')) {
            timedOut = true;
          }

          // Record failure in circuit breaker
          if (opts.enableCircuitBreaker && !circuitBreakerTripped) {
            const breaker = this.getCircuitBreaker(jobId);
            breaker.recordFailure();
          }

          this.logger.warn(
            `Job execution failed: ${jobId} (attempt ${attempts}/${opts.maxRetries + 1})`,
            'JobExecutor',
            {
              executionId,
              error: lastError.message,
              timedOut,
              circuitBreakerTripped,
            }
          );

          this.emit('execution:retry', {
            jobId,
            executionId,
            attempt: attempts,
            maxAttempts: opts.maxRetries + 1,
            error: lastError,
            timedOut,
          });

          // Don't retry if circuit breaker tripped or shutting down
          if (circuitBreakerTripped || this.isShuttingDown) {
            break;
          }

          // Calculate retry delay with backoff and jitter
          if (attempts <= opts.maxRetries) {
            const delay = this.calculateRetryDelay(attempts, opts);
            await this.sleep(delay);
          }
        }
      }

      // All retries exhausted
      const duration = Date.now() - startTime;

      this.logger.error(
        `Job execution failed after ${attempts} attempts: ${jobId}`,
        'JobExecutor',
        {
          executionId,
          error: lastError?.message,
          timedOut,
          circuitBreakerTripped,
        }
      );

      this.emit('execution:failed', {
        jobId,
        executionId,
        attempts,
        duration,
        error: lastError,
        timedOut,
        circuitBreakerTripped,
      });

      return {
        success: false,
        error: lastError,
        attempts,
        duration,
        circuitBreakerTripped,
        timedOut,
      };
    } finally {
      this.activeExecutions.delete(executionId);

      // Force GC if memory threshold exceeded
      if (opts.enableMemoryMonitoring) {
        const memUsage = process.memoryUsage();
        const heapUsedMB = memUsage.heapUsed / 1024 / 1024;

        if (heapUsedMB > opts.memoryThreshold * 0.9 && globalThis.gc) {
          this.logger.warn('High memory usage detected, triggering GC', 'JobExecutor', {
            heapUsedMB: Math.round(heapUsedMB),
            threshold: opts.memoryThreshold,
          });
          globalThis.gc();
        }
      }
    }
  }

  /**
   * Execute job function with timeout
   */
  private async executeWithTimeout(
    jobFn: JobFunction,
    context: ExecutionContext,
    signal: AbortSignal,
    timeout?: number
  ): Promise<any> {
    const effectiveTimeout = timeout ?? this.options.timeout;
    return new Promise((resolve, reject) => {
      // Setup timeout
      const timeoutId = setTimeout(() => {
        const error = new Error(`Job execution timeout after ${effectiveTimeout}ms`);
        error.name = 'TimeoutError';
        reject(error);
      }, effectiveTimeout);

      // Don't keep process alive for job execution timeout
      timeoutId.unref();

      // Setup abort handler
      const abortHandler = () => {
        clearTimeout(timeoutId);
        reject(new Error('Job execution cancelled'));
      };

      if (signal.aborted) {
        clearTimeout(timeoutId);
        reject(new Error('Job execution cancelled'));
        return;
      }

      signal.addEventListener('abort', abortHandler, { once: true });

      // Execute job
      Promise.resolve()
        .then(() => jobFn(context))
        .then(result => {
          clearTimeout(timeoutId);
          signal.removeEventListener('abort', abortHandler);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          signal.removeEventListener('abort', abortHandler);
          reject(error);
        });
    });
  }

  /**
   * Calculate retry delay with backoff and jitter
   */
  private calculateRetryDelay(
    attempt: number,
    opts?: Pick<
      Required<JobExecutorOptions>,
      'retryBackoff' | 'retryDelay' | 'retryBackoffMultiplier' | 'maxRetryDelay'
    >
  ): number {
    const effectiveOpts = opts ?? this.options;
    let delay: number;

    if (effectiveOpts.retryBackoff === 'exponential') {
      delay =
        effectiveOpts.retryDelay * Math.pow(effectiveOpts.retryBackoffMultiplier, attempt - 1);
    } else {
      delay = effectiveOpts.retryDelay * attempt;
    }

    // Cap at max delay
    delay = Math.min(delay, effectiveOpts.maxRetryDelay);

    // Add jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    delay = Math.max(0, delay + jitter);

    return Math.floor(delay);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref(); // Don't keep process alive
    });
  }

  /**
   * Get or create circuit breaker for job
   */
  private getCircuitBreaker(jobId: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(jobId);

    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: this.options.circuitBreakerThreshold,
        resetTimeout: this.options.circuitBreakerResetTimeout,
      });

      // Log circuit breaker state changes
      breaker.on('open', () => {
        this.logger.error(`Circuit breaker opened for job: ${jobId}`);
        this.emit('circuit-breaker:open', { jobId });
      });

      breaker.on('halfOpen', () => {
        this.logger.info(`Circuit breaker half-open for job: ${jobId}`);
        this.emit('circuit-breaker:half-open', { jobId });
      });

      breaker.on('closed', () => {
        this.logger.info(`Circuit breaker closed for job: ${jobId}`);
        this.emit('circuit-breaker:closed', { jobId });
      });

      this.circuitBreakers.set(jobId, breaker);
    }

    return breaker;
  }

  /**
   * Check memory usage before execution
   */
  private async checkMemoryUsage(jobId: string): Promise<void> {
    const memUsage = process.memoryUsage();
    const heapUsedMB = memUsage.heapUsed / 1024 / 1024;

    if (heapUsedMB > this.options.memoryThreshold) {
      const error = `Memory threshold exceeded: ${Math.round(heapUsedMB)}MB / ${this.options.memoryThreshold}MB`;
      this.logger.error(error, 'JobExecutor', { jobId });

      this.emit('memory:threshold-exceeded', {
        jobId,
        heapUsedMB,
        threshold: this.options.memoryThreshold,
      });

      // Try to force GC if available
      if (globalThis.gc) {
        this.logger.warn('Forcing garbage collection', 'JobExecutor', { jobId });
        globalThis.gc();

        // Check again after GC
        const newMemUsage = process.memoryUsage();
        const newHeapUsedMB = newMemUsage.heapUsed / 1024 / 1024;

        if (newHeapUsedMB > this.options.memoryThreshold) {
          throw new Error(error);
        }

        this.logger.info('Memory recovered after GC', 'JobExecutor', {
          before: Math.round(heapUsedMB),
          after: Math.round(newHeapUsedMB),
        });
      } else {
        throw new Error(error);
      }
    }
  }

  /**
   * Get current memory usage in MB
   */
  private getMemoryUsage(): number {
    const memUsage = process.memoryUsage();
    return Math.round(memUsage.heapUsed / 1024 / 1024);
  }

  /**
   * Cancel a running execution
   */
  public cancelExecution(executionId: string): boolean {
    const controller = this.activeExecutions.get(executionId);
    if (!controller) {
      return false;
    }

    controller.abort();
    this.logger.info(`Execution cancelled: ${executionId}`);
    this.emit('execution:cancelled', { executionId });

    return true;
  }

  /**
   * Cancel all running executions
   */
  public cancelAllExecutions(): void {
    const executionIds = Array.from(this.activeExecutions.keys());

    this.logger.info(`Cancelling ${executionIds.length} running executions`);

    for (const executionId of executionIds) {
      this.cancelExecution(executionId);
    }
  }

  /**
   * Get active execution count
   */
  public getActiveExecutionCount(): number {
    return this.activeExecutions.size;
  }

  /**
   * Get circuit breaker status for job
   */
  public getCircuitBreakerStatus(jobId: string): {
    exists: boolean;
    state?: string;
    failures?: number;
    threshold?: number;
  } {
    const breaker = this.circuitBreakers.get(jobId);

    if (!breaker) {
      return { exists: false };
    }

    return {
      exists: true,
      state: breaker.getState().toLowerCase(),
      failures: breaker.getFailures(),
      threshold: this.options.circuitBreakerThreshold,
    };
  }

  /**
   * Reset circuit breaker for job
   */
  public resetCircuitBreaker(jobId: string): boolean {
    const breaker = this.circuitBreakers.get(jobId);
    if (!breaker) {
      return false;
    }

    breaker.reset();
    this.logger.info(`Circuit breaker reset for job: ${jobId}`);
    return true;
  }

  /**
   * Update executor options at runtime
   */
  public updateOptions(options: Partial<JobExecutorOptions>): void {
    Object.assign(this.options, options);
    this.logger.info('JobExecutor options updated', 'JobExecutor', { options });
  }

  /**
   * Get current options
   */
  public getOptions(): Required<JobExecutorOptions> {
    return { ...this.options };
  }

  /**
   * Shutdown and cleanup
   */
  public async shutdown(gracePeriod: number = 30000): Promise<void> {
    this.logger.info('JobExecutor shutting down...', 'JobExecutor', {
      activeExecutions: this.activeExecutions.size,
      gracePeriod,
    });

    this.isShuttingDown = true;

    // Wait for active executions to complete or grace period to expire
    const startTime = Date.now();

    while (this.activeExecutions.size > 0 && Date.now() - startTime < gracePeriod) {
      this.logger.debug(`Waiting for ${this.activeExecutions.size} active executions to complete`);
      await this.sleep(1000);
    }

    // Force cancel remaining executions
    if (this.activeExecutions.size > 0) {
      this.logger.warn(`Force cancelling ${this.activeExecutions.size} remaining executions`);
      this.cancelAllExecutions();
    }

    // Cleanup circuit breakers
    this.circuitBreakers.clear();

    this.removeAllListeners();
    this.logger.info('JobExecutor shutdown complete');
  }
}
