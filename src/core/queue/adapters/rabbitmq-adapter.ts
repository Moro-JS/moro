/**
 * RabbitMQ Queue Adapter
 * Adapter for RabbitMQ/AMQP message broker
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
import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('RabbitMQQueue');

/**
 * Type definitions for amqplib (loaded dynamically)
 */
type AMQPConnection = any;
type AMQPChannel = any;

/**
 * Stored job data
 */
interface StoredJob {
  id: string;
  name: string;
  data: any;
  options: JobOptions;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  progress: number;
}

/**
 * RabbitMQ adapter for AMQP-based queues
 * Suitable for complex routing and pub/sub patterns
 */
export class RabbitMQAdapter extends QueueAdapter {
  public name = 'rabbitmq';

  private amqp: any = null;
  private connection: AMQPConnection | null = null;
  private channel: AMQPChannel | null = null;
  private connectionConfig: QueueConnectionConfig;
  private processors: Map<string, JobHandler<any, any>> = new Map();
  private jobStore: Map<string, Map<string, StoredJob>> = new Map();
  private consumerTags: Map<string, string> = new Map();

  constructor(connectionConfig: QueueConnectionConfig = {}) {
    super();
    this.connectionConfig = connectionConfig;
  }

  /**
   * Initialize the RabbitMQ adapter
   */
  async initialize(): Promise<void> {
    if (this.isReady) {
      return;
    }

    if (!isPackageAvailable('amqplib')) {
      throw new Error('amqplib is not installed. Install it with: npm install amqplib');
    }

    try {
      // Load amqplib
      const amqpPath = resolveUserPackage('amqplib');
      this.amqp = await import(amqpPath);

      // Build connection URL
      const host = this.connectionConfig.host || 'localhost';
      const port = this.connectionConfig.port || 5672;
      const username = this.connectionConfig.username || 'guest';
      const password = this.connectionConfig.password || 'guest';
      const url = `amqp://${username}:${password}@${host}:${port}`;

      // Create connection and channel
      this.connection = await this.amqp.connect(url);
      this.channel = await this.connection.createChannel();

      this.isReady = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize RabbitMQ adapter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Ensure queue exists in RabbitMQ
   */
  private async ensureQueueExists(queueName: string): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not initialized');
    }

    await this.channel.assertQueue(queueName, {
      durable: true,
      arguments: {},
    });

    if (!this.jobStore.has(queueName)) {
      this.jobStore.set(queueName, new Map());
    }
  }

