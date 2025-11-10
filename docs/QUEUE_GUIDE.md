# Message Queue Guide

Complete guide to the message queue system in MoroJS.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Queue Adapters](#queue-adapters)
- [Job Management](#job-management)
- [Queue Configuration](#queue-configuration)
- [Job Processing](#job-processing)
- [Middleware](#middleware)
- [Monitoring](#monitoring)
- [Error Handling](#error-handling)
- [Advanced Usage](#advanced-usage)

---

## Overview

MoroJS includes a production-ready message queue system with support for multiple backend adapters.

### Features

- **Multiple Adapters** - Bull, RabbitMQ, AWS SQS, Kafka, or in-memory
- **Job Scheduling** - Delayed and scheduled job execution
- **Retry Logic** - Configurable retry strategies with backoff
- **Dead Letter Queue** - Failed job handling and recovery
- **Priority Queues** - Job prioritization
- **Bulk Operations** - Add and process multiple jobs
- **Monitoring** - Built-in metrics and health checks

### Supported Adapters

| Adapter | Use Case | Backend Required |
|---------|----------|------------------|
| `memory` | Development, testing | None |
| `bull` | Redis-based queue | Redis |
| `rabbitmq` | Message broker | RabbitMQ |
| `sqs` | AWS cloud | AWS SQS |
| `kafka` | Event streaming | Apache Kafka |

---

## Getting Started

### Installation

Install the adapter you need:

```bash
# Bull (Redis-based)
npm install bull

# RabbitMQ
npm install amqplib

# AWS SQS
npm install @aws-sdk/client-sqs

# Kafka
npm install kafkajs
```

### Quick Start with MoroJS (Recommended)

The easiest way to use queues in MoroJS is with the built-in `app.queueInit()` method:

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

// Configure queue - synchronous, no await needed!
app.queueInit('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379
  },
  concurrency: 5,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    }
  }
});

// Process jobs
await app.processQueue('emails', async (job) => {
  await sendEmail(job.data);
  return { sent: true };
});

// Add jobs to queue
app.post('/send-email').handler(async (req, res) => {
  await app.addToQueue('emails', {
    to: req.body.email,
    subject: 'Welcome',
    body: 'Welcome to our platform!'
  });

  return { queued: true };
});

app.listen(3000);
```

### Low-Level API (Advanced)

For more control, you can use the `QueueManager` directly:

```typescript
import { QueueManager } from '@morojs/moro';

const queueManager = new QueueManager();

// Register a queue
await queueManager.registerQueue('emails', {
  adapter: 'memory',
  concurrency: 5,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false
  }
});

// Add a job
await queueManager.addToQueue('emails', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Welcome to our platform!'
});

// Process jobs
await queueManager.process('emails', async (job) => {
  await sendEmail(job.data);
  return { sent: true };
});
```

---

## Queue Adapters

### Memory Adapter

In-memory queue for development and testing.

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'memory',
  concurrency: 5
});
```

**Characteristics:**
- No external dependencies
- Data lost on restart
- Suitable for development only

### Bull Adapter

Redis-based queue with persistence and advanced features.

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
    password: 'redis-password'
  },
  concurrency: 10
});
```

**Characteristics:**
- Persistent storage
- Job scheduling and delays
- Priority queues
- Rate limiting
- Retry with exponential backoff

### RabbitMQ Adapter

AMQP-based message broker.

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'rabbitmq',
  connection: {
    host: 'localhost',
    port: 5672,
    username: 'guest',
    password: 'guest'
  },
  concurrency: 20
});
```

**Characteristics:**
- Message persistence
- Routing and exchanges
- Acknowledgments
- Dead letter exchanges
- Message TTL

### AWS SQS Adapter

Amazon Simple Queue Service.

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'sqs',
  connection: {
    region: 'us-east-1',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue'
  },
  concurrency: 10
});
```

**Characteristics:**
- Managed service (no infrastructure)
- Automatic scaling
- Message retention (up to 14 days)
- FIFO queues available
- Integration with AWS services

### Kafka Adapter

Distributed event streaming platform.

```typescript
await queueManager.registerQueue('events', {
  adapter: 'kafka',
  connection: {
    brokers: ['localhost:9092'],
    groupId: 'my-consumer-group'
  },
  concurrency: 50
});
```

**Characteristics:**
- High throughput
- Event streaming
- Partition-based processing
- Replay capability
- Durable message log

---

## Job Management

### Adding Jobs

#### Single Job

**Using MoroJS Integration:**

```typescript
// Add a job to the queue
const jobId = await app.addToQueue('emails', {
  to: 'user@example.com',
  template: 'welcome'
});

