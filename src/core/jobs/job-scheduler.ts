// Production-grade Job Scheduler
// Main scheduler with graceful shutdown, concurrency control, and priority queue

import { EventEmitter } from 'events';
import { Logger } from '../../types/logger.js';
import { CronParser } from './cron-parser.js';
import { JobStateManager, JobExecution } from './job-state-manager.js';
import { LeaderElection, LeaderElectionOptions } from './leader-election.js';
import { JobExecutor, JobExecutorOptions, JobFunction } from './job-executor.js';
import { randomBytes } from 'crypto';

export type JobScheduleType = 'cron' | 'interval' | 'oneTime';

export interface JobSchedule {
  type: JobScheduleType;
  cron?: string;
  interval?: number;
  at?: Date;
}

export interface JobOptions {
  name?: string;
  schedule: JobSchedule;
  enabled?: boolean;
  priority?: number;
  timezone?: string;
  maxConcurrent?: number;
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: 'linear' | 'exponential';
  enableCircuitBreaker?: boolean;
  metadata?: Record<string, any>;
  onStart?: (context: ExecutionContext) => void | Promise<void>;
  onComplete?: (context: ExecutionContext, result: any) => void | Promise<void>;
  onError?: (context: ExecutionContext, error: Error) => void | Promise<void>;
}

export interface ExecutionContext {
  jobId: string;
  executionId: string;
  attempt: number;
  startTime: Date;
  metadata?: Record<string, any>;
}

export interface Job {
  id: string;
  name: string;
  schedule: JobSchedule;
  fn: JobFunction;
  options: JobOptions;
  nextRun?: Date;
  enabled: boolean;
  priority: number;
  timer?: NodeJS.Timeout;
  concurrentExecutions: number;
  createdAt: Date;
}

export interface JobSchedulerOptions {
  maxConcurrentJobs?: number;
  enableLeaderElection?: boolean;
  leaderElection?: LeaderElectionOptions;
  executor?: JobExecutorOptions;
  stateManager?: {
    persistPath?: string;
    historySize?: number;
    persistInterval?: number;
    enableAutoPersist?: boolean;
    enableRecovery?: boolean;
  };
  gracefulShutdownTimeout?: number;
}

/**
 * JobScheduler - Production-grade job scheduling system
 * Features:
 * - Cron, interval, and one-time scheduling
 * - Leader election for distributed systems
 * - Graceful shutdown with running job completion
 * - Global and per-job concurrency control
 * - Priority queue for job execution
 * - Automatic crash recovery
 * - Full observability with events and metrics
 */
export class JobScheduler extends EventEmitter {
  private jobs = new Map<string, Job>();
  private stateManager: JobStateManager;
  private leaderElection?: LeaderElection;
  private executor: JobExecutor;
  private logger: Logger;
  private loggerContext = 'JobScheduler';
  private started = false;
  private isShuttingDown = false;
  private maxConcurrentJobs: number;
  private currentConcurrentJobs = 0;
  private pendingQueue: Array<{ job: Job; executionId: string }> = [];
  private gracefulShutdownTimeout: number;
  private enableLeaderElection: boolean;

  constructor(logger: Logger, options: JobSchedulerOptions = {}) {
    super();
    this.logger = logger;

    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 10;
    this.gracefulShutdownTimeout = options.gracefulShutdownTimeout ?? 30000;
    this.enableLeaderElection = options.enableLeaderElection ?? true;

    // Initialize state manager
    this.stateManager = new JobStateManager(logger, options.stateManager);

    // Initialize executor
    this.executor = new JobExecutor(logger, options.executor);

    // Initialize leader election if enabled
    if (this.enableLeaderElection) {
      this.leaderElection = new LeaderElection(logger, options.leaderElection);

      // Handle leader election events
      this.leaderElection.on('leader:elected', () => {
        this.logger.info('Became leader, starting job scheduling', this.loggerContext);
        this.scheduleAllJobs();
      });

      this.leaderElection.on('leader:stepdown', () => {
        this.logger.info('Lost leadership, stopping job scheduling', this.loggerContext);
        this.unscheduleAllJobs();
      });
    }

    this.logger.debug('JobScheduler initialized', this.loggerContext, {
      maxConcurrentJobs: this.maxConcurrentJobs,
      enableLeaderElection: this.enableLeaderElection,
    });
  }

  /**
   * Start the job scheduler
   */
  public async start(): Promise<void> {
    if (this.started) {
      this.logger.warn('JobScheduler already started', this.loggerContext);
      return;
    }

    this.logger.info('Starting JobScheduler...', this.loggerContext);

    this.started = true;

    // Start leader election if enabled
    if (this.leaderElection) {
      await this.leaderElection.start();
    } else {
      // No leader election, start immediately
      this.scheduleAllJobs();
    }

    this.logger.info('JobScheduler started', this.loggerContext, {
      jobCount: this.jobs.size,
      isLeader: this.isLeader(),
    });

    this.emit('scheduler:started', {
      jobCount: this.jobs.size,
      isLeader: this.isLeader(),
    });
  }

