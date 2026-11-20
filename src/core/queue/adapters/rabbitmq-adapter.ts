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
  QueueRetentionOptions,
} from '../types.js';
import { JobRetention } from './retention.js';
import { isPackageAvailable, resolveUserPackage } from '../../utilities/package-utils.js';
import { randomUUID } from 'crypto';
import { createFrameworkLogger } from '../../logger/index.js';
import { decodeJobMessage } from './job-message.js';

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
  processedOn?: number | undefined;
  finishedOn?: number | undefined;
  failedReason?: string | undefined;
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
  // Concurrency (prefetch) per queue, retained so consumers can be replayed on reconnect
  private queueConcurrency: Map<string, number> = new Map();
  private isClosing = false;
  private reconnecting = false;

  // Reconnect backoff bounds
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;
  private static readonly RECONNECT_MAX_DELAY_MS = 30000;

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

      // Create connection and channel (with error/close handlers attached)
      await this.establishConnection();

      this.isReady = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize RabbitMQ adapter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Build the AMQP connection URL from config. The username and password are
   * percent-encoded: a credential containing `@`, `:`, `/`, `#`, `?` or `%`
   * would otherwise end the userinfo early or be read as another part of the
   * URL. amqplib decodes them back before authenticating.
   */
  private buildConnectionUrl(): string {
    const { amqps, tls, vhost } = this.connectionConfig;
    // TLS when asked for by name, or when TLS options were given
    const secure = amqps === true || (tls !== undefined && tls !== false && tls !== null);
    const host = this.connectionConfig.host || 'localhost';
    const port = this.connectionConfig.port || (secure ? 5671 : 5672);
    const username = encodeURIComponent(this.connectionConfig.username || 'guest');
    const password = encodeURIComponent(this.connectionConfig.password || 'guest');
    // The virtual host is one path segment: a name containing "/" (the
    // default vhost is "/") has to be percent-encoded to stay one
    const path = typeof vhost === 'string' ? `/${encodeURIComponent(vhost)}` : '';
    return `${secure ? 'amqps' : 'amqp'}://${username}:${password}@${host}:${port}${path}`;
  }

  /**
   * Open a fresh connection + channel and register lifecycle handlers on both.
   */
  private async establishConnection(): Promise<void> {
    const url = this.buildConnectionUrl();

    // TLS options go to amqplib as its socket options (it hands them to
    // tls.connect); a connection configured without them is opened as before
    const { tls } = this.connectionConfig;
    this.connection =
      tls !== null && typeof tls === 'object'
        ? await this.amqp.connect(url, tls)
        : await this.amqp.connect(url);
    this.registerConnectionHandlers(this.connection);

    this.channel = await this.connection.createChannel();
    this.registerChannelHandlers(this.channel);
  }

  /**
   * Attach 'error'/'close' handlers to the connection. amqplib Connection is an
   * EventEmitter, so an unhandled 'error' would otherwise crash the process.
   */
  private registerConnectionHandlers(connection: AMQPConnection): void {
    connection.on('error', (err: Error) => {
      logger.error('RabbitMQ connection error', 'Connection', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.handleConnectionFailure();
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed', 'Connection');
      this.handleConnectionFailure();
    });
  }

  /**
   * Attach 'error'/'close' handlers to the channel. amqplib Channel is an
   * EventEmitter; an unhandled 'error' would otherwise crash the process.
   */
  private registerChannelHandlers(channel: AMQPChannel): void {
    channel.on('error', (err: Error) => {
      logger.error('RabbitMQ channel error', 'Channel', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.handleConnectionFailure();
    });

    channel.on('close', () => {
      logger.warn('RabbitMQ channel closed', 'Channel');
      this.handleConnectionFailure();
    });
  }

  /**
   * React to a connection/channel error or close by marking the adapter not-ready
   * and kicking off a single reconnect loop. Guarded so the many events a failure
   * emits (connection error + close + channel error + close) trigger at most one
   * reconnect at a time.
   */
  private handleConnectionFailure(): void {
    if (this.isClosing || this.reconnecting) {
      return;
    }

    this.isReady = false;
    this.reconnecting = true;
    void this.reconnectWithBackoff();
  }

  /**
   * Reconnect with exponential backoff, re-establishing the channel and replaying
   * all registered consumers once connected.
   */
  private async reconnectWithBackoff(): Promise<void> {
    await this.cleanupConnection();

    let attempt = 0;
    while (!this.isClosing) {
      attempt++;
      const delay = Math.min(
        RabbitMQAdapter.RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
        RabbitMQAdapter.RECONNECT_MAX_DELAY_MS
      );

      logger.warn(`Reconnecting to RabbitMQ in ${delay}ms (attempt ${attempt})`, 'Reconnect');
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delay);
        timer.unref();
      });

      if (this.isClosing) {
        break;
      }

      try {
        await this.establishConnection();
        this.isReady = true;
        this.reconnecting = false;
        logger.info('RabbitMQ reconnected', 'Reconnect');
        await this.replayConsumers();
        return;
      } catch (error) {
        logger.error(`RabbitMQ reconnect attempt ${attempt} failed`, 'Reconnect', {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.cleanupConnection();
      }
    }

    this.reconnecting = false;
  }

  /**
   * Re-assert queues and re-register every consumer after a reconnect.
   */
  private async replayConsumers(): Promise<void> {
    const queues = Array.from(this.processors.keys());
    this.consumerTags.clear();

    for (const queueName of queues) {
      const handler = this.processors.get(queueName);
      const concurrency = this.queueConcurrency.get(queueName) ?? 1;
      if (!handler) {
        continue;
      }
      try {
        await this.registerConsumer(queueName, concurrency, handler);
      } catch (error) {
        logger.error(`Failed to replay consumer for queue ${queueName}`, 'Reconnect', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Best-effort close of the current channel + connection, clearing references.
   * Handlers on the old objects are guarded by the reconnecting/isClosing flags,
   * so the 'close' events these emit will not re-trigger another reconnect.
   */
  private async cleanupConnection(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;

    if (channel) {
      try {
        await channel.close();
      } catch {
        // ignore — channel may already be closed
      }
    }
    if (connection) {
      try {
        await connection.close();
      } catch {
        // ignore — connection may already be closed
      }
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
    this.trackJob(queueName, jobId);

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
    // Retain concurrency so the consumer can be replayed after a reconnect
    this.queueConcurrency.set(queueName, concurrency);

    await this.registerConsumer(queueName, concurrency, handler);
  }

  /**
   * Assert the queue, set prefetch and start consuming. Shared by process() and by
   * replayConsumers() so a reconnect re-establishes consumers identically.
   */
  private async registerConsumer(
    queueName: string,
    concurrency: number,
    handler: JobHandler<any, any>
  ): Promise<void> {
    await this.ensureQueueExists(queueName);

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

        // amqplib ignores the promise returned here, so a rejection would
        // surface as an unhandled rejection and take the process down.
        try {
          await this.handleMessage(queueName, msg, handler);
        } catch (error) {
          logger.error(
            `Unexpected error handling a message on queue ${queueName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      },
      { noAck: false }
    );

    this.consumerTags.set(queueName, consumer.consumerTag);
  }

  /**
   * Handle one delivered message: decode it, run the handler, and settle the
   * delivery (ack, re-publish for another attempt, or dead-letter).
   */
  private async handleMessage(
    queueName: string,
    msg: any,
    handler: JobHandler<any, any>
  ): Promise<void> {
    // Decode once. A payload that is not a JSON job object can never be
    // processed: reject it without requeue (it goes to the queue's dead-letter
    // exchange when one is configured) instead of crashing or redelivering.
    const decoded = decodeJobMessage(msg.content, msg.properties?.messageId);
    if (!decoded) {
      logger.error(
        `Rejecting malformed message on queue ${queueName} without requeue: not a JSON job message`
      );
      this.settle(queueName, channel => channel.nack(msg, false, false));
      return;
    }

    const { jobId, data, options } = decoded;

    // The message is the source of truth for the job. A job published by
    // another process, or before this consumer restarted, is not in the
    // in-memory store: rebuild the record from the message instead of
    // acknowledging it unprocessed.
    if (!this.jobStore.has(queueName)) {
      this.jobStore.set(queueName, new Map());
    }
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
      // The attempt count travels with the message (see the retry path below)
      storedJob.attemptsMade = decoded.attemptsMade;
    }
    const job = storedJob;

    try {
      job.processedOn = Date.now();

      // Create job context
      const jobContext: JobContext = {
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
    } catch (error) {
      job.attemptsMade++;
      job.failedReason = error instanceof Error ? error.message : String(error);
      job.finishedOn = Date.now();

      // Check if we should retry
      const maxAttempts = options.attempts || 1;
      if (job.attemptsMade < maxAttempts) {
        // Re-publish the job with its attempt count, then acknowledge this
        // delivery. A plain nack/requeue redelivers the identical message, so
        // the count would live only in this process's memory and be lost
        // across a restart or to another consumer.
        const retryBody = Buffer.from(
          JSON.stringify({ ...decoded.body, jobId, attemptsMade: job.attemptsMade })
        );
        const retryOptions: any = {
          persistent: true,
          priority: options.priority || 0,
          messageId: jobId,
        };
        if (msg.properties?.headers) {
          retryOptions.headers = msg.properties.headers;
        }
        const republished = this.settle(queueName, channel => {
          channel.sendToQueue(queueName, retryBody, retryOptions);
          channel.ack(msg);
        });
        if (!republished) {
          // Channel gone: the unacknowledged delivery is returned to the queue
          // by the broker and will be redelivered after reconnect.
          logger.warn(`Could not re-publish job ${jobId} on queue ${queueName} for retry`);
        }
      } else {
        // Max attempts reached, move to DLQ or acknowledge
        this.settle(queueName, channel => channel.ack(msg));

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
      return;
    }

    // Mark as completed
    job.finishedOn = Date.now();
    job.progress = 100;

    // Acknowledge message
    this.settle(queueName, channel => channel.ack(msg));

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
  }

  /**
   * Run an ack/nack/publish against the current channel. Returns false (and
   * logs) when the channel is gone or the operation throws; the broker then
   * redelivers the unacknowledged message once the consumer is back.
   */
  private settle(queueName: string, operation: (channel: AMQPChannel) => void): boolean {
    const channel = this.channel;
    if (!channel) {
      logger.warn(`Cannot settle a message on queue ${queueName}: channel is closed`);
      return false;
    }
    try {
      operation(channel);
      return true;
    } catch (error) {
      logger.error(
        `Failed to settle a message on queue ${queueName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
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
      this.retention.forget(queueName, jobId);
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
    this.retention.clear(queueName);
    this.processors.delete(queueName);
    this.queueConcurrency.delete(queueName);
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    // Signal intentional shutdown so lifecycle handlers don't trigger a reconnect
    this.isClosing = true;

    // Cancel all consumers
    for (const queueName of Array.from(this.consumerTags.keys())) {
      await this.pauseQueue(queueName);
    }

    // Close channel + connection (best-effort)
    await this.cleanupConnection();

    this.jobStore.clear();
    this.retention.clear();
    this.processors.clear();
    this.queueConcurrency.clear();
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
