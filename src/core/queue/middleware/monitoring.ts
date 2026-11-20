/**
 * Monitoring Middleware for Queue Processing
 * Collects metrics and tracks job performance
 */

import type { JobHandler, JobContext } from '../types.js';

/**
 * Job execution metrics
 */
export interface JobMetrics {
  jobId: string;
  queueName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  success: boolean;
  error?: string | undefined;
  attemptsMade: number;
  memoryUsage?: NodeJS.MemoryUsage;
}

/** Per-job records a collector keeps unless told otherwise. */
const DEFAULT_MAX_JOB_METRICS = 1000;

/**
 * Queue metrics collector
 */
export class QueueMetricsCollector {
  private metrics: Map<string, JobMetrics> = new Map();
  private aggregatedStats: Map<string, QueueStats> = new Map();
  private maxJobMetrics: number;

  /**
   * `maxJobMetrics` is how many per-job records are kept, most recent first
   * (default 1000; `Infinity` keeps every one). The aggregated statistics per
   * queue count every job, whatever this is.
   */
  constructor(options: { maxJobMetrics?: number } = {}) {
    const max = options.maxJobMetrics;
    this.maxJobMetrics = typeof max === 'number' && max >= 0 ? max : DEFAULT_MAX_JOB_METRICS;
  }

  /**
   * Record job start
   */
  recordStart(jobId: string, queueName: string, attemptsMade: number): void {
    // Newest last (a Map iterates in insertion order); a job that runs again
    // moves to the end. The oldest finished records make room for a new one;
    // a job that is still running keeps its record so its result is counted.
    this.metrics.delete(jobId);
    while (this.metrics.size >= this.maxJobMetrics && this.metrics.size > 0) {
      let oldest: string | undefined;
      for (const [id, metric] of this.metrics) {
        if (metric.endTime !== undefined) {
          oldest = id;
          break;
        }
      }
      if (oldest === undefined) break;
      this.metrics.delete(oldest);
    }
    this.metrics.set(jobId, {
      jobId,
      queueName,
      startTime: Date.now(),
      success: false,
      attemptsMade,
      memoryUsage: process.memoryUsage(),
    });
  }

  /**
   * Record job completion
   */
  recordCompletion(jobId: string, success: boolean, error?: string): void {
    const metric = this.metrics.get(jobId);
    if (!metric) {
      return;
    }

    metric.endTime = Date.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.success = success;
    metric.error = error;

    // Update aggregated stats
    this.updateStats(metric);
  }

  /**
   * Get metrics for a specific job
   */
  getJobMetrics(jobId: string): JobMetrics | undefined {
    return this.metrics.get(jobId);
  }

  /**
   * Get aggregated stats for a queue
   */
  getQueueStats(queueName: string): QueueStats | undefined {
    return this.aggregatedStats.get(queueName);
  }

  /**
   * Get all queue stats
   */
  getAllStats(): Map<string, QueueStats> {
    return new Map(this.aggregatedStats);
  }

  /**
   * Clear old metrics (keep last N)
   */
  cleanup(maxMetrics: number = 1000): void {
    if (this.metrics.size <= maxMetrics) {
      return;
    }

    const metricsArray = Array.from(this.metrics.entries());
    const toKeep = metricsArray.slice(-maxMetrics);
    this.metrics = new Map(toKeep);
  }

  /**
   * Update aggregated statistics
   */
  private updateStats(metric: JobMetrics): void {
    const queueName = metric.queueName;
    let stats = this.aggregatedStats.get(queueName);

    if (!stats) {
      stats = {
        queueName,
        totalJobs: 0,
        successfulJobs: 0,
        failedJobs: 0,
        totalDuration: 0,
        averageDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
        lastUpdated: Date.now(),
      };
      this.aggregatedStats.set(queueName, stats);
    }

    stats.totalJobs++;
    if (metric.success) {
      stats.successfulJobs++;
    } else {
      stats.failedJobs++;
    }

    if (metric.duration !== undefined) {
      stats.totalDuration += metric.duration;
      stats.averageDuration = stats.totalDuration / stats.totalJobs;
      stats.minDuration = Math.min(stats.minDuration, metric.duration);
      stats.maxDuration = Math.max(stats.maxDuration, metric.duration);
    }

    stats.lastUpdated = Date.now();
  }
}

/**
 * Aggregated queue statistics
 */
export interface QueueStats {
  queueName: string;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  totalDuration: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  lastUpdated: number;
}

/**
 * Monitoring middleware options
 */
export interface MonitoringOptions {
  collector?: QueueMetricsCollector;
  logMetrics?: boolean;
  trackMemory?: boolean;
}

/**
 * Create a monitoring middleware
 */
export function createMonitoringMiddleware<T = any, R = any>(
  handler: JobHandler<T, R>,
  options: MonitoringOptions = {}
): JobHandler<T, R> {
  const collector = options.collector || new QueueMetricsCollector();

  return async (job: JobContext<T>): Promise<R> => {
    // Record start
    collector.recordStart(job.id, job.name, job.attemptsMade);

    const startTime = Date.now();
    const startMemory = options.trackMemory ? process.memoryUsage() : null;

    try {
      const result = await handler(job);

      // Record success
      collector.recordCompletion(job.id, true);

      if (options.logMetrics) {
        const duration = Date.now() - startTime;
        job.log(`Job completed in ${duration}ms`);

        if (startMemory && options.trackMemory) {
          const endMemory = process.memoryUsage();
          const heapDiff = endMemory.heapUsed - startMemory.heapUsed;
          job.log(`Heap usage: ${(heapDiff / 1024 / 1024).toFixed(2)}MB`);
        }
      }

      return result;
    } catch (error) {
      // Record failure
      const errorMessage = error instanceof Error ? error.message : String(error);
      collector.recordCompletion(job.id, false, errorMessage);

      if (options.logMetrics) {
        const duration = Date.now() - startTime;
        job.log(`Job failed after ${duration}ms: ${errorMessage}`);
      }

      throw error;
    }
  };
}

/**
 * Global metrics collector instance
 */
export const globalMetricsCollector = new QueueMetricsCollector();
