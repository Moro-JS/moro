// Production-grade Job State Management
// Handles job persistence, history, recovery, and crash resilience

import { EventEmitter } from 'events';
import { Logger } from '../../types/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface JobExecution {
  jobId: string;
  executionId: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  retryCount: number;
  memoryUsage?: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  metadata?: Record<string, any>;
}

export interface JobState {
  jobId: string;
  name: string;
  enabled: boolean;
  lastExecution?: JobExecution;
  nextRun?: Date;
  executionCount: number;
  failureCount: number;
  consecutiveFailures: number;
  averageDuration: number;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, any>;
}

export interface JobHistory {
  jobId: string;
  executions: JobExecution[];
  maxHistory: number;
}

export interface StateManagerOptions {
  persistPath?: string;
  historySize?: number;
  persistInterval?: number;
  enableAutoPersist?: boolean;
  enableRecovery?: boolean;
}

interface PersistedState {
  version: string;
  timestamp: Date;
  hostname: string;
  pid: number;
  jobs: Record<string, JobState>;
  runningJobs: string[];
}

/**
 * JobStateManager - Manages job state, history, and persistence
 * Provides crash recovery and state tracking
 */
export class JobStateManager extends EventEmitter {
  private states = new Map<string, JobState>();
  private history = new Map<string, JobHistory>();
  private runningExecutions = new Map<string, JobExecution>();
  private persistTimer?: NodeJS.Timeout;
  private persistPath?: string;
  private historySize: number;
  private enableAutoPersist: boolean;
  private enableRecovery: boolean;
  private persistInterval: number;
  private logger: Logger;
  private loggerContext = 'JobStateManager';
  private isDirty = false;

  constructor(logger: Logger, options: StateManagerOptions = {}) {
    super();
    this.logger = logger;
    this.historySize = options.historySize ?? 100;
    this.enableAutoPersist = options.enableAutoPersist ?? true;
    this.enableRecovery = options.enableRecovery ?? true;
    this.persistInterval = options.persistInterval ?? 30000; // 30s default

    // Setup persistence path
    if (options.persistPath) {
      this.persistPath = options.persistPath;
    } else {
      const tmpDir = os.tmpdir();
      this.persistPath = path.join(tmpDir, 'moro-jobs-state.json');
    }

    // Start auto-persist if enabled
    if (this.enableAutoPersist && this.persistPath) {
      this.startAutoPersist();
    }

    // Load persisted state if recovery enabled
    if (this.enableRecovery && this.persistPath) {
      this.loadState();
    }

    this.logger.debug('JobStateManager initialized', this.loggerContext, {
      persistPath: this.persistPath,
      historySize: this.historySize,
      enableAutoPersist: this.enableAutoPersist,
      enableRecovery: this.enableRecovery,
    });
  }

  /**
   * Register a new job
   */
  public registerJob(jobId: string, name: string, metadata?: Record<string, any>): JobState {
    const existing = this.states.get(jobId);
    if (existing) {
      this.logger.debug(`Job ${jobId} already registered, updating metadata`, this.loggerContext);
      existing.metadata = { ...existing.metadata, ...metadata };
      existing.updatedAt = new Date();
      this.isDirty = true;
      return existing;
    }

    const state: JobState = {
      jobId,
      name,
      enabled: true,
      executionCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      averageDuration: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata,
    };

    this.states.set(jobId, state);
    this.history.set(jobId, { jobId, executions: [], maxHistory: this.historySize });
    this.isDirty = true;

    this.logger.info(`Job registered: ${name} (${jobId})`, this.loggerContext);
    this.emit('job:registered', { jobId, name });

    return state;
  }

  /**
   * Unregister a job
   */
  public unregisterJob(jobId: string): boolean {
    const state = this.states.get(jobId);
    if (!state) {
      return false;
    }

    // Cancel running execution if any
    const runningExecution = this.getRunningExecution(jobId);
    if (runningExecution) {
      this.endExecution(runningExecution.executionId, 'cancelled');
    }

    this.states.delete(jobId);
    this.history.delete(jobId);
    this.isDirty = true;

    this.logger.info(`Job unregistered: ${state.name} (${jobId})`, this.loggerContext);
    this.emit('job:unregistered', { jobId, name: state.name });

    return true;
  }

  /**
   * Start job execution tracking
   */
  public startExecution(
    jobId: string,
    executionId: string,
    metadata?: Record<string, any>
  ): JobExecution {
    const state = this.states.get(jobId);
    if (!state) {
      throw new Error(`Job ${jobId} not found`);
    }

    const execution: JobExecution = {
      jobId,
      executionId,
      startTime: new Date(),
      status: 'running',
      retryCount: 0,
      metadata,
    };

    this.runningExecutions.set(executionId, execution);
    state.executionCount++;
    state.updatedAt = new Date();
    this.isDirty = true;

    this.logger.debug(`Execution started: ${state.name} (${executionId})`, this.loggerContext);
    this.emit('execution:start', { jobId, executionId, execution });

    return execution;
  }

