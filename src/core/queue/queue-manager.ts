/**
 * Queue Manager
 * Central manager for all queue operations in MoroJS
 */

import type {
  IQueueManager,
  IQueueAdapter,
  QueueOptions,
  Job,
  JobOptions,
  JobHandler,
  BulkJobData,
  QueueStatus,
  QueueEvent,
  QueueEventType,
} from './types.js';
import { MemoryAdapter } from './adapters/memory-adapter.js';
import { BullAdapter } from './adapters/bull-adapter.js';
import { RabbitMQAdapter } from './adapters/rabbitmq-adapter.js';
import { SQSAdapter } from './adapters/sqs-adapter.js';
import { KafkaAdapter } from './adapters/kafka-adapter.js';
import type { EventEmitter } from 'events';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('QueueManager');

/**
 * Queue configuration with adapter instance
 */
interface RegisteredQueue {
  name: string;
  options: QueueOptions;
  adapter: IQueueAdapter;
  processors: Map<string, JobHandler<any, any>>;
}

/**
 * Queue Manager
 * Manages multiple queues with different adapters
 */
export class QueueManager implements IQueueManager {
  private queues: Map<string, RegisteredQueue> = new Map();
  private eventEmitter?: EventEmitter;
  private isShuttingDown: boolean = false;

  constructor(eventEmitter?: EventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /**
   * Register a new queue
   */
  async registerQueue(name: string, options: QueueOptions): Promise<void> {
    if (this.queues.has(name)) {
      throw new Error(`Queue "${name}" is already registered`);
    }

    // Create adapter based on type
    const adapter = this.createAdapter(options);

    // Initialize adapter
    await adapter.initialize();

    // Register queue
    this.queues.set(name, {
      name,
      options,
      adapter,
      processors: new Map(),
    });

    this.emitEvent('queue:created', {
      queueName: name,
      timestamp: Date.now(),
    });
  }

  /**
   * Add a job to a queue
   */
  async addToQueue<T = any>(queueName: string, data: T, options?: JobOptions): Promise<Job<T>> {
    const queue = this.getQueue(queueName);

    // Merge with default options
    const finalOptions: JobOptions = {
      ...queue.options.defaultJobOptions,
      ...options,
    };

    const job = await queue.adapter.addJob(queueName, data, finalOptions);

    this.emitEvent('queue:job:added', {
      queueName,
      jobId: job.id,
      job,
      timestamp: Date.now(),
    });

    return job;
  }

  /**
   * Add multiple jobs to a queue in bulk
   */
  async addBulkToQueue<T = any>(queueName: string, jobs: BulkJobData<T>[]): Promise<Job<T>[]> {
    const queue = this.getQueue(queueName);

    // Merge with default options for each job
    const jobsWithDefaults = jobs.map(job => ({
      ...job,
      options: {
        ...queue.options.defaultJobOptions,
        ...job.options,
      },
    }));

    const addedJobs = await queue.adapter.addBulkJobs(queueName, jobsWithDefaults);

    for (const job of addedJobs) {
      this.emitEvent('queue:job:added', {
        queueName,
        jobId: job.id,
        job,
        timestamp: Date.now(),
      });
    }

    return addedJobs;
  }

  /**
   * Register a processor for a queue
   */
  async processQueue<T = any, R = any>(
    queueName: string,
    concurrencyOrHandler: number | JobHandler<T, R>,
    handler?: JobHandler<T, R>
  ): Promise<void> {
    const queue = this.getQueue(queueName);

    // Parse arguments
    let concurrency: number;
    let actualHandler: JobHandler<T, R>;

    if (typeof concurrencyOrHandler === 'function') {
      concurrency = queue.options.concurrency || 1;
      actualHandler = concurrencyOrHandler;
    } else {
      concurrency = concurrencyOrHandler;
      if (!handler) {
        throw new Error('Handler function is required when concurrency is specified');
      }
      actualHandler = handler;
    }

    // Wrap handler to emit events
    const wrappedHandler: JobHandler<T, R> = async job => {
      try {
        this.emitEvent('queue:job:active', {
          queueName,
          jobId: job.id,
          job,
          timestamp: Date.now(),
        });

        // Wrap updateProgress to emit events
        const originalUpdateProgress = job.updateProgress;
        job.updateProgress = async (progress: number) => {
          await originalUpdateProgress.call(job, progress);
          this.emitEvent('queue:job:progress', {
            queueName,
            jobId: job.id,
            progress,
            timestamp: Date.now(),
          });
        };

        const result = await actualHandler(job);

        this.emitEvent('queue:job:completed', {
          queueName,
          jobId: job.id,
          job,
          result,
          timestamp: Date.now(),
        });

        return result;
      } catch (error) {
        this.emitEvent('queue:job:failed', {
          queueName,
          jobId: job.id,
          job,
          error: error as Error,
          timestamp: Date.now(),
        });
        throw error;
      }
    };

    // Store processor
    queue.processors.set(queueName, wrappedHandler);

    // Register with adapter
    await queue.adapter.process(queueName, concurrency, wrappedHandler);
  }

  /**
   * Get queue status
   */
  async getQueueStatus(queueName: string): Promise<QueueStatus> {
    const queue = this.getQueue(queueName);

    const metrics = await queue.adapter.getMetrics(queueName);

    return {
      name: queueName,
      adapter: queue.options.adapter,
      isPaused: metrics.paused > 0,
      metrics,
      workers: queue.processors.size,
    };
  }

  /**
   * Get a specific job
   */
  async getJob(queueName: string, jobId: string): Promise<Job | null> {
    const queue = this.getQueue(queueName);
    return await queue.adapter.getJob(queueName, jobId);
  }

  /**
   * Get jobs by status
   */
  async getJobs(
    queueName: string,
    status?: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused',
    start: number = 0,
    end: number = -1
  ): Promise<Job[]> {
    const queue = this.getQueue(queueName);
    return await queue.adapter.getJobs(queueName, status, start, end);
  }

  /**
   * Remove a job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.adapter.removeJob(queueName, jobId);

    this.emitEvent('queue:job:removed', {
      queueName,
      jobId,
      timestamp: Date.now(),
    });
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.adapter.retryJob(queueName, jobId);
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.adapter.pauseQueue(queueName);

    this.emitEvent('queue:paused', {
      queueName,
      timestamp: Date.now(),
    });
  }

  /**
   * Resume a queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.adapter.resumeQueue(queueName);

    this.emitEvent('queue:resumed', {
      queueName,
      timestamp: Date.now(),
    });
  }

  /**
   * Clean old jobs from a queue
   */
  async cleanQueue(
    queueName: string,
    gracePeriod: number,
    status?: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'
  ): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.adapter.clean(queueName, gracePeriod, status);

    this.emitEvent('queue:cleaned', {
      queueName,
      timestamp: Date.now(),
    });
  }

