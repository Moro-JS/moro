/**
 * AWS SQS Queue Adapter
 * Adapter for AWS Simple Queue Service
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

const logger = createFrameworkLogger('SQSQueue');

/**
 * Type definitions for AWS SDK (loaded dynamically)
 */
type SQSClient = any;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type SendMessageCommand = any;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ReceiveMessageCommand = any;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type DeleteMessageCommand = any;

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
  receiptHandle?: string | undefined;
}

/**
 * Per-queue long-polling state.
 *
 * SQS long polling (WaitTimeSeconds) already paces requests, so instead of a
 * fixed-rate setInterval — which would stack ~one 10s request every 100ms — we
 * run a single self-scheduling loop: poll, then schedule the next poll only once
 * the previous one settles.
 */
interface PollingState {
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  inFlight: Promise<void> | null;
}

/**
 * AWS SQS adapter for cloud-native queues
 * Suitable for AWS-based applications
 */
export class SQSAdapter extends QueueAdapter {
  public name = 'sqs';

  private SQSClient: any = null;
  private SendMessageCommand: any = null;
  private SendMessageBatchCommand: any = null;
  private ReceiveMessageCommand: any = null;
  private DeleteMessageCommand: any = null;
  private client: SQSClient | null = null;
  private connectionConfig: QueueConnectionConfig;
  private processors: Map<string, JobHandler<any, any>> = new Map();
  private jobStore: Map<string, Map<string, StoredJob>> = new Map();
  private pollingState: Map<string, PollingState> = new Map();
  private queueUrls: Map<string, string> = new Map();

  constructor(connectionConfig: QueueConnectionConfig = {}) {
    super();
    this.connectionConfig = connectionConfig;
  }