  /**
   * End job execution tracking
   */
  public endExecution(
    executionId: string,
    status: 'completed' | 'failed' | 'timeout' | 'cancelled',
    error?: Error
  ): JobExecution | null {
    const execution = this.runningExecutions.get(executionId);
    if (!execution) {
      this.logger.warn(`Execution ${executionId} not found`, this.loggerContext);
      return null;
    }

    const endTime = new Date();
    execution.endTime = endTime;
    execution.duration = endTime.getTime() - execution.startTime.getTime();
    execution.status = status;

    // Capture memory usage
    const memUsage = process.memoryUsage();
    execution.memoryUsage = {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
    };

    if (error) {
      execution.error = {
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      };
    }

    // Update job state
    const state = this.states.get(execution.jobId);
    if (state) {
      state.lastExecution = execution;
      state.updatedAt = new Date();

      // Update statistics
      if (status === 'failed' || status === 'timeout') {
        state.failureCount++;
        state.consecutiveFailures++;
      } else if (status === 'completed') {
        state.consecutiveFailures = 0;

        // Update average duration (rolling average)
        const alpha = 0.2; // Smoothing factor
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        state.averageDuration = alpha * execution.duration! + (1 - alpha) * state.averageDuration;
      }

      // Add to history
      this.addToHistory(execution);
    }

    this.runningExecutions.delete(executionId);
    this.isDirty = true;

    this.logger.debug(
      `Execution ended: ${execution.jobId} (${executionId}) - ${status}`,
      this.loggerContext,
      {
        duration: execution.duration,
      }
    );

    this.emit('execution:end', { jobId: execution.jobId, executionId, execution, status });

    return execution;
  }

  /**
   * Update execution (e.g., for retry count)
   */
  public updateExecution(executionId: string, updates: Partial<JobExecution>): void {
    const execution = this.runningExecutions.get(executionId);
    if (!execution) {
      return;
    }

    Object.assign(execution, updates);
    this.isDirty = true;
  }

  /**
   * Add execution to history
   */
  private addToHistory(execution: JobExecution): void {
    const history = this.history.get(execution.jobId);
    if (!history) {
      return;
    }

    // Add to front
    history.executions.unshift(execution);

    // Trim to max size
    if (history.executions.length > history.maxHistory) {
      history.executions = history.executions.slice(0, history.maxHistory);
    }
  }

  /**
   * Get job state
   */
  public getState(jobId: string): JobState | undefined {
    return this.states.get(jobId);
  }

  /**
   * Get all job states
   */
  public getAllStates(): JobState[] {
    return Array.from(this.states.values());
  }

  /**
   * Get job history
   */
  public getHistory(jobId: string, limit?: number): JobExecution[] {
    const history = this.history.get(jobId);
    if (!history) {
      return [];
    }

    if (limit) {
      return history.executions.slice(0, limit);
    }

    return [...history.executions];
  }

  /**
   * Get running execution for job
   */
  public getRunningExecution(jobId: string): JobExecution | undefined {
    for (const execution of this.runningExecutions.values()) {
      if (execution.jobId === jobId) {
        return execution;
      }
    }
    return undefined;
  }

  /**
   * Get all running executions
   */
  public getRunningExecutions(): JobExecution[] {
    return Array.from(this.runningExecutions.values());
  }

  /**
   * Check if job is currently running
   */
  public isRunning(jobId: string): boolean {
    return this.getRunningExecution(jobId) !== undefined;
  }

  /**
   * Enable/disable job
   */
  public setJobEnabled(jobId: string, enabled: boolean): boolean {
    const state = this.states.get(jobId);
    if (!state) {
      return false;
    }

    state.enabled = enabled;
    state.updatedAt = new Date();
    this.isDirty = true;

    this.logger.info(
      `Job ${enabled ? 'enabled' : 'disabled'}: ${state.name} (${jobId})`,
      this.loggerContext
    );
    this.emit('job:enabled', { jobId, enabled });

    return true;
  }

  /**
   * Update next run time
   */
  public setNextRun(jobId: string, nextRun: Date): void {
    const state = this.states.get(jobId);
    if (!state) {
      return;
    }

    state.nextRun = nextRun;
    state.updatedAt = new Date();
    this.isDirty = true;
  }