console.log('Job queued:', jobId);
```

**Using Low-Level API:**

```typescript
const job = await queueManager.addToQueue('emails', {
  to: 'user@example.com',
  template: 'welcome'
});

console.log(`Job added: ${job.id}`);
```

#### Bulk Jobs

**Using MoroJS Integration:**

```typescript
const jobIds = await app.addBulkToQueue('notifications', [
  { data: { userId: 1, message: 'Update available' }, options: { priority: 10 } },
  { data: { userId: 2, message: 'New features' }, options: { priority: 5 } },
  { data: { userId: 3, message: 'Maintenance scheduled' }, options: { delay: 60000 } }
]);

console.log(`${jobIds.length} jobs queued`);
```

**Using Low-Level API:**

```typescript
const jobs = await queueManager.addBulk('notifications', [
  { userId: 1, message: 'Update available' },
  { userId: 2, message: 'New features' },
  { userId: 3, message: 'Maintenance scheduled' }
]);

console.log(`${jobs.length} jobs added`);
```

#### Job Options

```typescript
await queueManager.addToQueue('reports',
  { reportId: 123, format: 'pdf' },
  {
    priority: 10,           // Higher priority
    delay: 60000,           // Delay 1 minute
    attempts: 3,            // Retry 3 times
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: true,
    removeOnFail: false,
    timeout: 30000          // 30 second timeout
  }
);
```

### Job Status

```typescript
// Get job by ID
const job = await queueManager.getJob('emails', 'job-id-123');

if (job) {
  console.log(`Status: ${job.status}`);
  console.log(`Progress: ${job.progress}%`);
  console.log(`Attempts: ${job.attempts}`);
}
```

### Job Control

```typescript
// Pause a job
await queueManager.pauseJob('emails', 'job-id-123');

// Resume a job
await queueManager.resumeJob('emails', 'job-id-123');

// Remove a job
await queueManager.removeJob('emails', 'job-id-123');

// Retry a failed job
await queueManager.retryJob('emails', 'job-id-123');
```

---

## Queue Configuration

### Retry Configuration

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'bull',
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000    // Start at 2 seconds
    }
  }
});
```

**Backoff Strategies:**
- `fixed` - Same delay between retries
- `exponential` - Doubles delay each retry (2s, 4s, 8s, 16s...)
- `linear` - Increases delay linearly (2s, 4s, 6s, 8s...)

### Dead Letter Queue

```typescript
await queueManager.registerQueue('payments', {
  adapter: 'rabbitmq',
  deadLetterQueue: {
    enabled: true,
    queueName: 'payments-failed',
    maxRetries: 3
  }
});
```

Failed jobs after max retries move to dead letter queue for manual inspection.

### Rate Limiting

```typescript
await queueManager.registerQueue('api-calls', {
  adapter: 'bull',
  rateLimiter: {
    max: 100,          // 100 jobs
    duration: 60000    // per minute
  }
});
```

---

## Job Processing

### Basic Processor

```typescript
await queueManager.process('emails', async (job) => {
  const { to, subject, body } = job.data;

  await sendEmail(to, subject, body);

  return { sent: true, timestamp: Date.now() };
});
```

### Progress Tracking

```typescript
await queueManager.process('video-encoding', async (job) => {
  const { videoId, format } = job.data;

  // Report progress
  await job.updateProgress(0);

  const video = await loadVideo(videoId);
  await job.updateProgress(25);

  const encoded = await encodeVideo(video, format);
  await job.updateProgress(75);

  await saveVideo(encoded);
  await job.updateProgress(100);

  return { videoId, format, size: encoded.size };
});
```

### Error Handling

```typescript
await queueManager.process('tasks', async (job) => {
  try {
    const result = await processTask(job.data);
    return result;
  } catch (error) {
    // Log error
    console.error(`Job ${job.id} failed:`, error);

    // Re-throw to trigger retry
    throw error;
  }
});
```

