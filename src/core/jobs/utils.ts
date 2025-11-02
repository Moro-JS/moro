// Job Utilities and Helper Functions
// Health checks, monitoring, and convenience functions

import { Logger } from '../../types/logger.js';
import { JobScheduler } from './job-scheduler.js';
import { JobHealth, JobHealthStatus, SchedulerStats } from './types.js';

/**
 * JobHealthChecker - Monitors job health and provides status
 */
export class JobHealthChecker {
  private scheduler: JobScheduler;
  private logger: Logger;

  constructor(scheduler: JobScheduler, logger: Logger) {
    this.scheduler = scheduler;
    this.logger = logger;
  }

  /**
   * Check health of a specific job
   */
  public checkJobHealth(jobId: string): JobHealth {
    const job = this.scheduler.getJob(jobId);
    if (!job) {
      return {
        jobId,
        name: 'Unknown',
        status: 'unknown',
        enabled: false,
        consecutiveFailures: 0,
        message: 'Job not found',
      };
    }

    const state = this.scheduler.getJobState(jobId);
    const metrics = this.scheduler.getJobMetrics(jobId);

    let status: JobHealthStatus = 'healthy';
    let message: string | undefined;

    if (!job.enabled) {
      status = 'warning';
      message = 'Job is disabled';
    } else if (state?.consecutiveFailures && state.consecutiveFailures >= 5) {
      status = 'critical';
      message = `${state.consecutiveFailures} consecutive failures`;
    } else if (state?.consecutiveFailures && state.consecutiveFailures >= 3) {
      status = 'warning';
      message = `${state.consecutiveFailures} consecutive failures`;
    } else if (metrics && metrics.failureRate > 50) {
      status = 'warning';
      message = `High failure rate: ${metrics.failureRate.toFixed(1)}%`;
    }

    return {
      jobId,
      name: job.name,
      status,
      enabled: job.enabled,
      lastExecution: state?.lastExecution?.startTime,
      lastSuccess:
        state?.lastExecution?.status === 'completed' ? state.lastExecution.endTime : undefined,
      consecutiveFailures: state?.consecutiveFailures || 0,
      nextRun: job.nextRun,
      message,
    };
  }

  /**
   * Check health of all jobs
   */
  public checkAllJobs(): JobHealth[] {
    const jobs = this.scheduler.getAllJobs();
    return jobs.map(job => this.checkJobHealth(job.id));
  }

  /**
   * Get overall scheduler health
   */
  public getSchedulerHealth(): {
    status: JobHealthStatus;
    stats: SchedulerStats;
    jobs: JobHealth[];
    unhealthyJobCount: number;
    message?: string;
  } {
    const stats = this.scheduler.getStats();
    const jobHealths = this.checkAllJobs();

    const unhealthyJobs = jobHealths.filter(h => h.status === 'critical' || h.status === 'warning');

    let status: JobHealthStatus = 'healthy';
    let message: string | undefined;

    if (!stats.isStarted) {
      status = 'critical';
      message = 'Scheduler not started';
    } else if (!stats.isLeader) {
      status = 'warning';
      message = 'Not leader (standby mode)';
    } else if (unhealthyJobs.filter(h => h.status === 'critical').length > 0) {
      status = 'critical';
      message = `${unhealthyJobs.filter(h => h.status === 'critical').length} critical jobs`;
    } else if (unhealthyJobs.length > 0) {
      status = 'warning';
      message = `${unhealthyJobs.length} unhealthy jobs`;
    }

    return {
      status,
      stats,
      jobs: jobHealths,
      unhealthyJobCount: unhealthyJobs.length,
      message,
    };
  }
}

/**
 * Parse interval string to milliseconds
 * Supports: '5s', '10m', '2h', '1d'
 */
export function parseInterval(interval: string | number): number {
  if (typeof interval === 'number') {
    return interval;
  }

  const match = interval.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!match) {
    throw new Error(`Invalid interval format: "${interval}". Use format like: 5s, 10m, 2h, 1d`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
  };

  return value * multipliers[unit];
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Create a simple interval-based job schedule
 */
export function everyInterval(interval: string | number) {
  return {
    type: 'interval' as const,
    interval: parseInterval(interval),
  };
}

/**
 * Create a cron-based job schedule
 */
export function cronSchedule(expression: string, timezone?: string) {
  return {
    type: 'cron' as const,
    cron: expression,
    timezone,
  };
}

/**
 * Create a one-time job schedule
 */
export function oneTimeAt(date: Date) {
  return {
    type: 'oneTime' as const,
    at: date,
  };
}

/**
 * Job builder for fluent API
 */
export class JobBuilder {
  private _name?: string;
  private _schedule?: any;
  private _options: any = {};

  public name(name: string): this {
    this._name = name;
    return this;
  }

  public every(interval: string | number): this {
    this._schedule = everyInterval(interval);
    return this;
  }

  public cron(expression: string, timezone?: string): this {
    this._schedule = cronSchedule(expression, timezone);
    return this;
  }

  public at(date: Date): this {
    this._schedule = oneTimeAt(date);
    return this;
  }

  public enabled(enabled: boolean): this {
    this._options.enabled = enabled;
    return this;
  }

  public priority(priority: number): this {
    this._options.priority = priority;
    return this;
  }

  public maxConcurrent(max: number): this {
    this._options.maxConcurrent = max;
    return this;
  }

  public timeout(ms: number): this {
    this._options.timeout = ms;
    return this;
  }

  public retry(options: {
    maxRetries?: number;
    delay?: number;
    backoff?: 'linear' | 'exponential';
  }): this {
    this._options.maxRetries = options.maxRetries;
    this._options.retryDelay = options.delay;
    this._options.retryBackoff = options.backoff;
    return this;
  }

  public circuitBreaker(enabled: boolean): this {
    this._options.enableCircuitBreaker = enabled;
    return this;
  }

  public metadata(metadata: Record<string, any>): this {
    this._options.metadata = metadata;
    return this;
  }

  public onStart(fn: (ctx: any) => void | Promise<void>): this {
    this._options.onStart = fn;
    return this;
  }

  public onComplete(fn: (ctx: any, result: any) => void | Promise<void>): this {
    this._options.onComplete = fn;
    return this;
  }

  public onError(fn: (ctx: any, error: Error) => void | Promise<void>): this {
    this._options.onError = fn;
    return this;
  }

  public build(): { name: string; schedule: any; options: any } {
    if (!this._name) {
      throw new Error('Job name is required');
    }
    if (!this._schedule) {
      throw new Error('Job schedule is required');
    }

    return {
      name: this._name,
      schedule: this._schedule,
      options: this._options,
    };
  }
}

/**
 * Create a job builder
 */
export function createJob(name: string): JobBuilder {
  return new JobBuilder().name(name);
}
