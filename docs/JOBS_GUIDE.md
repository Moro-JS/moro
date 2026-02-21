# MoroJS Jobs - Production-Grade Background Job Scheduling

## Overview

MoroJS now includes a built-in, zero-dependency job scheduling system for background tasks. Inspired by enterprise cron systems, it provides resilience, observability, and distributed system support out of the box.

## Quick Start

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  jobs: {
    enabled: true, // Enable job scheduler
  },
});

// Simple cron job - runs daily at 2 AM
app.job('cleanup-old-data', '0 2 * * *', async () => {
  await database.cleanupOldRecords();
});

// Interval-based job - runs every 5 minutes
app.job('health-check', '5m', async ctx => {
  console.log(`Health check ${ctx.executionId}`);
  await checkSystemHealth();
});

// Advanced configuration
app.job(
  'generate-report',
  '@daily',
  async ctx => {
    const report = await generateDailyReport();
    return report;
  },
  {
    timeout: 60000, // 1 minute timeout
    maxRetries: 3,
    retryBackoff: 'exponential',
    priority: 10, // Higher priority
    onError: (ctx, error) => {
      console.error(`Report generation failed`, error);
    },
  }
);

app.listen(3000);
```

## Features

### Production-Ready Resilience

- **Automatic Retries**: Configurable retry logic with exponential backoff + jitter
- **Circuit Breaker**: Per-job circuit breakers prevent cascading failures
- **Timeout Enforcement**: Jobs that hang are automatically cancelled
- **Memory Monitoring**: Detects and prevents memory leaks in long-running jobs
- **Graceful Shutdown**: Waits for running jobs to complete before shutdown

### Distributed Systems Support

- **Leader Election**: File-based or Redis-based leader election
- **K8s Awareness**: Automatically detects Kubernetes environments
- **Cluster Mode**: Only runs jobs on primary process/worker
- **Crash Recovery**: Restores job state and resumes after crashes

### Observability

- **Full Metrics**: Track executions, failures, duration, memory usage
- **Event Emission**: Subscribe to all job lifecycle events
- **Health Checks**: Built-in health status monitoring
- **Execution History**: Maintains history of past job executions
- **State Persistence**: Optional job state persistence to disk

### Flexible Scheduling

- **Cron Expressions**: Standard 5-field cron syntax + macros
- **Interval-Based**: Simple interval strings (`'5m'`, `'1h'`, `'30s'`)
- **One-Time Jobs**: Schedule for a specific date/time
- **Timezone Support**: Run jobs in any timezone

## Schedule Formats

### Cron Expressions

```typescript
// Standard cron (minute hour day month weekday)
app.job('backup', '0 3 * * *', backupDatabase); // Daily at 3 AM
app.job('report', '0 9 * * 1', weeklyReport); // Mondays at 9 AM

// Cron macros
app.job('hourly-task', '@hourly', task);
app.job('daily-task', '@daily', task);
app.job('weekly-task', '@weekly', task);
app.job('monthly-task', '@monthly', task);
```

### Interval Strings

```typescript
app.job('health-check', '5m', healthCheck); // Every 5 minutes
app.job('cache-cleanup', '1h', cleanCache); // Every hour
app.job('quick-task', '30s', quickTask); // Every 30 seconds
app.job('nightly-job', '1d', nightlyJob); // Every day
```

### Programmatic Schedules

```typescript
import { everyInterval, cronSchedule, oneTimeAt } from '@morojs/moro';

// Interval-based
app.job('task1', everyInterval('10m'), handler);

// Cron-based with timezone
app.job('task2', cronSchedule('0 9 * * *', 'America/New_York'), handler);