  /**
   * Get job metrics
   */
  public getMetrics(jobId: string): {
    successRate: number;
    failureRate: number;
    averageDuration: number;
    totalExecutions: number;
    recentFailures: number;
  } | null {
    const state = this.states.get(jobId);
    if (!state) {
      return null;
    }

    const totalExecutions = state.executionCount;
    const failureCount = state.failureCount;
    const successCount = totalExecutions - failureCount;

    return {
      successRate: totalExecutions > 0 ? (successCount / totalExecutions) * 100 : 0,
      failureRate: totalExecutions > 0 ? (failureCount / totalExecutions) * 100 : 0,
      averageDuration: state.averageDuration,
      totalExecutions,
      recentFailures: state.consecutiveFailures,
    };
  }

  /**
   * Start auto-persist timer
   */
  private startAutoPersist(): void {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setInterval(() => {
      if (this.isDirty) {
        this.persistState().catch(error => {
          this.logger.error('Failed to auto-persist job state', this.loggerContext, { error });
        });
      }
    }, this.persistInterval);

    // Don't keep process alive for this timer
    this.persistTimer.unref();
  }

  /**
   * Stop auto-persist timer
   */
  private stopAutoPersist(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = undefined;
    }
  }

  /**
   * Persist state to disk
   */
  public async persistState(): Promise<void> {
    if (!this.persistPath) {
      return;
    }

    try {
      const stateData: PersistedState = {
        version: '1.0.0',
        timestamp: new Date(),
        hostname: os.hostname(),
        pid: process.pid,
        jobs: Object.fromEntries(this.states),
        runningJobs: Array.from(this.runningExecutions.keys()),
      };

      const json = JSON.stringify(stateData, null, 2);
      const tempPath = `${this.persistPath}.tmp`;

      // Write to temp file first, then rename (atomic operation)
      await fs.promises.writeFile(tempPath, json, 'utf-8');
      await fs.promises.rename(tempPath, this.persistPath);

      this.isDirty = false;
      this.logger.debug('Job state persisted', this.loggerContext, { path: this.persistPath });
    } catch (error) {
      this.logger.error('Failed to persist job state', this.loggerContext, {
        error,
        path: this.persistPath,
      });
      throw error;
    }
  }

  /**
   * Load state from disk
   */
  public async loadState(): Promise<void> {
    if (!this.persistPath) {
      return;
    }

    try {
      const exists = await fs.promises
        .access(this.persistPath)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        this.logger.debug('No persisted state found', this.loggerContext, {
          path: this.persistPath,
        });
        return;
      }

      const json = await fs.promises.readFile(this.persistPath, 'utf-8');
      const stateData: PersistedState = JSON.parse(json);

      // Restore job states
      for (const [jobId, state] of Object.entries(stateData.jobs)) {
        // Convert date strings back to Date objects
        state.createdAt = new Date(state.createdAt);
        state.updatedAt = new Date(state.updatedAt);
        if (state.nextRun) {
          state.nextRun = new Date(state.nextRun);
        }
        if (state.lastExecution) {
          state.lastExecution.startTime = new Date(state.lastExecution.startTime);
          if (state.lastExecution.endTime) {
            state.lastExecution.endTime = new Date(state.lastExecution.endTime);
          }
        }

        this.states.set(jobId, state);
      }

      // Handle crashed jobs (were running but no longer are)
      const crashedJobs = stateData.runningJobs.filter(id => this.states.has(id));
      if (crashedJobs.length > 0) {
        this.logger.warn(
          `Detected ${crashedJobs.length} jobs that were running during crash`,
          this.loggerContext,
          {
            jobs: crashedJobs,
          }
        );
        this.emit('recovery:crashed-jobs', { jobs: crashedJobs });
      }

      this.logger.info(`Job state loaded: ${this.states.size} jobs restored`, this.loggerContext, {
        path: this.persistPath,
        crashedJobs: crashedJobs.length,
      });
    } catch (error) {
      this.logger.error('Failed to load job state', this.loggerContext, {
        error,
        path: this.persistPath,
      });
      // Don't throw - we can continue without persisted state
    }
  }

  /**
   * Clear all state
   */
  public clear(): void {
    this.states.clear();
    this.history.clear();
    this.runningExecutions.clear();
    this.isDirty = true;
    this.logger.debug('Job state cleared', this.loggerContext);
  }

  /**
   * Cleanup and shutdown
   */
  public async shutdown(): Promise<void> {
    this.logger.info('JobStateManager shutting down...', this.loggerContext);

    this.stopAutoPersist();

    // Persist final state
    if (this.isDirty && this.persistPath) {
      await this.persistState();
    }

    this.removeAllListeners();
    this.logger.info('JobStateManager shutdown complete', this.loggerContext);
  }
}