### Job Context

```typescript
await queueManager.process('notifications', async (job, context) => {
  console.log(`Worker: ${context.workerId}`);
  console.log(`Queue: ${context.queueName}`);
  console.log(`Attempt: ${job.attempts}`);

  await sendNotification(job.data);

  return { sent: true };
});
```

---

## Middleware

### Rate Limit Middleware

```typescript
import { createRateLimitMiddleware } from '@morojs/moro';

const rateLimiter = createRateLimitMiddleware({
  max: 100,
  window: 60000,
  keyGenerator: (job) => job.data.userId
});

await queueManager.process('api-calls', rateLimiter, async (job) => {
  return await callAPI(job.data);
});
```

### Priority Middleware

```typescript
import { createPriorityMiddleware } from '@morojs/moro';

const prioritizer = createPriorityMiddleware({
  levels: 10,
  default: 5
});

await queueManager.process('tasks', prioritizer, async (job) => {
  return await processTask(job.data);
});
```

### Monitoring Middleware

```typescript
import { createMonitoringMiddleware } from '@morojs/moro';

const monitor = createMonitoringMiddleware({
  collectMetrics: true,
  slowJobThreshold: 5000,  // 5 seconds
  onSlowJob: (job, duration) => {
    console.warn(`Slow job detected: ${job.id} took ${duration}ms`);
  }
});

await queueManager.process('reports', monitor, async (job) => {
  return await generateReport(job.data);
});
```

---

## Monitoring

### Queue Metrics

```typescript
const metrics = await queueManager.getMetrics('emails');

console.log(`Waiting: ${metrics.waiting}`);
console.log(`Active: ${metrics.active}`);
console.log(`Completed: ${metrics.completed}`);
console.log(`Failed: ${metrics.failed}`);
console.log(`Delayed: ${metrics.delayed}`);
```

### Queue Status

```typescript
const status = await queueManager.getStatus('emails');

console.log(`Paused: ${status.isPaused}`);
console.log(`Workers: ${status.activeWorkers}`);
console.log(`Processing Rate: ${status.processingRate}/min`);
```

### Health Check

```typescript
const health = await queueManager.healthCheck('emails');

if (health.healthy) {
  console.log('Queue is healthy');
} else {
  console.error('Queue issues:', health.issues);
}
```

### Event Monitoring

```typescript
// Listen to queue events
queueManager.on('queue:job:completed', (event) => {
  console.log(`Job ${event.jobId} completed`);
});

queueManager.on('queue:job:failed', (event) => {
  console.error(`Job ${event.jobId} failed:`, event.error);
});

queueManager.on('queue:job:progress', (event) => {
  console.log(`Job ${event.jobId} progress: ${event.progress}%`);
});
```

---

## Error Handling

### Retry Strategies

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'bull',
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000
    }
  }
});
```

### Failed Job Handler

```typescript
queueManager.on('queue:job:failed', async (event) => {
  const { queueName, jobId, error, job } = event;

  // Log to monitoring service
  await logError({
    queue: queueName,
    jobId,
    error: error.message,
    data: job.data,
    attempts: job.attempts
  });

  // Send alert if max attempts reached
  if (job.attempts >= 5) {
    await sendAlert(`Job ${jobId} permanently failed`);
  }
});
```

### Dead Letter Queue Processing

```typescript
// Process failed jobs from DLQ
await queueManager.process('emails-failed', async (job) => {
  console.log(`Handling failed job: ${job.id}`);
  console.log(`Original error: ${job.failedReason}`);
  console.log(`Attempts: ${job.attempts}`);

  // Manual intervention or special handling
  await manuallyProcessJob(job.data);

  return { recovered: true };
});
```

---

## Advanced Usage

### Multiple Queues

```typescript
// High-priority queue
await queueManager.registerQueue('critical', {
  adapter: 'bull',
  concurrency: 20
});

// Normal queue
await queueManager.registerQueue('standard', {
  adapter: 'bull',
  concurrency: 10
});

// Background queue
await queueManager.registerQueue('background', {
  adapter: 'bull',
  concurrency: 5
});
```

### Scheduled Jobs

```typescript
// Run job in 1 hour
await queueManager.addToQueue('reminders',
  { userId: 123, message: 'Meeting in 10 minutes' },
  { delay: 3600000 }
);

