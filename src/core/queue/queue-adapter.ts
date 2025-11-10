/**
 * Base Queue Adapter Interface
 * Defines the contract that all queue adapters must implement
 */

import type {
  IQueueAdapter,
  Job,
  JobOptions,
  JobHandler,
  JobStatus,
  QueueMetrics,
  BulkJobData,
} from './types.js';

/**
 * Abstract base class for queue adapters
 * Provides common functionality and enforces interface implementation
 */
export abstract class QueueAdapter implements IQueueAdapter {
  public abstract name: string;
  public isReady: boolean = false;

  /**
   * Initialize the queue adapter
   */
  abstract initialize(): Promise<void>;

  /**
   * Add a single job to the queue
   */
  abstract addJob<T = any>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>>;

  /**
   * Add multiple jobs to the queue in bulk
   */
  abstract addBulkJobs<T = any>(queueName: string, jobs: BulkJobData<T>[]): Promise<Job<T>[]>;

  /**
   * Register a processor for the queue
   */
  abstract process<T = any, R = any>(
    queueName: string,
    concurrency: number,
    handler: JobHandler<T, R>
  ): Promise<void>;

  /**
   * Get a specific job by ID
   */
  abstract getJob(queueName: string, jobId: string): Promise<Job | null>;

  /**
   * Get jobs by status
   */
  abstract getJobs(
    queueName: string,
    status?: JobStatus,
    start?: number,
    end?: number
  ): Promise<Job[]>;

  /**
   * Remove a job from the queue
   */
  abstract removeJob(queueName: string, jobId: string): Promise<void>;

  /**
   * Retry a failed job
   */
  abstract retryJob(queueName: string, jobId: string): Promise<void>;

  /**
   * Pause the queue
   */
  abstract pauseQueue(queueName: string): Promise<void>;

  /**
   * Resume the queue
   */
  abstract resumeQueue(queueName: string): Promise<void>;

  /**
   * Get queue metrics
   */
  abstract getMetrics(queueName: string): Promise<QueueMetrics>;

  /**
   * Clean old jobs from the queue
   */
  abstract clean(queueName: string, gracePeriod: number, status?: JobStatus): Promise<void>;

  /**
   * Completely remove a queue and all its data
   */
  abstract obliterate(queueName: string): Promise<void>;

  /**
   * Close the adapter and cleanup resources
   */
  abstract close(): Promise<void>;

  /**
   * Helper to ensure the adapter is initialized
   */
  protected ensureReady(): void {
    if (!this.isReady) {
      throw new Error(`Queue adapter ${this.name} is not initialized`);
    }
  }
}