  /**
   * Initialize the SQS adapter
   */
  async initialize(): Promise<void> {
    if (this.isReady) {
      return;
    }

    if (!isPackageAvailable('@aws-sdk/client-sqs')) {
      throw new Error(
        '@aws-sdk/client-sqs is not installed. Install it with: npm install @aws-sdk/client-sqs'
      );
    }

    try {
      // Load AWS SDK
      const sqsPath = resolveUserPackage('@aws-sdk/client-sqs');
      const sqsModule = await import(sqsPath);

      this.SQSClient = sqsModule.SQSClient;
      this.SendMessageCommand = sqsModule.SendMessageCommand;
      this.SendMessageBatchCommand = sqsModule.SendMessageBatchCommand;
      this.ReceiveMessageCommand = sqsModule.ReceiveMessageCommand;
      this.DeleteMessageCommand = sqsModule.DeleteMessageCommand;

      // Create SQS client
      this.client = new this.SQSClient({
        region: this.connectionConfig.region || 'us-east-1',
      });

      this.isReady = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize SQS adapter: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get or set queue URL
   */
  private getQueueUrl(queueName: string): string {
    if (!this.queueUrls.has(queueName)) {
      // Try to get from config, otherwise construct default
      const url =
        this.connectionConfig.queueUrl ||
        `https://sqs.${this.connectionConfig.region || 'us-east-1'}.amazonaws.com/${this.connectionConfig.accountId || '000000000000'}/${queueName}`;
      this.queueUrls.set(queueName, url);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.queueUrls.get(queueName)!;
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

    // Prepare message
    const message = {
      jobId,
      data,
      options,
      timestamp: job.timestamp,
    };

    const params: any = {
      QueueUrl: this.getQueueUrl(queueName),
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        JobId: {
          DataType: 'String',
          StringValue: jobId,
        },
      },
    };

    // Add delay if specified
    if (options.delay && options.delay > 0) {
      params.DelaySeconds = Math.floor(options.delay / 1000); // Convert to seconds
    }

    // Send message
    const command = new this.SendMessageCommand(params);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.client!.send(command);

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
    const entries = [];

    for (let i = 0; i < jobs.length; i++) {
      const jobData = jobs[i];
      if (!jobData) {
        continue;
      }
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

      const message = {
        jobId,
        data: jobData.data,
        options: jobData.options || {},
        timestamp: job.timestamp,
      };

      entries.push({
        Id: String(i),
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          JobId: {
            DataType: 'String',
            StringValue: jobId,
          },
        },
        DelaySeconds: jobData.options?.delay ? Math.floor(jobData.options.delay / 1000) : 0,
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

      // SQS batch limit is 10 messages
      if (entries.length === 10 || i === jobs.length - 1) {
        const command = new this.SendMessageBatchCommand({
          QueueUrl: this.getQueueUrl(queueName),
          Entries: entries,
        });
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await this.client!.send(command);
        entries.length = 0;
      }
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
    this.ensureJobStore(queueName);

    this.processors.set(queueName, handler);

    // Start polling for messages
    this.startPolling(queueName, concurrency);
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

    const job = this.jobStore.get(queueName)?.get(jobId);
    if (job && job.receiptHandle) {
      // Delete from SQS
      const command = new this.DeleteMessageCommand({
        QueueUrl: this.getQueueUrl(queueName),
        ReceiptHandle: job.receiptHandle,
      });

      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await this.client!.send(command);
      } catch {
        // Message might already be deleted, ignore
      }
    }

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
    storedJob.receiptHandle = undefined;

    // Re-add to queue
    await this.addJob(queueName, storedJob.data, storedJob.options);
  }

  /**
   * Pause the queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    this.ensureReady();
    await this.stopPolling(queueName);
  }

  /**
   * Resume the queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    this.ensureReady();

    const handler = this.processors.get(queueName);
    if (handler) {
      this.startPolling(queueName, 1);
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

    // Stop polling
    await this.pauseQueue(queueName);

    // Note: We don't delete the SQS queue itself, just stop processing
    // To delete the queue, use AWS console or CLI

    this.jobStore.delete(queueName);
    this.processors.delete(queueName);
    this.queueUrls.delete(queueName);
  }

  /**
   * Close the adapter
   */
  async close(): Promise<void> {
    // Stop all polling
    for (const queueName of Array.from(this.pollingState.keys())) {
      await this.stopPolling(queueName);
    }

    this.jobStore.clear();
    this.processors.clear();
    this.queueUrls.clear();
    this.client = null;
    this.isReady = false;
  }

  /**
   * Start polling for messages.
   *
   * Runs a single self-scheduling loop instead of a fixed-rate interval: the next
   * poll is only scheduled once the current one settles, so long-poll requests can
   * never stack up. The scheduling timer is unref'd so it doesn't keep the process
   * alive, and an in-flight promise is tracked so pause/close can await the active
   * poll before returning.
   */
  private startPolling(queueName: string, maxMessages: number): void {
    if (this.pollingState.has(queueName)) {
      return;
    }

    const state: PollingState = { timer: null, stopped: false, inFlight: null };
    this.pollingState.set(queueName, state);

    const pollOnce = async (): Promise<void> => {
      try {
        const command = new this.ReceiveMessageCommand({
          QueueUrl: this.getQueueUrl(queueName),
          MaxNumberOfMessages: Math.min(maxMessages, 10), // SQS max is 10
          WaitTimeSeconds: 10, // Long polling
          MessageAttributeNames: ['All'],
        });

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const response = await this.client!.send(command);

        if (response.Messages && response.Messages.length > 0) {
          // Process messages in parallel
          await Promise.all(
            response.Messages.map((message: any) => this.processMessage(queueName, message))
          );
        }
      } catch (error) {
        logger.error(`Error polling queue ${queueName}: ${error}`);
      }
    };

    const runLoop = (): void => {
      if (state.stopped) {
        return;
      }

      const current = pollOnce();
      state.inFlight = current;

      void current.then(() => {
        state.inFlight = null;
        if (state.stopped) {
          return;
        }
        // Long polling already paces us; schedule the next iteration immediately.
        const timer = setTimeout(runLoop, 0);
        timer.unref();
        state.timer = timer;
      });
    };

    runLoop();
  }

  /**
   * Stop the polling loop for a queue and wait for any in-flight poll to settle.
   */
  private async stopPolling(queueName: string): Promise<void> {
    const state = this.pollingState.get(queueName);
    if (!state) {
      return;
    }

    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    // Await the active poll so callers don't race with in-flight message processing.
    const inFlight = state.inFlight;
    if (inFlight) {
      await inFlight.catch(() => {});
    }

    this.pollingState.delete(queueName);
  }

  /**
   * Process a single message
   */
  private async processMessage(queueName: string, message: any): Promise<void> {
    const handler = this.processors.get(queueName);
    if (!handler) {
      return;
    }

    try {
      const body = JSON.parse(message.Body);
      const { jobId, data, options, timestamp } = body;

      // The SQS message body is the source of truth for the job. In the normal
      // topology producers and consumers are separate processes (or the
      // consumer restarted after enqueue), so this consumer's in-memory
      // jobStore will not contain the job. Reconstruct and cache a local record
      // from the body instead of deleting the message unprocessed — dropping it
      // here silently loses the job and never runs the handler.
      let storedJob = this.jobStore.get(queueName)?.get(jobId);
      if (!storedJob) {
        storedJob = {
          id: jobId,
          name: queueName,
          data,
          options: options || {},
          attemptsMade: 0,
          timestamp: timestamp || Date.now(),
          progress: 0,
        };
        this.ensureJobStore(queueName);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this.jobStore.get(queueName)!.set(jobId, storedJob);
      }

      storedJob.receiptHandle = message.ReceiptHandle;
      storedJob.processedOn = Date.now();

      // Create job context
      const jobContext: JobContext = {
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
      await handler(jobContext);

      // Mark as completed
      storedJob.finishedOn = Date.now();
      storedJob.progress = 100;

      // Delete message from SQS
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await this.client!.send(
        new this.DeleteMessageCommand({
          QueueUrl: this.getQueueUrl(queueName),
          ReceiptHandle: message.ReceiptHandle,
        })
      );

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
      const body = JSON.parse(message.Body);
      const { jobId, options } = body;

      const storedJob = this.jobStore.get(queueName)?.get(jobId);
      if (storedJob) {
        storedJob.attemptsMade++;
        storedJob.failedReason = error instanceof Error ? error.message : String(error);
        storedJob.finishedOn = Date.now();

        // SQS handles retries automatically via visibility timeout
        // If max attempts reached, delete the message
        const maxAttempts = options.attempts || 1;
        if (storedJob.attemptsMade >= maxAttempts) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          await this.client!.send(
            new this.DeleteMessageCommand({
              QueueUrl: this.getQueueUrl(queueName),
              ReceiptHandle: message.ReceiptHandle,
            })
          );

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
      }
    }
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
