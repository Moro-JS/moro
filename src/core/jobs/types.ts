// Job System Types
// Complete type definitions for the job scheduling system

export type { CronSchedule, NextRunResult } from './cron-parser.js';
export type {
  JobExecution,
  JobState,
  JobHistory,
  StateManagerOptions,
} from './job-state-manager.js';
export type { LeaderElectionOptions, LeaderInfo } from './leader-election.js';
export type {
  JobExecutorOptions,
  JobFunction,
  ExecutionContext,
  ExecutionResult,
} from './job-executor.js';
export type {
  JobScheduleType,
  JobSchedule,
  JobOptions,
  Job,
  JobSchedulerOptions,
} from './job-scheduler.js';

// Simplified API types for users
export interface SimpleJobOptions {
  name?: string;
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
  onStart?: (context: JobContext) => void | Promise<void>;
  onComplete?: (context: JobContext, result: any) => void | Promise<void>;
  onError?: (context: JobContext, error: Error) => void | Promise<void>;
}

export interface JobContext {
  jobId: string;
  executionId: string;
  attempt: number;
  startTime: Date;
  metadata?: Record<string, any>;
}

export interface JobMetrics {
  successRate: number;
  failureRate: number;
  averageDuration: number;
  totalExecutions: number;
  recentFailures: number;
}

export interface SchedulerStats {
  totalJobs: number;
  enabledJobs: number;
  runningJobs: number;
  queuedJobs: number;
  isLeader: boolean;
  isStarted: boolean;
}

// Job health status
export type JobHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface JobHealth {
  jobId: string;
  name: string;
  status: JobHealthStatus;
  enabled: boolean;
  lastExecution?: Date;
  lastSuccess?: Date;
  consecutiveFailures: number;
  circuitBreakerState?: 'open' | 'half-open' | 'closed';
  nextRun?: Date;
  message?: string;
}

// Job event types
export interface JobEvents {
  'scheduler:started': { jobCount: number; isLeader: boolean };
  'scheduler:shutdown': Record<string, never>;
  'job:registered': { jobId: string; name: string; schedule: any };
  'job:unregistered': { jobId: string; name: string };
  'job:enabled': { jobId: string; enabled: boolean };
  'job:queued': { jobId: string; executionId: string; queueLength: number };
  'job:start': { jobId: string; executionId: string; context: any };
  'job:complete': { jobId: string; executionId: string; result: any; duration: number };
  'job:error': {
    jobId: string;
    executionId: string;
    error: Error;
    duration: number;
    timedOut?: boolean;
  };
  'leader:elected': { instanceId: string; electedAt?: Date };
  'leader:stepdown': { instanceId: string };
  'leader:heartbeat': { instanceId: string; timestamp: Date };
  'leader:unhealthy': { leader: string; heartbeatAge: number };
  'execution:success': { jobId: string; executionId: string; attempts: number; duration: number };
  'execution:failed': {
    jobId: string;
    executionId: string;
    attempts: number;
    duration: number;
    error: Error;
  };
  'execution:retry': {
    jobId: string;
    executionId: string;
    attempt: number;
    maxAttempts: number;
    error: Error;
  };
  'execution:cancelled': { executionId: string };
  'circuit-breaker:open': { jobId: string };
  'circuit-breaker:half-open': { jobId: string };
  'circuit-breaker:closed': { jobId: string };
  'memory:threshold-exceeded': { jobId: string; heapUsedMB: number; threshold: number };
}
