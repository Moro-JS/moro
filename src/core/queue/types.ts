/**
 * Message Queue System - Type Definitions
 * Pure ESM module with comprehensive types for queue operations
 */

/**
 * Supported queue adapter types
 */
export type QueueAdapterType = 'bull' | 'rabbitmq' | 'sqs' | 'kafka' | 'memory';

/**
 * Job status states
 */
export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';

/**
 * Backoff strategy for job retries
 */
export type BackoffStrategy = 'fixed' | 'exponential' | 'linear';

/**
 * Queue adapter connection configuration
 */
export interface QueueConnectionConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: number;
  brokers?: string[];
  groupId?: string;
  region?: string;
  queueUrl?: string;
  [key: string]: any;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  backoff: BackoffStrategy;
  initialDelay: number;
  maxDelay?: number;
}

/**
 * Dead letter queue configuration
 */
export interface DeadLetterQueueConfig {
  enabled: boolean;
  maxRetries: number;
  queueName?: string;
}

/**
 * Job options for individual jobs
 */
export interface JobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: {
    type: BackoffStrategy;
    delay: number;
  };
  timeout?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  repeat?: {
    cron?: string;
    every?: number;
    limit?: number;
    endDate?: Date | string;
  };
  jobId?: string;
  [key: string]: any;
}

/**
 * Default job options for a queue
 */
export interface DefaultJobOptions {
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  attempts?: number;
  backoff?: {
    type: BackoffStrategy;
    delay: number;
  };
}

/**
 * Queue configuration options
 */
export interface QueueOptions {
  adapter: QueueAdapterType;
  connection?: QueueConnectionConfig;
  concurrency?: number;
  retry?: RetryConfig;
  deadLetterQueue?: DeadLetterQueueConfig;
  defaultJobOptions?: DefaultJobOptions;
  prefix?: string;
  limiter?: {
    max: number;
    duration: number;
  };
}

/**
 * Job data structure
 */
export interface Job<T = any> {
  id: string;
  name: string;
  data: T;
  progress: number;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: any;
  opts: JobOptions;
}

/**
 * Job context with helper methods
 */
export interface JobContext<T = any> extends Job<T> {
  updateProgress(progress: number): Promise<void>;
  log(message: string): void;
}

/**
 * Job handler function
 */
export type JobHandler<T = any, R = any> = (job: JobContext<T>) => Promise<R>;

/**
 * Bulk job data
 */
export interface BulkJobData<T = any> {
  data: T;
  options?: JobOptions;
}

/**
 * Queue metrics
 */
export interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

/**
 * Queue event types
 */
export type QueueEventType =
  | 'queue:created'
  | 'queue:job:added'
  | 'queue:job:active'
  | 'queue:job:completed'
  | 'queue:job:failed'
  | 'queue:job:progress'
  | 'queue:job:stalled'
  | 'queue:job:removed'
  | 'queue:paused'
  | 'queue:resumed'
  | 'queue:cleaned'
  | 'queue:drained'
  | 'queue:error';

/**
 * Queue event payload
 */
export interface QueueEvent {
  queueName: string;
  jobId?: string;
  job?: Job;
  result?: any;
  error?: Error;
  progress?: number;
  timestamp: number;
}

/**
 * Queue status
 */
export interface QueueStatus {
  name: string;
  adapter: QueueAdapterType;
  isPaused: boolean;
  metrics: QueueMetrics;
  workers: number;
}

/**
 * Base queue adapter interface
 */
export interface IQueueAdapter {
  name: string;
  isReady: boolean;

  initialize(): Promise<void>;

  addJob<T = any>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>>;

  addBulkJobs<T = any>(queueName: string, jobs: BulkJobData<T>[]): Promise<Job<T>[]>;

  process<T = any, R = any>(
    queueName: string,
    concurrency: number,
    handler: JobHandler<T, R>
  ): Promise<void>;

  getJob(queueName: string, jobId: string): Promise<Job | null>;

  getJobs(queueName: string, status?: JobStatus, start?: number, end?: number): Promise<Job[]>;

  removeJob(queueName: string, jobId: string): Promise<void>;

  retryJob(queueName: string, jobId: string): Promise<void>;

  pauseQueue(queueName: string): Promise<void>;

  resumeQueue(queueName: string): Promise<void>;

  getMetrics(queueName: string): Promise<QueueMetrics>;

  clean(queueName: string, gracePeriod: number, status?: JobStatus): Promise<void>;

  obliterate(queueName: string): Promise<void>;

  close(): Promise<void>;
}

/**
 * Queue manager interface
 */
export interface IQueueManager {
  registerQueue(name: string, options: QueueOptions): Promise<void>;

  addToQueue<T = any>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>>;

  addBulkToQueue<T = any>(queueName: string, jobs: BulkJobData<T>[]): Promise<Job<T>[]>;

  processQueue<T = any, R = any>(
    queueName: string,
    concurrencyOrHandler: number | JobHandler<T, R>,
    handler?: JobHandler<T, R>
  ): Promise<void>;

  getQueueStatus(queueName: string): Promise<QueueStatus>;

  pauseQueue(queueName: string): Promise<void>;

  resumeQueue(queueName: string): Promise<void>;

  shutdown(): Promise<void>;
}
