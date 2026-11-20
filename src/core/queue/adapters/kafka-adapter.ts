/**
 * Kafka Queue Adapter
 * Adapter for Apache Kafka event streaming
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
  QueueRetentionOptions,
} from '../types.js';
import { JobRetention } from './retention.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';
import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../../logger/index.js';
import { decodeJobMessage } from './job-message.js';

const logger = createFrameworkLogger('KafkaQueue');

/**
 * Type definitions for KafkaJS (loaded dynamically)
 */
type KafkaInstance = any;
type Producer = any;
type Consumer = any;

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
  processedOn?: number | undefined;
  finishedOn?: number | undefined;
  failedReason?: string | undefined;
  progress: number;
}

/**
 * Kafka adapter for high-throughput event streaming
 * Suitable for event-driven architectures and microservices
 */
export class KafkaAdapter extends QueueAdapter {
  public name = 'kafka';

  private Kafka: any = null;
  private kafka: KafkaInstance | null = null;
  private producer: Producer | null = null;
  private consumers: Map<string, Consumer> = new Map();
  private connectionConfig: QueueConnectionConfig;
  private processors: Map<string, JobHandler<any, any>> = new Map();
  private jobStore: Map<string, Map<string, StoredJob>> = new Map();

  private retention: JobRetention;

  constructor(connectionConfig: QueueConnectionConfig = {}, retention?: QueueRetentionOptions) {
    super();
    this.connectionConfig = connectionConfig;
    this.retention = new JobRetention(retention);
  }

  /** Count a stored record among the jobs of this queue that have not finished. */
  private trackJob(queueName: string, jobId: string): void {
    const store = this.jobStore.get(queueName);
    if (store) this.retention.track(queueName, jobId, store);
  }

  /** A job finished for good: keep its record among the most recent ones. */
  private retainFinished(
    queueName: string,
    jobId: string,
    outcome: 'completed' | 'failed',
    ownSetting: unknown
  ): void {
    const store = this.jobStore.get(queueName);
    if (store) this.retention.finished(queueName, jobId, outcome, ownSetting, store);
  }