// One-time execution
const futureDate = new Date('2025-12-25T00:00:00Z');
app.job('task3', oneTimeAt(futureDate), handler);
```

## Configuration

### Basic Configuration

```typescript
const app = await createApp({
  jobs: {
    enabled: true,
    maxConcurrentJobs: 10,
    gracefulShutdownTimeout: 30000,
  },
});
```

### Leader Election (for distributed systems)

```typescript
const app = await createApp({
  jobs: {
    enabled: true,
    leaderElection: {
      enabled: true,
      strategy: 'file', // 'file' | 'redis' | 'none'
      lockPath: '/tmp/moro-jobs-leader.lock',
      lockTimeout: 30000,
      heartbeatInterval: 10000,
    },
  },
});
```

### Job Execution Options

```typescript
const app = await createApp({
  jobs: {
    enabled: true,
    executor: {
      maxRetries: 3,
      retryDelay: 1000,
      retryBackoff: 'exponential',
      timeout: 300000, // 5 minutes
      enableCircuitBreaker: true,
      enableMemoryMonitoring: true,
    },
  },
});
```

### State Management

```typescript
const app = await createApp({
  jobs: {
    enabled: true,
    stateManager: {
      persistPath: './data/jobs-state.json',
      historySize: 100,
      persistInterval: 30000,
      enableAutoPersist: true,
      enableRecovery: true,
    },
  },
});
```

## Job Management

### Register a Job

```typescript
const jobId = app.job('my-job', '*/5 * * * *', handler, {
  name: 'My Custom Job Name',
  enabled: true,
  priority: 5,
  maxConcurrent: 1,
  timeout: 60000,
  maxRetries: 3,
  metadata: { owner: 'team-a' },
});
```

### Enable/Disable Jobs

```typescript
app.setJobEnabled(jobId, false); // Disable job
app.setJobEnabled(jobId, true); // Enable job
```

### Manually Trigger a Job

```typescript
await app.triggerJob(jobId, { reason: 'manual-trigger' });
```

### Unregister a Job

```typescript
app.unregisterJob(jobId);
```

## Monitoring & Observability

### Get Job Metrics

```typescript
const metrics = app.getJobMetrics(jobId);
console.log(metrics);
// {
//   successRate: 98.5,
//   failureRate: 1.5,
//   averageDuration: 1234,
//   totalExecutions: 200,
//   recentFailures: 0
// }
```

### Check Job Health

```typescript
const health = app.getJobHealth(jobId);
console.log(health);
// {
//   jobId: 'job_...',
//   name: 'cleanup-old-data',
//   status: 'healthy',
//   enabled: true,
//   lastExecution: Date,
//   consecutiveFailures: 0,
//   nextRun: Date
// }
```

### Get Scheduler Statistics

```typescript
const stats = app.getJobStats();
console.log(stats);
// {
//   totalJobs: 5,
//   enabledJobs: 4,
//   runningJobs: 2,
//   queuedJobs: 0,
//   isLeader: true,
//   isStarted: true
// }
```

### Subscribe to Events

```typescript
app.on('job:start', ({ jobId, executionId }) => {
  console.log(`Job ${jobId} started: ${executionId}`);
});

app.on('job:complete', ({ jobId, result, duration }) => {
  console.log(`Job ${jobId} completed in ${duration}ms`);
});

app.on('job:error', ({ jobId, error }) => {
  console.error(`Job ${jobId} failed:`, error);
});

app.on('circuit-breaker:open', ({ jobId }) => {
  console.error(`Circuit breaker opened for job ${jobId}`);
});
```

## Job Lifecycle Hooks

```typescript
app.job(
  'my-job',
  '*/5 * * * *',
  async ctx => {
    // Main job logic
    const result = await processData();
    return result;
  },
  {
    onStart: async ctx => {
      console.log(`Job starting: ${ctx.executionId}`);
      // Initialize resources
    },
    onComplete: async (ctx, result) => {
      console.log(`Job completed successfully`);
      // Cleanup resources
    },
    onError: async (ctx, error) => {
      console.error(`Job failed`, error);
      // Send alerts, log errors, etc.
    },
  }
);
```

## Advanced Features

### Priority Queue

Jobs with higher priority execute first:

```typescript
app.job('critical-task', '*/1 * * * *', criticalTask, { priority: 10 });
app.job('normal-task', '*/1 * * * *', normalTask, { priority: 5 });
app.job('low-priority', '*/1 * * * *', lowPriorityTask, { priority: 1 });
```

### Concurrency Control

```typescript
// Global concurrency limit (in config)
const app = await createApp({
  jobs: { maxConcurrentJobs: 10 },
});