  /**
   * Add a job to the queue
   */
  async addJob<T = any>(queueName: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    this.ensureReady();
    await this.ensureQueueExists(queueName);

    const jobId = options.jobId || randomUUID();
    const job: StoredJob = {
      id: jobId,
      name: queueName,
      data,
      options,
      attemptsMade: 0,
      timestamp: Date.now(),
      progress: 0,
    };

    // Store job metadata
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this.jobStore.get(queueName)!.set(jobId, job);

    // Prepare message
    const message = {
      jobId,
      data,
      options,
      timestamp: job.timestamp,
    };

    const messageBuffer = Buffer.from(JSON.stringify(message));

    // Send to RabbitMQ with options
    const sendOptions: any = {
      persistent: true,
      priority: options.priority || 0,
      messageId: jobId,
    };

    if (options.delay && options.delay > 0) {
      // Use dead letter exchange for delayed messages
      const delayQueue = `${queueName}.delay`;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await this.channel!.assertQueue(delayQueue, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queueName,
          'x-message-ttl': options.delay,
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.channel!.sendToQueue(delayQueue, messageBuffer, sendOptions);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.channel!.sendToQueue(queueName, messageBuffer, sendOptions);
    }

    return {
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      opts: job.options,
    };
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
    await this.ensureQueueExists(queueName);

    this.processors.set(queueName, handler);

    // Set prefetch count (concurrency)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.channel!.prefetch(concurrency);

    // Start consuming messages
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const consumer = await this.channel!.consume(
      queueName,
      async (msg: any) => {
        if (!msg) {
          return;
        }

        try {
          const message = JSON.parse(msg.content.toString());
          const { jobId, data, options } = message;

          const storedJob = this.jobStore.get(queueName)?.get(jobId);
          if (!storedJob) {
            // Job not found, acknowledge and skip
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.channel!.ack(msg);
            return;
          }

          storedJob.processedOn = Date.now();

          // Create job context
          const jobContext: JobContext<T> = {
            id: jobId,
            name: queueName,
            data,
            progress: storedJob.progress,
            attemptsMade: storedJob.attemptsMade,
            timestamp: storedJob.timestamp,
            processedOn: storedJob.processedOn,
            finishedOn: storedJob.finishedOn,
            failedReason: storedJob.failedReason,
            opts: options,
            updateProgress: async (progress: number) => {
              storedJob.progress = progress;
            },
            log: (message: string) => {
              logger.debug(`[Job ${jobId}] ${message}`);
            },
          };

          // Execute handler
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const result = await handler(jobContext);

          // Mark as completed
          storedJob.finishedOn = Date.now();
          storedJob.progress = 100;

          // Acknowledge message
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.channel!.ack(msg);

          // Auto-remove if configured
          if (options.removeOnComplete) {
            setTimeout(
              () => {
                this.jobStore.get(queueName)?.delete(jobId);
              },
              typeof options.removeOnComplete === 'number' ? options.removeOnComplete : 0
            );
          }
        } catch (error) {
          const message = JSON.parse(msg.content.toString());
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { jobId, data, options } = message;

          const storedJob = this.jobStore.get(queueName)?.get(jobId);
          if (storedJob) {
            storedJob.attemptsMade++;
            storedJob.failedReason = error instanceof Error ? error.message : String(error);
            storedJob.finishedOn = Date.now();

            // Check if we should retry
            const maxAttempts = options.attempts || 1;
            if (storedJob.attemptsMade < maxAttempts) {
              // Reject and requeue
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              this.channel!.nack(msg, false, true);
            } else {
              // Max attempts reached, move to DLQ or acknowledge
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              this.channel!.ack(msg);

              // Auto-remove if configured
              if (options.removeOnFail) {
                setTimeout(
                  () => {
                    this.jobStore.get(queueName)?.delete(jobId);
                  },
                  typeof options.removeOnFail === 'number' ? options.removeOnFail : 0
                );
              }
            }
          } else {
            // Job not found, acknowledge
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.channel!.ack(msg);
          }
        }
      },
      { noAck: false }
    );

    this.consumerTags.set(queueName, consumer.consumerTag);
  }

  /**
   * Get a job by ID
   */
  async getJob(queueName: string, jobId: string): Promise<Job | null> {
    this.ensureReady();

    const storedJob = this.jobStore.get(queueName)?.get(jobId);
    if (!storedJob) {
      return null;
    }

    return {
      id: storedJob.id,
      name: storedJob.name,
      data: storedJob.data,
      progress: storedJob.progress,
      attemptsMade: storedJob.attemptsMade,
      timestamp: storedJob.timestamp,
      processedOn: storedJob.processedOn,
      finishedOn: storedJob.finishedOn,
      failedReason: storedJob.failedReason,
      opts: storedJob.options,
    };
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

    const jobs = Array.from(this.jobStore.get(queueName)?.values() || []);

    // Filter by status if provided
    const filteredJobs = status ? jobs.filter(job => this.getJobStatus(job) === status) : jobs;

    // Apply pagination
    const endIndex = end === -1 ? filteredJobs.length : end + 1;
    return filteredJobs.slice(start, endIndex).map(job => ({
      id: job.id,
      name: job.name,
      data: job.data,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      opts: job.options,
    }));
  }

  /**
   * Remove a job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    this.ensureReady();
    this.jobStore.get(queueName)?.delete(jobId);
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    this.ensureReady();

    const storedJob = this.jobStore.get(queueName)?.get(jobId);
    if (!storedJob) {
      return;
    }

    // Reset job state
    storedJob.failedReason = undefined;
    storedJob.processedOn = undefined;
    storedJob.finishedOn = undefined;
    storedJob.progress = 0;

    // Re-add to queue
    await this.addJob(queueName, storedJob.data, storedJob.options);
  }

  /**
   * Pause the queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    this.ensureReady();

    const consumerTag = this.consumerTags.get(queueName);
    if (consumerTag && this.channel) {
      await this.channel.cancel(consumerTag);
      this.consumerTags.delete(queueName);
    }
  }

  /**
   * Resume the queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    this.ensureReady();

    // Restart consuming
    const handler = this.processors.get(queueName);
    if (handler) {
      await this.process(queueName, 1, handler);
    }
  }

  /**
   * Get queue metrics
   */
  async getMetrics(queueName: string): Promise<QueueMetrics> {
    this.ensureReady();

    const jobs = Array.from(this.jobStore.get(queueName)?.values() || []);

    const metrics: QueueMetrics = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };

    for (const job of jobs) {
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

    const jobs = this.jobStore.get(queueName);
    if (!jobs) {
      return;
    }

    const cutoff = Date.now() - gracePeriod;
    const jobsToRemove: string[] = [];

    for (const [jobId, job] of jobs.entries()) {
      const jobStatus = this.getJobStatus(job);
      const shouldClean = !status || jobStatus === status;

      if (shouldClean && job.finishedOn && job.finishedOn < cutoff) {
        jobsToRemove.push(jobId);
      }
    }

    for (const jobId of jobsToRemove) {
      jobs.delete(jobId);
    }
  }

  /**
   * Obliterate a queue
   */
  async obliterate(queueName: string): Promise<void> {
    this.ensureReady();

    // Cancel consumer
    await this.pauseQueue(queueName);

    // Delete queue from RabbitMQ
    if (this.channel) {
      await this.channel.deleteQueue(queueName);
    }

    // Clear job store
    this.jobStore.delete(queueName);
    this.processors.delete(queueName);
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    // Cancel all consumers
    for (const queueName of this.consumerTags.keys()) {
      await this.pauseQueue(queueName);
    }

    // Close channel
    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }

    // Close connection
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }

    this.jobStore.clear();
    this.processors.clear();
    this.isReady = false;
  }

  /**
   * Get job status
   */
  private getJobStatus(job: StoredJob): JobStatus {
    if (job.failedReason) {
      return 'failed';
    }
    if (job.finishedOn) {
      return 'completed';
    }
    if (job.processedOn) {
      return 'active';
    }
    if (job.options.delay && job.options.delay > 0) {
      return 'delayed';
    }
    return 'waiting';
  }
}