  /**
   * Initialize the Kafka adapter
   */
  async initialize(): Promise<void> {
    if (this.isReady) {
      return;
    }

    if (!isPackageAvailable('kafkajs')) {
      throw new Error('kafkajs is not installed. Install it with: npm install kafkajs');
    }

    try {
      // Load KafkaJS
      const kafkaPath = resolveUserPackage('kafkajs');
      const kafkaModule = await import(kafkaPath);
      this.Kafka = kafkaModule.Kafka;

      // Create Kafka instance. `ssl` and `sasl` are kafkajs's own options and
      // are passed on only when set, so a connection configured without them
      // is opened exactly as before.
      const { clientId, ssl, sasl } = this.connectionConfig;
      this.kafka = new this.Kafka({
        clientId: clientId || 'morojs-queue',
        brokers: this.connectionConfig.brokers || ['localhost:9092'],
        ...(ssl !== undefined && { ssl }),
        ...(sasl !== undefined && { sasl }),
      });

      // Create producer
      this.producer = this.kafka.producer();
      await this.producer.connect();

      this.isReady = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize Kafka adapter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Ensure job store exists
   */
  private ensureJobStore(queueName: string): void {
    if (!this.jobStore.has(queueName)) {
      this.jobStore.set(queueName, new Map());
    }
  }

  /**
   * Add a job to the queue
   */
  async addJob<T = any>(queueName: string, data: T, options: JobOptions = {}): Promise<Job<T>> {
    this.ensureReady();
    this.ensureJobStore(queueName);

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
    this.trackJob(queueName, jobId);

    // Prepare message
    const message = {
      jobId,
      data,
      options,
      timestamp: job.timestamp,
    };

    // Send to Kafka topic
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.producer!.send({
      topic: queueName,
      messages: [
        {
          key: jobId,
          value: JSON.stringify(message),
          headers: {
            jobId,
            priority: String(options.priority || 0),
          },
        },
      ],
    });

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
    this.ensureJobStore(queueName);

    const addedJobs: Job<T>[] = [];
    const messages = [];

    for (const jobData of jobs) {
      const jobId = jobData.options?.jobId || randomUUID();

      const job: StoredJob = {
        id: jobId,
        name: queueName,
        data: jobData.data,
        options: jobData.options || {},
        attemptsMade: 0,
        timestamp: Date.now(),
        progress: 0,
      };

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.jobStore.get(queueName)!.set(jobId, job);
      this.trackJob(queueName, jobId);

      const message = {
        jobId,
        data: jobData.data,
        options: jobData.options || {},
        timestamp: job.timestamp,
      };

      messages.push({
        key: jobId,
        value: JSON.stringify(message),
        headers: {
          jobId,
          priority: String(jobData.options?.priority || 0),
        },
      });

      addedJobs.push({
        id: job.id,
        name: job.name,
        data: job.data,
        progress: job.progress,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
        opts: job.options,
      });
    }

    // Send batch
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.producer!.send({
      topic: queueName,
      messages,
    });

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
    this.ensureJobStore(queueName);

    this.processors.set(queueName, handler);

    // Create consumer
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const consumer = this.kafka!.consumer({
      groupId: this.connectionConfig.groupId || `morojs-${queueName}`,
    });

    await consumer.connect();
    await consumer.subscribe({ topic: queueName, fromBeginning: false });

    // Start consuming
    await consumer.run({
      partitionsConsumedConcurrently: concurrency,
      eachMessage: async ({ message }: any) => {
        // Never reject: a rejected eachMessage makes the consumer re-fetch the
        // same offset, so one bad message would be redelivered forever.
        try {
          await this.handleMessage(queueName, message, handler);
        } catch (error) {
          logger.error(
            `Unexpected error handling a message on topic ${queueName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      },
    });

    this.consumers.set(queueName, consumer);
  }

  /**
   * Handle one consumed message: decode it, run the handler, and settle the
   * job (completed, re-sent for another attempt, or failed).
   */
  private async handleMessage<T>(
    queueName: string,
    message: any,
    handler: JobHandler<T, any>
  ): Promise<void> {
    // Decode once. A tombstone (null value), a non-JSON payload or a payload
    // that is not a job object cannot be processed: log it and return, which
    // lets the offset advance.
    const decoded = decodeJobMessage(message?.value, message?.key?.toString());
    if (!decoded) {
      logger.error(
        `Skipping malformed message on topic ${queueName} (offset ${String(message?.offset)}): not a JSON job message`
      );
      return;
    }

    const { jobId, data, options } = decoded;

    // The message is the source of truth for the job. A job produced by
    // another process, or before this consumer restarted, is not in the
    // in-memory store: rebuild the record from the message instead of
    // dropping it unprocessed.
    this.ensureJobStore(queueName);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const store = this.jobStore.get(queueName)!;
    let storedJob = store.get(jobId);
    if (!storedJob) {
      storedJob = {
        id: jobId,
        name: queueName,
        data,
        options,
        attemptsMade: decoded.attemptsMade,
        timestamp: decoded.timestamp,
        progress: 0,
      };
      store.set(jobId, storedJob);
      this.trackJob(queueName, jobId);
    } else if (decoded.attemptsMade > storedJob.attemptsMade) {
      // The attempt count travels with the message (see sendRetry)
      storedJob.attemptsMade = decoded.attemptsMade;
    }
    const job = storedJob;

    try {
      job.processedOn = Date.now();

      // Create job context
      const jobContext: JobContext<T> = {
        id: jobId,
        name: queueName,
        data,
        progress: job.progress,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
        opts: options,
        updateProgress: async (progress: number) => {
          job.progress = progress;
        },
        log: (message: string) => {
          logger.debug(`[Job ${jobId}] ${message}`);
        },
      };

      // Execute handler
      await handler(jobContext);

      // Mark as completed
      job.finishedOn = Date.now();
      job.progress = 100;

      // Auto-remove if configured
      if (options.removeOnComplete) {
        setTimeout(
          () => {
            this.jobStore.get(queueName)?.delete(jobId);
          },
          typeof options.removeOnComplete === 'number' ? options.removeOnComplete : 0
        );
      }
      this.retainFinished(queueName, jobId, 'completed', options.removeOnComplete);
    } catch (error) {
      job.attemptsMade++;
      job.failedReason = error instanceof Error ? error.message : String(error);
      job.finishedOn = Date.now();

      // Kafka doesn't have built-in retry, so we re-send if needed
      const maxAttempts = options.attempts || 1;
      if (job.attemptsMade < maxAttempts) {
        // Reset and re-send
        job.failedReason = undefined;
        job.processedOn = undefined;
        job.finishedOn = undefined;

        // Calculate backoff delay
        let delay = 0;
        if (options.backoff) {
          const baseDelay = options.backoff.delay;
          if (options.backoff.type === 'exponential') {
            delay = baseDelay * Math.pow(2, job.attemptsMade - 1);
          } else if (options.backoff.type === 'linear') {
            delay = baseDelay * job.attemptsMade;
          } else {
            delay = baseDelay;
          }
        }

        // Re-send the same job with its attempt count. Going through addJob()
        // would start a fresh job at attempt 0 and never reach maxAttempts.
        const attemptsMade = job.attemptsMade;
        setTimeout(() => {
          void this.sendRetry(queueName, job, attemptsMade);
        }, delay);
      } else {
        // Auto-remove if configured
        if (options.removeOnFail) {
          setTimeout(
            () => {
              this.jobStore.get(queueName)?.delete(jobId);
            },
            typeof options.removeOnFail === 'number' ? options.removeOnFail : 0
          );
        }
        this.retainFinished(queueName, jobId, 'failed', options.removeOnFail);
      }
    }
  }

  /**
   * Re-send a failed job for another attempt, carrying the number of attempts
   * already made so the limit holds across re-sends and across processes.
   */
  private async sendRetry(queueName: string, job: StoredJob, attemptsMade: number): Promise<void> {
    try {
      if (!this.producer) {
        throw new Error('producer is closed');
      }

      await this.producer.send({
        topic: queueName,
        messages: [
          {
            key: job.id,
            value: JSON.stringify({
              jobId: job.id,
              data: job.data,
              options: job.options,
              timestamp: job.timestamp,
              attemptsMade,
            }),
            headers: {
              jobId: job.id,
              priority: String(job.options.priority || 0),
            },
          },
        ],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      job.failedReason = `Retry could not be sent: ${reason}`;
      job.finishedOn = Date.now();
      logger.error(`Failed to re-send job ${job.id} on topic ${queueName}: ${reason}`);
    }
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
    this.retention.forget(queueName, jobId);
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
    this.trackJob(queueName, jobId);

    // Re-add to queue
    await this.addJob(queueName, storedJob.data, storedJob.options);
  }

  /**
   * Pause the queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    this.ensureReady();

    const consumer = this.consumers.get(queueName);
    if (consumer) {
      await consumer.pause([{ topic: queueName }]);
    }
  }

  /**
   * Resume the queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    this.ensureReady();

    const consumer = this.consumers.get(queueName);
    if (consumer) {
      await consumer.resume([{ topic: queueName }]);
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
      this.retention.forget(queueName, jobId);
    }
  }

  /**
   * Obliterate a queue
   */
  async obliterate(queueName: string): Promise<void> {
    this.ensureReady();

    // Disconnect consumer
    const consumer = this.consumers.get(queueName);
    if (consumer) {
      await consumer.disconnect();
      this.consumers.delete(queueName);
    }

    // Note: We don't delete the Kafka topic itself
    // To delete the topic, use Kafka admin tools

    this.jobStore.delete(queueName);
    this.retention.clear(queueName);
    this.processors.delete(queueName);
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    // Disconnect all consumers
    for (const consumer of this.consumers.values()) {
      await consumer.disconnect();
    }
    this.consumers.clear();

    // Disconnect producer
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }

    this.jobStore.clear();
    this.retention.clear();
    this.processors.clear();
    this.kafka = null;
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