// Per-job concurrency limit
app.job('scraper', '*/5 * * * *', scrape, {
  maxConcurrent: 3, // Allow up to 3 concurrent executions
});
```

### Circuit Breaker

Automatically stops retrying failing jobs:

```typescript
app.job('flaky-api', '*/1 * * * *', callFlakyAPI, {
  enableCircuitBreaker: true,
  maxRetries: 5,
});

// Circuit breaker opens after 5 consecutive failures
// Jobs won't execute until circuit breaker resets (60s default)
```

### Memory Monitoring

Prevents memory leaks in long-running jobs:

```typescript
const app = await createApp({
  jobs: {
    executor: {
      enableMemoryMonitoring: true,
      memoryThreshold: 512, // MB
    },
  },
});

// Job execution stops if heap usage exceeds threshold
// Automatic garbage collection is triggered when near threshold
```

## Best Practices

### 1. Use Idempotent Jobs

Jobs may retry on failure, so ensure they can run multiple times safely:

```typescript
app.job('process-orders', '*/5 * * * *', async () => {
  const unprocessedOrders = await getUnprocessedOrders();
  for (const order of unprocessedOrders) {
    // Process each order idempotently
    await processOrder(order);
  }
});
```

### 2. Set Appropriate Timeouts

```typescript
app.job('long-report', '@daily', generateReport, {
  timeout: 3600000, // 1 hour for long-running reports
});

app.job('quick-check', '*/1 * * * *', quickHealthCheck, {
  timeout: 5000, // 5 seconds for quick checks
});
```

### 3. Monitor Job Health

```typescript
// Expose health endpoint
app.get('/health/jobs', (req, res) => {
  const health = app.getSchedulerHealth();
  res.json(health);
});
```

### 4. Use Leader Election in Distributed Systems

```typescript
// Kubernetes deployment
const app = await createApp({
  jobs: {
    leaderElection: {
      enabled: true,
      strategy: 'file', // Works with shared volumes
      lockPath: '/shared/jobs-leader.lock',
    },
  },
});
```

### 5. Handle Errors Gracefully

```typescript
app.job(
  'important-task',
  '@hourly',
  async () => {
    try {
      await criticalOperation();
    } catch (error) {
      // Log error but don't throw - prevents infinite retries
      logger.error('Critical operation failed', error);
      await sendAlert(error);
    }
  },
  {
    onError: async (ctx, error) => {
      await notifyTeam(error);
    },
  }
);
```

## Troubleshooting

### Jobs Not Running

1. Check if scheduler is started: `app.getJobStats().isStarted`
2. Check if job is enabled: `app.getJobHealth(jobId).enabled`
3. Check leader election: `app.getJobStats().isLeader`
4. Check circuit breaker: `app.getJobHealth(jobId).circuitBreakerState`

### High Memory Usage

1. Enable memory monitoring in config
2. Check job execution history for memory leaks
3. Use `onComplete` hooks to clean up resources

### Jobs Failing Repeatedly

1. Check job metrics: `app.getJobMetrics(jobId)`
2. Review error logs in job history
3. Consider circuit breaker to prevent cascading failures

## Architecture

The job system is built with production-grade components:

- **CronParser**: Zero-dependency cron expression parser with macro support
- **JobScheduler**: Main scheduler with priority queue and concurrency control
- **JobExecutor**: Handles retries, timeouts, circuit breakers, memory monitoring
- **JobStateManager**: Manages job state, history, and crash recovery
- **LeaderElection**: Distributed leader election for clustered deployments
- **JobHealthChecker**: Monitors job health and provides status information

All components emit events for full observability and can be independently configured.

## Zero Dependencies

The entire job system is built without external dependencies, maintaining MoroJS's zero-dependency philosophy for core functionality.

---

Built with production in mind. Battle-tested patterns. Enterprise-ready from day one.
