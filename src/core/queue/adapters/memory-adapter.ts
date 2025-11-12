/**
 * Memory Queue Adapter
 * Built-in adapter for development and testing (no external dependencies)
 */

import { QueueAdapter } from '../queue-adapter.js';
import type {
  Job,
  JobOptions,
  JobHandler,
  JobStatus,
  QueueMetrics,
  BulkJobData,
  JobContext,
} from '../types.js';
import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('MemoryQueue');

/**
 * In-memory job storage
 */
interface MemoryJob<T = any> extends Job<T> {
  handler?: JobHandler<T, any>;
  timeoutId?: NodeJS.Timeout;
}

/**
 * Queue state
 */
interface QueueState {
  jobs: Map<string, MemoryJob>;
  processors: Map<string, JobHandler<any, any>>;
  concurrency: number;
  isPaused: boolean;
  activeJobs: number;
}

/**
 * Memory-based queue adapter
 * Suitable for development, testing, and single-process applications
 */
export class MemoryAdapter extends QueueAdapter {
  public name = 'memory';
  private queues: Map<string, QueueState> = new Map();
  private processingIntervals: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Initialize the memory adapter
   */
  async initialize(): Promise<void> {
    this.isReady = true;
  }

  /**
   * Add a job to the queue
   */
  async addJob<T = any>(queueName: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    this.ensureReady();
    this.ensureQueue(queueName);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const queue = this.queues.get(queueName)!;
    const jobId = options.jobId || randomUUID();

    const job: MemoryJob<T> = {
      id: jobId,
      name: queueName,
      data,
      progress: 0,
      attemptsMade: 0,
      timestamp: Date.now(),
      opts: options,
    };

    // Handle delayed jobs
    if (options.delay && options.delay > 0) {
      job.timeoutId = setTimeout(() => {
        this.processJob(queueName, jobId);
      }, options.delay);
      // Don't keep process alive for delayed job timers
      job.timeoutId.unref();
    }

    queue.jobs.set(jobId, job);

    // Process immediately if not delayed
    if (!options.delay || options.delay === 0) {
      this.processJob(queueName, jobId);
    }

    return job;
  }

  /**
   * Add multiple jobs in bulk
   */
  async addBulkJobs<T = any>(queueName: string, jobs: BulkJobData<T>[]): Promise<Job<T>[]> {
    this.ensureReady();

    const addedJobs: Job<T>[] = [];
    for (const jobData of jobs) {
      const job = await this.addJob(queueName, jobData.data, jobData.options);
      addedJobs.push(job);
    }

    return addedJobs;
  }

  /**
   * Register a job processor
   */
  async process<T = any, R = any>(
    queueName: string,
    concurrency: number,
    handler: JobHandler<T, R>
  ): Promise<void> {
    this.ensureReady();
    this.ensureQueue(queueName);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const queue = this.queues.get(queueName)!;
    queue.processors.set(queueName, handler);
    queue.concurrency = concurrency;

    // Start processing loop
    this.startProcessingLoop(queueName);
  }

  /**
   * Get a job by ID
   */
  async getJob(queueName: string, jobId: string): Promise<Job | null> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (!queue) {
      return null;
    }