// Recurring jobs using cron-like syntax
await queueManager.addToQueue('daily-report',
  { reportType: 'sales' },
  {
    repeat: {
      cron: '0 9 * * *'  // Every day at 9 AM
    }
  }
);
```

### Job Prioritization

```typescript
// High priority
await queueManager.addToQueue('orders',
  { orderId: 123 },
  { priority: 1 }  // Lower number = higher priority
);

// Low priority
await queueManager.addToQueue('analytics',
  { eventData: {} },
  { priority: 10 }
);
```

### Queue Lifecycle

```typescript
// Pause queue
await queueManager.pauseQueue('emails');

// Resume queue
await queueManager.resumeQueue('emails');

// Drain queue (wait for active jobs to complete)
await queueManager.drainQueue('emails');

// Clean completed jobs
await queueManager.cleanQueue('emails', 'completed', 86400000); // 24 hours

// Shutdown gracefully
await queueManager.shutdown();
```

---

## Integration with MoroJS

### With HTTP Routes

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();
const queueManager = new QueueManager();

await queueManager.registerQueue('emails', {
  adapter: 'bull',
  connection: { host: 'localhost', port: 6379 }
});

// Add jobs from route handler
app.post('/api/send-email', async (req, res) => {
  const job = await queueManager.addToQueue('emails', req.body);

  return {
    jobId: job.id,
    status: 'queued'
  };
});

// Check job status
app.get('/api/jobs/:id', async (req, res) => {
  const job = await queueManager.getJob('emails', req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    result: job.result
  };
});

app.listen(3000);
```

### With Events

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

app.on('user:registered', async (event) => {
  await queueManager.addToQueue('welcome-emails', {
    userId: event.userId,
    email: event.email
  });
});
```

---

## Best Practices

### 1. Choose the Right Adapter

- **Development:** Use `memory` adapter
- **Production (Simple):** Use `bull` with Redis
- **Production (High Scale):** Use `kafka` or `rabbitmq`
- **AWS Infrastructure:** Use `sqs`

### 2. Set Appropriate Concurrency

```typescript
// CPU-bound tasks: lower concurrency
await queueManager.registerQueue('video-encoding', {
  adapter: 'bull',
  concurrency: 2  // Based on CPU cores
});