  /**
   * Register a new job
   */
  public registerJob(
    name: string,
    schedule: JobSchedule,
    fn: JobFunction,
    options: Partial<JobOptions> = {}
  ): string {
    const jobId = this.generateJobId();

    // Validate schedule
    this.validateSchedule(schedule);

    const job: Job = {
      id: jobId,
      name: options.name || name,
      schedule,
      fn,
      options: { ...options, name: options.name || name, schedule } as JobOptions,
      enabled: options.enabled !== false,
      priority: options.priority ?? 0,
      concurrentExecutions: 0,
      createdAt: new Date(),
    };

    // Calculate next run
    job.nextRun = this.calculateNextRun(job);

    this.jobs.set(jobId, job);

    // Register in state manager
    this.stateManager.registerJob(jobId, job.name, {
      schedule: job.schedule,
      priority: job.priority,
      ...options.metadata,
    });

    this.logger.info(`Job registered: ${job.name} (${jobId})`, this.loggerContext, {
      schedule: job.schedule,
      nextRun: job.nextRun,
    });

    this.emit('job:registered', { jobId, name: job.name, schedule: job.schedule });

    // Schedule if already started and is leader
    if (this.started && this.isLeader() && job.enabled) {
      this.scheduleJob(job);
    }

    return jobId;
  }