    return queue.jobs.get(jobId) || null;
  }

  /**
   * Get jobs by status
   */
  async getJobs(
    queueName: string,
    status?: JobStatus,
    start: number = 0,
    end: number = -1
  ): Promise<Job[]> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (!queue) {
      return [];
    }

    let jobs = Array.from(queue.jobs.values());

    // Filter by status if provided
    if (status) {
      jobs = jobs.filter(job => this.getJobStatus(job) === status);
    }

    // Apply pagination
    if (end === -1) {
      return jobs.slice(start);
    }
    return jobs.slice(start, end + 1);
  }

  /**
   * Remove a job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (!queue) {
      return;
    }

    const job = queue.jobs.get(jobId);
    if (job && job.timeoutId) {
      clearTimeout(job.timeoutId);
    }

    queue.jobs.delete(jobId);
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (!queue) {
      return;
    }

    const job = queue.jobs.get(jobId);
    if (!job) {
      return;
    }

    // Reset job state
    job.failedReason = undefined;
    job.stacktrace = undefined;
    job.processedOn = undefined;
    job.finishedOn = undefined;

    // Process the job again
    await this.processJob(queueName, jobId);
  }

  /**
   * Pause the queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (queue) {
      queue.isPaused = true;

      // Stop processing loop
      const interval = this.processingIntervals.get(queueName);
      if (interval) {
        clearInterval(interval);
        this.processingIntervals.delete(queueName);
      }
    }
  }

  /**
   * Resume the queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (queue) {
      queue.isPaused = false;
      this.startProcessingLoop(queueName);
    }
  }

  /**
   * Get queue metrics
   */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (!queue) {
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      };
    }

    const metrics: QueueMetrics = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: queue.isPaused ? queue.jobs.size : 0,
    };

    for (const job of queue.jobs.values()) {
      const status = this.getJobStatus(job);
      if (status in metrics) {
        metrics[status]++;
      }
    }

    return metrics;
  }

  /**
   * Clean old jobs
   */
  async clean(queueName: string, gracePeriod: number, status?: JobStatus): Promise<void> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (!queue) {
      return;
    }

    const cutoff = Date.now() - gracePeriod;
    const jobsToRemove: string[] = [];

    for (const [jobId, job] of queue.jobs.entries()) {
      const jobStatus = this.getJobStatus(job);
      const shouldClean = !status || jobStatus === status;

      if (shouldClean && job.finishedOn && job.finishedOn < cutoff) {
        jobsToRemove.push(jobId);
      }
    }

    for (const jobId of jobsToRemove) {
      await this.removeJob(queueName, jobId);
    }
  }

  /**
   * Obliterate a queue
   */
  async obliterate(queueName: string): Promise<void> {
    this.ensureReady();

    const queue = this.queues.get(queueName);
    if (queue) {
      // Clear all timeouts
      for (const job of queue.jobs.values()) {
        if (job.timeoutId) {
          clearTimeout(job.timeoutId);
        }
      }

      // Stop processing
      const interval = this.processingIntervals.get(queueName);
      if (interval) {
        clearInterval(interval);
        this.processingIntervals.delete(queueName);
      }

      this.queues.delete(queueName);
    }
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    // Stop all processing loops
    for (const interval of this.processingIntervals.values()) {
      clearInterval(interval);
    }
    this.processingIntervals.clear();

    // Clear all timeouts
    for (const queue of this.queues.values()) {
      for (const job of queue.jobs.values()) {
        if (job.timeoutId) {
          clearTimeout(job.timeoutId);
        }
      }
    }

    this.queues.clear();
    this.isReady = false;
  }

  /**
   * Ensure a queue exists
   */
  private ensureQueue(queueName: string): void {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, {
        jobs: new Map(),
        processors: new Map(),
        concurrency: 1,
        isPaused: false,
        activeJobs: 0,
      });
    }
  }

  /**
   * Get job status
   */
  private getJobStatus(job: MemoryJob): JobStatus {
    if (job.failedReason) {
      return 'failed';
    }
    if (job.finishedOn) {
      return 'completed';
    }
    if (job.processedOn) {
      return 'active';
    }
    if (job.opts.delay && job.opts.delay > 0 && !job.processedOn) {
      return 'delayed';
    }
    return 'waiting';
  }

  /**
   * Process a single job
   */
  private async processJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue || queue.isPaused) {
      return;
    }

    const job = queue.jobs.get(jobId);
    if (!job) {
      return;
    }

    const handler = queue.processors.get(queueName);
    if (!handler) {
      return;
    }

    // Check concurrency
    if (queue.activeJobs >= queue.concurrency) {
      return;
    }

    queue.activeJobs++;
    job.processedOn = Date.now();

    try {
      // Create job context
      const jobContext: JobContext = {
        ...job,
        updateProgress: async (progress: number) => {
          job.progress = progress;
        },
        log: (message: string) => {
          logger.debug(`[Job ${job.id}] ${message}`);
        },
      };

      // Execute handler
      const result = await handler(jobContext);

      // Mark as completed
      job.finishedOn = Date.now();
      job.returnvalue = result;

      // Auto-remove if configured
      if (job.opts.removeOnComplete) {
        setTimeout(
          () => {
            this.removeJob(queueName, jobId);
          },
          typeof job.opts.removeOnComplete === 'number' ? job.opts.removeOnComplete : 0
        );
      }
    } catch (error) {
      // Mark as failed
      job.failedReason = error instanceof Error ? error.message : String(error);
      job.stacktrace = error instanceof Error ? error.stack?.split('\n') : [];
      job.finishedOn = Date.now();
      job.attemptsMade++;

      // Retry if configured
      const maxAttempts = job.opts.attempts || 1;
      if (job.attemptsMade < maxAttempts) {
        // Calculate backoff delay
        let delay = 0;
        if (job.opts.backoff) {
          const baseDelay = job.opts.backoff.delay;
          if (job.opts.backoff.type === 'exponential') {
            delay = baseDelay * Math.pow(2, job.attemptsMade - 1);
          } else if (job.opts.backoff.type === 'linear') {
            delay = baseDelay * job.attemptsMade;
          } else {
            delay = baseDelay;
          }
        }

        // Schedule retry
        setTimeout(() => {
          job.failedReason = undefined;
          job.stacktrace = undefined;
          job.processedOn = undefined;
          job.finishedOn = undefined;
          this.processJob(queueName, jobId);
        }, delay);
      } else {
        // Auto-remove if configured
        if (job.opts.removeOnFail) {
          setTimeout(
            () => {
              this.removeJob(queueName, jobId);
            },
            typeof job.opts.removeOnFail === 'number' ? job.opts.removeOnFail : 0
          );
        }
      }
    } finally {
      queue.activeJobs--;
    }
  }

  /**
   * Start processing loop for a queue
   */
  private startProcessingLoop(queueName: string): void {
    // Don't start if already running
    if (this.processingIntervals.has(queueName)) {
      return;
    }

    const interval = setInterval(() => {
      const queue = this.queues.get(queueName);
      if (!queue || queue.isPaused) {
        return;
      }

      // Process waiting jobs
      for (const [jobId, job] of queue.jobs.entries()) {
        const status = this.getJobStatus(job);
        if (status === 'waiting' && !job.opts.delay) {
          this.processJob(queueName, jobId);
        }
      }
    }, 100); // Check every 100ms

    // Don't keep process alive for processing intervals
    interval.unref();

    this.processingIntervals.set(queueName, interval);
  }
}
