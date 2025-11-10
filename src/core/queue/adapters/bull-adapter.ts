/**
 * Bull Queue Adapter
 * Adapter for BullMQ (Redis-based queue system)
 * Uses lazy loading for optional dependencies
 */

import { QueueAdapter } from '../queue-adapter.js';
import type {
  Job,
  JobOptions,
  JobHandler,
  JobStatus,
  QueueMetrics,
  BulkJobData,
  QueueConnectionConfig,
  JobContext,
} from '../types.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';

/**
 * Type definitions for BullMQ (loaded dynamically)
 */
type BullMQQueue = any;
type BullMQWorker = any;
type BullMQJob = any;
type IORedisType = any;

/**
 * Bull adapter for Redis-based queues
 * Recommended adapter for most production use cases
 */
export class BullAdapter extends QueueAdapter {
  public name = 'bull';

  private Queue: any = null;
  private Worker: any = null;
  private IORedis: any = null;
  private connection: IORedisType | null = null;
  private queues: Map<string, BullMQQueue> = new Map();
  private workers: Map<string, BullMQWorker> = new Map();
  private connectionConfig: QueueConnectionConfig;

  constructor(connectionConfig: QueueConnectionConfig = {}) {
    super();
    this.connectionConfig = connectionConfig;
  }

  /**
   * Initialize the Bull adapter by loading BullMQ and IORedis
   */
  async initialize(): Promise<void> {
    if (this.isReady) {
      return;
    }

    // Check if BullMQ is available
    if (!isPackageAvailable('bullmq')) {
      throw new Error('BullMQ is not installed. Install it with: npm install bullmq ioredis');
    }

    if (!isPackageAvailable('ioredis')) {
      throw new Error('IORedis is not installed. Install it with: npm install ioredis');
    }

    try {
      // Load BullMQ
      const bullPath = resolveUserPackage('bullmq');
      const bullModule = await import(bullPath);
      this.Queue = bullModule.Queue;
      this.Worker = bullModule.Worker;

      // Load IORedis
      const redisPath = resolveUserPackage('ioredis');
      const redisModule = await import(redisPath);
      this.IORedis = redisModule.default || redisModule;

      // Create Redis connection
      this.connection = new this.IORedis({
        host: this.connectionConfig.host || 'localhost',
        port: this.connectionConfig.port || 6379,
        password: this.connectionConfig.password,
        db: this.connectionConfig.database || 0,
        maxRetriesPerRequest: null,
      });

      this.isReady = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize Bull adapter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get or create a queue instance
   */
  private getQueue(queueName: string): BullMQQueue {
    if (!this.queues.has(queueName)) {
      const queue = new this.Queue(queueName, {
        connection: this.connection,
      });
      this.queues.set(queueName, queue);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.queues.get(queueName)!;
  }

  /**
   * Add a job to the queue
   */
  async addJob<T = any>(queueName: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    const bullOptions: any = {
      priority: options.priority,
      delay: options.delay,
      attempts: options.attempts,
      backoff: options.backoff
        ? {
            type: options.backoff.type,
            delay: options.backoff.delay,
          }
        : undefined,
      removeOnComplete: options.removeOnComplete,
      removeOnFail: options.removeOnFail,
      jobId: options.jobId,
    };

    // Handle repeat options
    if (options.repeat) {
      bullOptions.repeat = {
        pattern: options.repeat.cron,
        every: options.repeat.every,
        limit: options.repeat.limit,
        endDate: options.repeat.endDate,
      };
    }

    const bullJob = await queue.add(queueName, data, bullOptions);

    return this.convertBullJob(bullJob);
  }

  /**
   * Add multiple jobs in bulk
   */
  async addBulkJobs<T = any>(queueName: string, jobs: BulkJobData<T>[]): Promise<Job<T>[]> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    const bullJobs = jobs.map(job => ({
      name: queueName,
      data: job.data,
      opts: job.options
        ? {
            priority: job.options.priority,
            delay: job.options.delay,
            attempts: job.options.attempts,
            backoff: job.options.backoff,
            removeOnComplete: job.options.removeOnComplete,
            removeOnFail: job.options.removeOnFail,
            jobId: job.options.jobId,
          }
        : undefined,
    }));

    const addedJobs = await queue.addBulk(bullJobs);

    return addedJobs.map((job: BullMQJob) => this.convertBullJob(job));
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

    const worker = new this.Worker(
      queueName,
      async (bullJob: BullMQJob) => {
        const jobContext: JobContext<T> = {
          id: bullJob.id,
          name: bullJob.name,
          data: bullJob.data,
          progress: bullJob.progress || 0,
          attemptsMade: bullJob.attemptsMade || 0,
          timestamp: bullJob.timestamp,
          processedOn: bullJob.processedOn,
          finishedOn: bullJob.finishedOn,
          failedReason: bullJob.failedReason,
          stacktrace: bullJob.stacktrace,
          returnvalue: bullJob.returnvalue,
          opts: bullJob.opts || {},
          updateProgress: async (progress: number) => {
            await bullJob.updateProgress(progress);
          },
          log: (message: string) => {
            bullJob.log(message);
          },
        };

        return await handler(jobContext);
      },
      {
        connection: this.connection,
        concurrency,
      }
    );

    this.workers.set(queueName, worker);
  }

  /**
   * Get a job by ID
   */
  async getJob(queueName: string, jobId: string): Promise<Job | null> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    const bullJob = await queue.getJob(jobId);
    if (!bullJob) {
      return null;
    }

    return this.convertBullJob(bullJob);
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
    const queue = this.getQueue(queueName);

    let bullJobs: BullMQJob[];

    if (status) {
      const statusMap: Record<JobStatus, string> = {
        waiting: 'wait',
        active: 'active',
        completed: 'completed',
        failed: 'failed',
        delayed: 'delayed',
        paused: 'paused',
      };
      bullJobs = await queue.getJobs(statusMap[status], start, end);
    } else {
      bullJobs = await queue.getJobs(
        ['wait', 'active', 'completed', 'failed', 'delayed'],
        start,
        end
      );
    }

    return bullJobs.map((job: BullMQJob) => this.convertBullJob(job));
  }

  /**
   * Remove a job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
    }
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    const job = await queue.getJob(jobId);
    if (job) {
      await job.retry();
    }
  }

  /**
   * Pause the queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    this.ensureReady();
    const queue = this.getQueue(queueName);
    await queue.pause();
  }

  /**
   * Resume the queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    this.ensureReady();
    const queue = this.getQueue(queueName);
    await queue.resume();
  }

  /**
   * Get queue metrics
   */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    const counts = await queue.getJobCounts();

    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      paused: counts.paused || 0,
    };
  }

  /**
   * Clean old jobs
   */
  async clean(queueName: string, gracePeriod: number, status?: JobStatus): Promise<void> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    if (status) {
      const statusMap: Record<JobStatus, string> = {
        waiting: 'wait',
        active: 'active',
        completed: 'completed',
        failed: 'failed',
        delayed: 'delayed',
        paused: 'paused',
      };
      await queue.clean(gracePeriod, 100, statusMap[status]);
    } else {
      await queue.clean(gracePeriod, 100);
    }
  }

  /**
   * Obliterate a queue
   */
  async obliterate(queueName: string): Promise<void> {
    this.ensureReady();
    const queue = this.getQueue(queueName);

    await queue.obliterate({ force: true });
    this.queues.delete(queueName);

    const worker = this.workers.get(queueName);
    if (worker) {
      await worker.close();
      this.workers.delete(queueName);
    }
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    // Close all workers
    for (const worker of this.workers.values()) {
      await worker.close();
    }
    this.workers.clear();

    // Close all queues
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();

    // Close Redis connection
    if (this.connection) {
      await this.connection.quit();
      this.connection = null;
    }

    this.isReady = false;
  }

  /**
   * Convert BullMQ job to our Job interface
   */
  private convertBullJob(bullJob: BullMQJob): Job {
    return {
      id: bullJob.id,
      name: bullJob.name,
      data: bullJob.data,
      progress: bullJob.progress || 0,
      attemptsMade: bullJob.attemptsMade || 0,
      timestamp: bullJob.timestamp,
      processedOn: bullJob.processedOn,
      finishedOn: bullJob.finishedOn,
      failedReason: bullJob.failedReason,
      stacktrace: bullJob.stacktrace,
      returnvalue: bullJob.returnvalue,
      opts: bullJob.opts || {},
    };
  }
}