  /**
   * Unregister a job
   */
  public unregisterJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }

    // Unschedule
    this.unscheduleJob(job);

    // Remove from jobs
    this.jobs.delete(jobId);

    // Unregister from state manager
    this.stateManager.unregisterJob(jobId);

    this.logger.info(`Job unregistered: ${job.name} (${jobId})`, this.loggerContext);
    this.emit('job:unregistered', { jobId, name: job.name });

    return true;
  }

  /**
   * Get job by ID
   */
  public getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  public getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Enable/disable job
   */
  public setJobEnabled(jobId: string, enabled: boolean): boolean {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }

    job.enabled = enabled;
    this.stateManager.setJobEnabled(jobId, enabled);

    if (enabled && this.started && this.isLeader()) {
      this.scheduleJob(job);
    } else if (!enabled) {
      this.unscheduleJob(job);
    }

    this.logger.info(
      `Job ${enabled ? 'enabled' : 'disabled'}: ${job.name} (${jobId})`,
      this.loggerContext
    );
    this.emit('job:enabled', { jobId, enabled });

    return true;
  }

  /**
   * Manually trigger job execution
   */
  public async triggerJob(jobId: string, metadata?: Record<string, any>): Promise<ExecutionResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    this.logger.info(`Manually triggering job: ${job.name} (${jobId})`, this.loggerContext);
    return this.executeJob(job, metadata);
  }

  /**
   * Validate schedule configuration
   */
  private validateSchedule(schedule: JobSchedule): void {
    if (schedule.type === 'cron') {
      if (!schedule.cron) {
        throw new Error('Cron schedule requires cron expression');
      }
      // Validate cron expression
      const validation = CronParser.validate(schedule.cron);
      if (!validation.valid) {
        throw new Error(`Invalid cron expression: ${validation.error}`);
      }
    } else if (schedule.type === 'interval') {
      if (!schedule.interval || schedule.interval <= 0) {
        throw new Error('Interval schedule requires positive interval value');
      }
    } else if (schedule.type === 'oneTime') {
      if (!schedule.at) {
        throw new Error('One-time schedule requires date');
      }
      if (schedule.at < new Date()) {
        throw new Error('One-time schedule date must be in the future');
      }
    }
  }

  /**
   * Calculate next run time for job
   */
  private calculateNextRun(job: Job): Date | undefined {
    const { schedule } = job;

    if (schedule.type === 'cron') {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const parser = new CronParser(schedule.cron!, job.options.timezone);
      return parser.getNextRun().next;
    } else if (schedule.type === 'interval') {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return new Date(Date.now() + schedule.interval!);
    } else if (schedule.type === 'oneTime') {
      return schedule.at;
    }

    return undefined;
  }

  /**
   * Schedule all jobs
   */
  private scheduleAllJobs(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(job: Job): void {
    // Unschedule first if already scheduled
    this.unscheduleJob(job);

    if (!job.nextRun) {
      this.logger.warn(
        `Job ${job.name} has no next run time, skipping schedule`,
        this.loggerContext
      );
      return;
    }

    const delay = job.nextRun.getTime() - Date.now();

    if (delay < 0) {
      // Should have run already, execute immediately and calculate next
      this.logger.debug(`Job ${job.name} overdue, executing immediately`, this.loggerContext);
      this.queueJobExecution(job);
      return;
    }

    job.timer = setTimeout(() => {
      this.queueJobExecution(job);
    }, delay);

    // Don't keep process alive for job timers
    job.timer.unref();

    this.stateManager.setNextRun(job.id, job.nextRun);

    this.logger.debug(`Job scheduled: ${job.name} (${job.id})`, this.loggerContext, {
      nextRun: job.nextRun,
      delay,
    });
  }

  /**
   * Unschedule a job
   */
  private unscheduleJob(job: Job): void {
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = undefined;
    }
  }

  /**
   * Unschedule all jobs
   */
  private unscheduleAllJobs(): void {
    for (const job of this.jobs.values()) {
      this.unscheduleJob(job);
    }
  }

  /**
   * Queue job for execution (with concurrency control)
   */
  private queueJobExecution(job: Job): void {
    const executionId = this.generateExecutionId();

    // Check global concurrency limit
    if (this.currentConcurrentJobs >= this.maxConcurrentJobs) {
      this.logger.debug(
        `Global concurrency limit reached, queueing job: ${job.name}`,
        this.loggerContext,
        {
          current: this.currentConcurrentJobs,
          max: this.maxConcurrentJobs,
        }
      );

      this.pendingQueue.push({ job, executionId });
      this.emit('job:queued', {
        jobId: job.id,
        executionId,
        queueLength: this.pendingQueue.length,
      });
      return;
    }

    // Check per-job concurrency limit
    const maxConcurrent = job.options.maxConcurrent ?? 1;
    if (job.concurrentExecutions >= maxConcurrent) {
      this.logger.debug(
        `Job concurrency limit reached, queueing: ${job.name}`,
        this.loggerContext,
        {
          current: job.concurrentExecutions,
          max: maxConcurrent,
        }
      );

      this.pendingQueue.push({ job, executionId });
      this.emit('job:queued', {
        jobId: job.id,
        executionId,
        queueLength: this.pendingQueue.length,
      });
      return;
    }

    // Execute immediately
    this.executeJobAsync(job, executionId);
  }

  /**
   * Execute job asynchronously
   */
  private executeJobAsync(job: Job, executionId: string, metadata?: Record<string, any>): void {
    // Execute in background
    this.executeJob(job, metadata, executionId).catch(error => {
      this.logger.error(`Unhandled error in job execution: ${job.name}`, this.loggerContext, {
        error,
      });
    });
  }

  /**
   * Execute job with full lifecycle management
   */
  private async executeJob(
    job: Job,
    metadata?: Record<string, any>,
    executionId?: string
  ): Promise<ExecutionResult> {
    const execId = executionId || this.generateExecutionId();

    this.currentConcurrentJobs++;
    job.concurrentExecutions++;

    const context: ExecutionContext = {
      jobId: job.id,
      executionId: execId,
      attempt: 1,
      startTime: new Date(),
      metadata: { ...job.options.metadata, ...metadata },
    };

    try {
      // Start execution tracking
      this.stateManager.startExecution(job.id, execId, context.metadata);

      this.logger.info(`Executing job: ${job.name} (${execId})`, this.loggerContext);
      this.emit('job:start', { jobId: job.id, executionId: execId, context });

      // Call onStart hook
      if (job.options.onStart) {
        await Promise.resolve(job.options.onStart(context));
      }

      // Execute with executor (handles retry, timeout, circuit breaker)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const executorOptions = {
        timeout: job.options.timeout,
        maxRetries: job.options.maxRetries,
        retryDelay: job.options.retryDelay,
        retryBackoff: job.options.retryBackoff,
        enableCircuitBreaker: job.options.enableCircuitBreaker,
      };

      const result = await this.executor.execute(job.id, execId, job.fn, context);

      if (result.success) {
        // End execution tracking
        this.stateManager.endExecution(execId, 'completed');

        this.logger.info(`Job completed: ${job.name} (${execId})`, this.loggerContext, {
          duration: result.duration,
          attempts: result.attempts,
        });

        this.emit('job:complete', {
          jobId: job.id,
          executionId: execId,
          result: result.value,
          duration: result.duration,
        });

        // Call onComplete hook
        if (job.options.onComplete) {
          await Promise.resolve(job.options.onComplete(context, result.value));
        }
      } else {
        // End execution tracking with error
        const status = result.timedOut ? 'timeout' : 'failed';
        this.stateManager.endExecution(execId, status, result.error);

        this.logger.error(`Job failed: ${job.name} (${execId})`, this.loggerContext, {
          error: result.error?.message,
          duration: result.duration,
          attempts: result.attempts,
          timedOut: result.timedOut,
          circuitBreakerTripped: result.circuitBreakerTripped,
        });

        this.emit('job:error', {
          jobId: job.id,
          executionId: execId,
          error: result.error,
          duration: result.duration,
          timedOut: result.timedOut,
        });

        // Call onError hook
        if (job.options.onError && result.error) {
          await Promise.resolve(job.options.onError(context, result.error));
        }
      }

      return result;
    } finally {
      this.currentConcurrentJobs--;
      job.concurrentExecutions--;

      // Schedule next run (for recurring jobs)
      if (job.schedule.type !== 'oneTime') {
        job.nextRun = this.calculateNextRun(job);
        if (job.enabled && this.isLeader()) {
          this.scheduleJob(job);
        }
      } else {
        // One-time job, disable it
        job.enabled = false;
        this.stateManager.setJobEnabled(job.id, false);
      }

      // Process pending queue
      this.processPendingQueue();
    }
  }

  /**
   * Process pending queue
   */
  private processPendingQueue(): void {
    if (this.pendingQueue.length === 0) {
      return;
    }

    // Sort by priority (higher first)
    this.pendingQueue.sort((a, b) => b.job.priority - a.job.priority);

    while (this.pendingQueue.length > 0 && this.currentConcurrentJobs < this.maxConcurrentJobs) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const item = this.pendingQueue.shift()!;
      const { job, executionId } = item;

      // Check per-job concurrency limit
      const maxConcurrent = job.options.maxConcurrent ?? 1;
      if (job.concurrentExecutions < maxConcurrent) {
        this.executeJobAsync(job, executionId);
      } else {
        // Put back in queue
        this.pendingQueue.unshift(item);
        break;
      }
    }
  }

  /**
   * Check if this instance is the leader
   */
  private isLeader(): boolean {
    if (!this.leaderElection) {
      return true; // No leader election, always leader
    }
    return this.leaderElection.isCurrentLeader();
  }

  /**
   * Generate unique job ID
   */
  private generateJobId(): string {
    return `job_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }

  /**
   * Generate unique execution ID
   */
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }

  /**
   * Get scheduler stats
   */
  public getStats(): {
    totalJobs: number;
    enabledJobs: number;
    runningJobs: number;
    queuedJobs: number;
    isLeader: boolean;
    isStarted: boolean;
  } {
    return {
      totalJobs: this.jobs.size,
      enabledJobs: Array.from(this.jobs.values()).filter(j => j.enabled).length,
      runningJobs: this.currentConcurrentJobs,
      queuedJobs: this.pendingQueue.length,
      isLeader: this.isLeader(),
      isStarted: this.started,
    };
  }

  /**
   * Get job state
   */
  public getJobState(jobId: string) {
    return this.stateManager.getState(jobId);
  }

  /**
   * Get job history
   */
  public getJobHistory(jobId: string, limit?: number): JobExecution[] {
    return this.stateManager.getHistory(jobId, limit);
  }

  /**
   * Get job metrics
   */
  public getJobMetrics(jobId: string) {
    return this.stateManager.getMetrics(jobId);
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.logger.info('JobScheduler shutting down...', this.loggerContext, {
      runningJobs: this.currentConcurrentJobs,
      queuedJobs: this.pendingQueue.length,
    });

    this.isShuttingDown = true;

    // Unschedule all jobs
    this.unscheduleAllJobs();

    // Clear pending queue
    this.pendingQueue = [];

    // Wait for running jobs to complete
    const startTime = Date.now();
    while (
      this.currentConcurrentJobs > 0 &&
      Date.now() - startTime < this.gracefulShutdownTimeout
    ) {
      this.logger.debug(
        `Waiting for ${this.currentConcurrentJobs} running jobs to complete`,
        this.loggerContext
      );
      await this.sleep(1000);
    }

    if (this.currentConcurrentJobs > 0) {
      this.logger.warn(
        `Forcing shutdown with ${this.currentConcurrentJobs} jobs still running`,
        this.loggerContext
      );
    }

    // Shutdown components
    await Promise.all([
      this.executor.shutdown(5000),
      this.stateManager.shutdown(),
      this.leaderElection?.shutdown(),
    ]);

    this.started = false;
    this.removeAllListeners();

    this.logger.info('JobScheduler shutdown complete', this.loggerContext);
    this.emit('scheduler:shutdown');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

interface ExecutionResult {
  success: boolean;
  value?: any;
  error?: Error;
  attempts: number;
  duration: number;
  circuitBreakerTripped?: boolean;
  timedOut?: boolean;
}