// I/O-bound tasks: higher concurrency
await queueManager.registerQueue('api-calls', {
  adapter: 'bull',
  concurrency: 50  // Many concurrent I/O operations
});
```

### 3. Configure Retries Properly

```typescript
await queueManager.registerQueue('payments', {
  adapter: 'bull',
  defaultJobOptions: {
    attempts: 3,           // Limited retries for critical operations
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  }
});
```

### 4. Use Dead Letter Queues

```typescript
await queueManager.registerQueue('orders', {
  adapter: 'rabbitmq',
  deadLetterQueue: {
    enabled: true,
    queueName: 'orders-failed',
    maxRetries: 5
  }
});
```

### 5. Monitor Queue Health

```typescript
// Regular health checks
setInterval(async () => {
  const health = await queueManager.healthCheck('critical');

  if (!health.healthy) {
    await alertOps('Queue health check failed', health.issues);
  }
}, 60000);
```

---

## Troubleshooting

### Jobs Not Processing

1. Check queue is not paused
2. Verify concurrency settings
3. Check processor is registered
4. Review connection configuration

### High Memory Usage

1. Enable `removeOnComplete: true`
2. Clean old jobs regularly
3. Reduce concurrency
4. Check for job data size

### Slow Processing

1. Review job complexity
2. Check database connections
3. Increase concurrency
4. Use job batching

### Lost Jobs

1. Use persistent adapter (not `memory`)
2. Enable message acknowledgments
3. Configure retry logic
4. Use dead letter queue

---

## MoroJS API Reference

### `app.queueInit(name, options)`

Configure a queue (synchronous, lazy initialization).

**Parameters:**
- `name` (string) - Queue name
- `options` (object) - Queue configuration
  - `adapter` (string) - Queue adapter ('memory', 'bull', 'rabbitmq', 'sqs', 'kafka')
  - `connection` (object) - Adapter-specific connection settings
  - `concurrency` (number) - Number of concurrent jobs (default: 1)
  - `defaultJobOptions` (object) - Default options for all jobs
    - `attempts` (number) - Max retry attempts
    - `backoff` (object) - Retry backoff strategy
    - `priority` (number) - Job priority
    - `delay` (number) - Delay before processing (ms)
    - `removeOnComplete` (boolean) - Remove job when done
    - `removeOnFail` (boolean) - Remove job on failure

**Returns:** `this` (chainable)

**Example:**
```typescript
app.queueInit('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379
  },
  concurrency: 10,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: true
  }
});
```

### `app.addToQueue(queueName, data, options?)`

Add a job to a queue.

**Parameters:**
- `queueName` (string) - Queue name
- `data` (any) - Job data
- `options` (object, optional) - Job-specific options
  - `priority` (number) - Job priority
  - `delay` (number) - Delay before processing (ms)
  - `attempts` (number) - Max retry attempts
  - `backoff` (object) - Retry backoff strategy
  - `jobId` (string) - Custom job ID

**Returns:** `Promise<string>` - Job ID

**Example:**
```typescript
const jobId = await app.addToQueue('emails', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Hello!'
}, {
  priority: 10,
  delay: 5000  // Send after 5 seconds
});
```

### `app.addBulkToQueue(queueName, jobs)`

Add multiple jobs to a queue.

**Parameters:**
- `queueName` (string) - Queue name
- `jobs` (array) - Array of job objects
  - `data` (any) - Job data
  - `options` (object, optional) - Job options

**Returns:** `Promise<string[]>` - Array of job IDs

**Example:**
```typescript
const jobIds = await app.addBulkToQueue('notifications', [
  {
    data: { userId: 1, message: 'Update 1' },
    options: { priority: 10 }
  },
  {
    data: { userId: 2, message: 'Update 2' },
    options: { delay: 60000 }
  }
]);
```

### `app.processQueue(queueName, concurrencyOrHandler, handler?)`

Register a processor for a queue.

**Parameters:**
- `queueName` (string) - Queue name
- `concurrencyOrHandler` (number | function) - Concurrency or handler function
- `handler` (function, optional) - Job handler (if concurrency provided)
  - `job` - Job object with `data`, `id`, `progress()`, etc.
  - Returns `Promise<any>` - Job result

**Returns:** `Promise<void>`

**Example:**
```typescript
// Simple processor
await app.processQueue('emails', async (job) => {
  await sendEmail(job.data);
  return { sent: true };
});

// With concurrency
await app.processQueue('images', 5, async (job) => {
  await processImage(job.data);
  job.progress(100);
  return { processed: true };
});
```

### `app.getQueueStats(queueName)`

Get queue statistics.

**Parameters:**
- `queueName` (string) - Queue name

**Returns:** `Promise<object>` - Queue stats
  - `waiting` (number) - Jobs waiting
  - `active` (number) - Jobs in progress
  - `completed` (number) - Completed jobs
  - `failed` (number) - Failed jobs
  - `delayed` (number) - Delayed jobs
  - `paused` (boolean) - Queue paused status

**Example:**
```typescript
const stats = await app.getQueueStats('emails');
console.log(`Waiting: ${stats.waiting}, Active: ${stats.active}`);
```

### `app.pauseQueue(queueName)`

Pause a queue (stops processing new jobs).

**Returns:** `Promise<void>`

### `app.resumeQueue(queueName)`

Resume a paused queue.

**Returns:** `Promise<void>`

### `app.cleanQueue(queueName, grace, status)`

Clean old jobs from a queue.

**Parameters:**
- `queueName` (string) - Queue name
- `grace` (number) - Grace period in ms
- `status` (string) - Job status ('completed', 'failed', 'delayed', 'active', 'wait')

**Returns:** `Promise<number>` - Number of jobs removed

**Example:**
```typescript
// Remove completed jobs older than 24 hours
await app.cleanQueue('emails', 24 * 60 * 60 * 1000, 'completed');
```

---

## API Reference

For complete type definitions and API details, see:
- [API Reference](./API.md) - Complete API documentation
- [Types Reference](../src/core/queue/types.ts) - TypeScript type definitions

---

**Need help?** Join our [Discord community](https://morojs.com/discord) or [open an issue](https://github.com/Moro-JS/moro/issues).