  /**
   * Obliterate a queue (delete all data)
   */
  async obliterateQueue(queueName: string): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.adapter.obliterate(queueName);

    this.emitEvent('queue:drained', {
      queueName,
      timestamp: Date.now(),
    });

    this.queues.delete(queueName);
  }

  /**
   * Get all registered queues
   */
  getQueueNames(): string[] {
    return Array.from(this.queues.keys());
  }

  /**
   * Check if a queue is registered
   */
  hasQueue(queueName: string): boolean {
    return this.queues.has(queueName);
  }

  /**
   * Shutdown all queues gracefully
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;

    // Close all adapters
    const shutdownPromises = Array.from(this.queues.values()).map(async queue => {
      try {
        await queue.adapter.close();
      } catch (error) {
        logger.error(`Error closing queue ${queue.name}: ${error}`);
      }
    });

    await Promise.all(shutdownPromises);

    this.queues.clear();
    this.isShuttingDown = false;
  }

  /**
   * Create an adapter instance based on options
   */
  private createAdapter(options: QueueOptions): IQueueAdapter {
    switch (options.adapter) {
      case 'memory':
        return new MemoryAdapter();

      case 'bull':
        return new BullAdapter(options.connection);

      case 'rabbitmq':
        return new RabbitMQAdapter(options.connection);

      case 'sqs':
        return new SQSAdapter(options.connection);

      case 'kafka':
        return new KafkaAdapter(options.connection);

      default:
        throw new Error(`Unknown queue adapter: ${options.adapter}`);
    }
  }

  /**
   * Get a registered queue
   */
  private getQueue(queueName: string): RegisteredQueue {
    const queue = this.queues.get(queueName);

    if (!queue) {
      throw new Error(
        `Queue "${queueName}" is not registered. Call app.queue('${queueName}', options) first.`
      );
    }

    return queue;
  }

  /**
   * Emit a queue event
   */
  private emitEvent(eventType: QueueEventType, payload: Partial<QueueEvent>): void {
    if (!this.eventEmitter) {
      return;
    }

    const event: QueueEvent = {
      queueName: payload.queueName || '',
      jobId: payload.jobId,
      job: payload.job,
      result: payload.result,
      error: payload.error,
      progress: payload.progress,
      timestamp: payload.timestamp || Date.now(),
    };

    this.eventEmitter.emit(eventType, event);
  }
}
