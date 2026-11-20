# Message Queue Guide

Complete guide to the message queue system in MoroJS.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Queue Adapters](#queue-adapters)
- [Retention of Finished Jobs](#retention-of-finished-jobs)
- [Job Management](#job-management)
- [Queue Configuration](#queue-configuration)
- [Job Processing](#job-processing)
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
- **Monitoring** - Built-in metrics and events

### Supported Adapters

| Adapter    | Use Case             | Backend Required |
| ---------- | -------------------- | ---------------- |
| `memory`   | Development, testing | None             |
| `bull`     | Redis-based queue    | Redis            |
| `rabbitmq` | Message broker       | RabbitMQ         |
| `sqs`      | AWS cloud            | AWS SQS          |
| `kafka`    | Event streaming      | Apache Kafka     |

---

## Getting Started

### Installation

Install the adapter you need:

```bash
# Bull (Redis-based): the 'bull' adapter runs on BullMQ
npm install bullmq ioredis

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

const app = await createApp();

// Configure queue - synchronous, no await needed!
app.queueInit('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  concurrency: 5,
  defaultJobOptions: {
    removeOnComplete: true,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

// Process jobs
await app.processQueue('emails', async job => {
  await sendEmail(job.data);
  return { sent: true };
});

// Add jobs to queue
app.post('/send-email').handler(async (req, res) => {
  await app.addToQueue('emails', {
    to: req.body.email,
    subject: 'Welcome',
    body: 'Welcome to our platform!',
  });

  return { queued: true };
});

app.listen(3000);
```

`queueInit()` returns at once and registers the queue in the background: an
adapter that talks to a broker (Bull, RabbitMQ, Kafka, SQS) has to connect
first. `processQueue()`, `addToQueue()` and `addBulkToQueue()` wait for that
registration, so the calls above can follow `queueInit()` directly.

If the registration fails (the adapter's package is not installed, the
adapter name is unknown, the adapter cannot initialise), the error is logged, the
queue is not listed by `app.hasQueue()` / `app.getQueueNames()`, and every
call that uses the queue rejects with that original error:

```typescript
app.queueInit('emails', { adapter: 'bull', connection: { host: 'localhost', port: 6379 } });

try {
  await app.processQueue('emails', async job => ({ sent: true }));
} catch (error) {
  // e.g. "BullMQ is not installed. Install it with: npm install bullmq ioredis"
  app.hasQueue('emails'); // false
}
```

Calling `queueInit()` again for that name starts a new registration.

---

## Queue Adapters

### Memory Adapter

In-memory queue for development and testing.

```typescript
app.queueInit('tasks', {
  adapter: 'memory',
  concurrency: 5,
});
```

**Characteristics:**

- No external dependencies
- Data lost on restart
- Suitable for development only

### Bull Adapter

Redis-based queue with persistence and advanced features.

```typescript
app.queueInit('tasks', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
    password: 'redis-password',
  },
  concurrency: 10,
});
```

The connection also takes `username` (a Redis ACL user), `database` (the Redis database number) and
`tls` (the TLS options ioredis passes to Node: `{ ca }`, or `{}` for a server with a publicly
trusted certificate):

```typescript
import fs from 'node:fs';

app.queueInit('tasks', {
  adapter: 'bull',
  connection: {
    host: 'redis.internal',
    port: 6380,
    username: 'worker',
    password: process.env.REDIS_PASSWORD,
    tls: { ca: fs.readFileSync('/etc/ssl/redis-ca.pem', 'utf8') },
  },
});
```

Set `username` and `tls` only for a Redis that expects them: they are sent as given.

**Characteristics:**

- Persistent storage
- Job scheduling and delays
- Priority queues
- Rate limiting
- Retry with exponential backoff

### RabbitMQ Adapter

AMQP-based message broker.

```typescript
app.queueInit('tasks', {
  adapter: 'rabbitmq',
  connection: {
    host: 'localhost',
    port: 5672,
    username: 'guest',
    password: 'guest',
  },
  concurrency: 20,
});
```

The connection also takes `vhost` (the virtual host to open; the broker's default when not set),
`amqps: true` (connect over TLS; the default port becomes 5671) and `tls` (TLS options for the
socket, as Node's `tls.connect()` takes them; giving them selects `amqps` as well):

```typescript
import fs from 'node:fs';

app.queueInit('tasks', {
  adapter: 'rabbitmq',
  connection: {
    host: 'mq.internal',
    username: 'worker',
    password: process.env.RABBITMQ_PASSWORD,
    vhost: 'orders',
    tls: { ca: fs.readFileSync('/etc/ssl/mq-ca.pem', 'utf8') },
  },
});
```

Without `amqps` or `tls` the connection is plain `amqp://`, as before.

**Characteristics:**

- Message persistence
- Routing and exchanges
- Acknowledgments
- Dead letter exchanges
- Message TTL

### AWS SQS Adapter

Amazon Simple Queue Service.

```typescript
app.queueInit('tasks', {
  adapter: 'sqs',
  connection: {
    region: 'us-east-1',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
  },
  concurrency: 10,
});
```

Credentials come from the AWS SDK's default chain unless `credentials` is set (an object with
`accessKeyId`, `secretAccessKey` and optionally `sessionToken`, or a provider function). `endpoint`
points the client at another SQS-compatible service (LocalStack, ElasticMQ, a VPC endpoint);
without a `queueUrl`, queue URLs are then built as `<endpoint>/<accountId>/<queue name>`:

```typescript
app.queueInit('tasks', {
  adapter: 'sqs',
  connection: {
    region: 'us-east-1',
    endpoint: 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  },
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
app.queueInit('events', {
  adapter: 'kafka',
  connection: {
    brokers: ['localhost:9092'],
    groupId: 'my-consumer-group',
  },
  concurrency: 50,
});
```

The Kafka consumer starts from new messages: a job produced before the consumer group first
subscribed to the topic is not delivered to it.

`ssl`, `sasl` and `clientId` are passed to kafkajs as given: `ssl: true` for TLS with the system
CAs or an object of TLS options, and `sasl` with a `mechanism` (`'plain'`, `'scram-sha-256'`,
`'scram-sha-512'`, ...) and what that mechanism needs. Without them the connection is plaintext
with no authentication, and the client id is `morojs-queue`.

```typescript
app.queueInit('events', {
  adapter: 'kafka',
  connection: {
    brokers: ['kafka-1.internal:9093'],
    clientId: 'billing-api',
    ssl: true,
    sasl: {
      mechanism: 'scram-sha-256',
      username: 'billing',
      password: process.env.KAFKA_PASSWORD,
    },
  },
});
```

#### Connection options each adapter reads

| Adapter    | Read from `connection`                                          |
| ---------- | --------------------------------------------------------------- |
| `bull`     | `host`, `port`, `username`, `password`, `database`, `tls`       |
| `rabbitmq` | `host`, `port`, `username`, `password`, `vhost`, `amqps`, `tls` |
| `kafka`    | `brokers`, `groupId`, `clientId`, `ssl`, `sasl`                 |
| `sqs`      | `region`, `queueUrl`, `accountId`, `endpoint`, `credentials`    |

Other keys are ignored.

**Characteristics:**

- High throughput
- Event streaming
- Partition-based processing
- Replay capability
- Durable message log

---

## Retention of Finished Jobs

A queue keeps a bounded number of finished jobs, so a long-running process does not accumulate
them:

| Kept per queue                                     | Default | `retention` key |
| -------------------------------------------------- | ------- | --------------- |
| Completed jobs                                     | 1000    | `completed`     |
| Failed jobs (after their last attempt)             | 5000    | `failed`        |
| Jobs added by this process and not yet seen to end | 10000   | `unfinished`    |

When a job finishes and the count is over the limit, the oldest job of that outcome is removed.

```typescript
app.queueInit('emails', {
  adapter: 'bull',
  connection: { host: 'localhost', port: 6379 },
  retention: {
    completed: 200, // keep the last 200 completed jobs
    failed: 2000, // keep the last 2000 failed jobs
  },
});
```

- `0` keeps none; `Infinity` keeps every job (memory or Redis then grows with every job).
- **`bull`**: the numbers are passed to BullMQ as each job's `removeOnComplete` / `removeOnFail`
  keep count, so the jobs are removed from Redis. `unfinished` does not apply.
- **`memory`**: the jobs are held in the process. Waiting, delayed and running jobs are never
  removed by retention; `unfinished` does not apply.
- **`rabbitmq`, `kafka`, `sqs`**: the broker holds the job; the adapter keeps a record per job in
  the process for `getJob()`, `getJobs()` and the metrics. `unfinished` bounds the records of jobs
  this process added and has not seen finish (in a process that only adds jobs, that is all of
  them). A job whose record was dropped still runs when it is delivered; `getJob()` returns `null`
  for it until then.

A job's own `removeOnComplete` / `removeOnFail` (set on the job or through `defaultJobOptions`)
takes the place of the queue's retention for that job:

| Value    | `bull`                                 | Other adapters                             |
| -------- | -------------------------------------- | ------------------------------------------ |
| not set  | the queue's `retention` applies        | the queue's `retention` applies            |
| `true`   | removed as soon as it finishes         | removed as soon as it finishes             |
| `false`  | kept until you remove it (not counted) | kept until you remove it (not counted)     |
| a number | BullMQ keeps the last _n_ jobs         | removed _n_ milliseconds after it finishes |

`app.cleanQueue()` removes finished jobs by age whatever the retention is.

---

## Job Management

### Adding Jobs

#### Single Job

```typescript
// Add a job to the queue
const job = await app.addToQueue('emails', {
  to: 'user@example.com',
  template: 'welcome',
});

console.log('Job queued:', job.id);
```

#### Bulk Jobs

```typescript
const jobs = await app.addBulkToQueue('notifications', [
  { data: { userId: 1, message: 'Update available' }, options: { priority: 10 } },
  { data: { userId: 2, message: 'New features' }, options: { priority: 5 } },
  { data: { userId: 3, message: 'Maintenance scheduled' }, options: { delay: 60000 } },
]);

console.log(`${jobs.length} jobs queued`);
```

#### Job Options

```typescript
await app.addToQueue(
  'reports',
  { reportId: 123, format: 'pdf' },
  {
    priority: 10, // Higher priority
    delay: 60000, // Delay 1 minute
    attempts: 3, // Retry 3 times
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true, // Remove the job as soon as it completes
    timeout: 30000, // 30 second timeout
  }
);
```

### Job Status

```typescript
// Get job by ID
const job = await app.getJob('emails', 'job-id-123');

if (job) {
  console.log(`Progress: ${job.progress}%`);
  console.log(`Attempts: ${job.attemptsMade}`);
  console.log(`Failed: ${job.failedReason ?? 'no'}`);
}

// Or list jobs by status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'
const failed = await app.getJobs('emails', 'failed');
```

### Job Control

```typescript
// Remove a job
await app.removeJob('emails', 'job-id-123');

// Retry a failed job
await app.retryJob('emails', 'job-id-123');
```

---

## Queue Configuration

### Retry Configuration

```typescript
app.queueInit('tasks', {
  adapter: 'bull',
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000, // Start at 2 seconds
    },
  },
});
```

**Backoff Strategies:**

- `fixed` - Same delay between retries
- `exponential` - Doubles delay each retry (2s, 4s, 8s, 16s...)
- `linear` - Increases delay linearly (2s, 4s, 6s, 8s...)

---

## Job Processing

### Basic Processor

```typescript
await app.processQueue('emails', async job => {
  const { to, subject, body } = job.data;

  await sendEmail(to, subject, body);

  return { sent: true, timestamp: Date.now() };
});
```

### Progress Tracking

```typescript
await app.processQueue('video-encoding', async job => {
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
await app.processQueue('tasks', async job => {
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
// The handler receives the job itself: its fields plus updateProgress() and log()
await app.processQueue('notifications', async job => {
  console.log(`Job: ${job.id}`);
  console.log(`Attempt: ${job.attemptsMade}`);
  job.log('Sending notification');

  await sendNotification(job.data);

  return { sent: true };
});
```

---

## Monitoring

### Queue Metrics

```typescript
const { metrics } = await app.getQueueStatus('emails');

console.log(`Waiting: ${metrics.waiting}`);
console.log(`Active: ${metrics.active}`);
console.log(`Completed: ${metrics.completed}`);
console.log(`Failed: ${metrics.failed}`);
console.log(`Delayed: ${metrics.delayed}`);
```

### Queue Status

```typescript
const status = await app.getQueueStatus('emails');

console.log(`Adapter: ${status.adapter}`);
console.log(`Paused: ${status.isPaused}`);
console.log(`Workers: ${status.workers}`);
```

### Event Monitoring

```typescript
// Queue events arrive on the app event bus as { context, data }
app.events.on('queue:job:completed', ({ data }) => {
  console.log(`Job ${data.jobId} completed`);
});

app.events.on('queue:job:failed', ({ data }) => {
  console.error(`Job ${data.jobId} failed:`, data.error);
});

app.events.on('queue:job:progress', ({ data }) => {
  console.log(`Job ${data.jobId} progress: ${data.progress}%`);
});
```

---

## Error Handling

### Retry Strategies

```typescript
app.queueInit('tasks', {
  adapter: 'bull',
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});
```

### Failed Job Handler

```typescript
app.events.on('queue:job:failed', async ({ data }) => {
  const { queueName, jobId, error, job } = data;

  // Log to monitoring service
  await logError({
    queue: queueName,
    jobId,
    error: error.message,
    data: job.data,
    attempts: job.attemptsMade,
  });

  // Send alert if max attempts reached
  if (job.attemptsMade >= 5) {
    await sendAlert(`Job ${jobId} permanently failed`);
  }
});
```

### Inspecting Failed Jobs

```typescript
// Review failed jobs and retry the ones worth retrying
const failedJobs = await app.getJobs('emails', 'failed');

for (const job of failedJobs) {
  console.log(`Failed job: ${job.id}`);
  console.log(`Original error: ${job.failedReason}`);
  console.log(`Attempts: ${job.attemptsMade}`);

  await app.retryJob('emails', job.id);
}
```

---

## Advanced Usage

### Multiple Queues

```typescript
// High-priority queue
app.queueInit('critical', {
  adapter: 'bull',
  concurrency: 20,
});

// Normal queue
app.queueInit('standard', {
  adapter: 'bull',
  concurrency: 10,
});

// Background queue
app.queueInit('background', {
  adapter: 'bull',
  concurrency: 5,
});
```

### Scheduled Jobs

```typescript
// Run job in 1 hour
await app.addToQueue(
  'reminders',
  { userId: 123, message: 'Meeting in 10 minutes' },
  { delay: 3600000 }
);

// Recurring jobs using cron-like syntax
await app.addToQueue(
  'daily-report',
  { reportType: 'sales' },
  {
    repeat: {
      cron: '0 9 * * *', // Every day at 9 AM
    },
  }
);
```

### Job Prioritization

```typescript
// High priority
await app.addToQueue(
  'orders',
  { orderId: 123 },
  { priority: 1 } // Lower number = higher priority
);

// Low priority
await app.addToQueue('analytics', { eventData: {} }, { priority: 10 });
```

### Queue Lifecycle

```typescript
// Pause queue
await app.pauseQueue('emails');

// Resume queue
await app.resumeQueue('emails');

// Clean completed jobs older than 24 hours
await app.cleanQueue('emails', 86400000, 'completed');

// Shutdown gracefully: closing the app shuts its queues down
await app.close();
```

---

## Integration with MoroJS

### With HTTP Routes

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

app.queueInit('emails', {
  adapter: 'bull',
  connection: { host: 'localhost', port: 6379 },
});

// Add jobs from route handler
app.post('/api/send-email', async (req, res) => {
  const job = await app.addToQueue('emails', req.body);

  return {
    jobId: job.id,
    status: 'queued',
  };
});

// Check job status
app.get('/api/jobs/:id', async (req, res) => {
  const job = await app.getJob('emails', req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return {
    id: job.id,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    result: job.returnvalue,
    failedReason: job.failedReason,
  };
});

app.listen(3000);
```

### With Events

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

// Listeners on the app event bus receive { context, data }
app.events.on('user:registered', async ({ data }) => {
  await app.addToQueue('welcome-emails', {
    userId: data.userId,
    email: data.email,
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
app.queueInit('video-encoding', {
  adapter: 'bull',
  concurrency: 2, // Based on CPU cores
});

// I/O-bound tasks: higher concurrency
app.queueInit('api-calls', {
  adapter: 'bull',
  concurrency: 50, // Many concurrent I/O operations
});
```

### 3. Configure Retries Properly

```typescript
app.queueInit('payments', {
  adapter: 'bull',
  defaultJobOptions: {
    attempts: 3, // Limited retries for critical operations
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});
```

### 4. Monitor Queue Health

```typescript
// Regular checks on the queue's own metrics
setInterval(async () => {
  const { metrics, isPaused } = await app.getQueueStatus('critical');

  if (isPaused || metrics.failed > 100) {
    await alertOps('Queue needs attention', metrics);
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

1. Lower the queue's `retention` (default: the last 1000 completed and 5000 failed jobs), or set
   `removeOnComplete: true`
2. Do not set `removeOnComplete: false` / `removeOnFail: false` unless you remove those jobs yourself
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
    - `removeOnComplete` (boolean | number) - `true` removes a job when it completes; see
      [Retention of Finished Jobs](#retention-of-finished-jobs)
    - `removeOnFail` (boolean | number) - the same for a job that failed its last attempt
  - `retention` (object) - Finished jobs kept per queue: `completed` (default 1000), `failed`
    (default 5000), `unfinished` (default 10000; RabbitMQ, Kafka and SQS)

**Returns:** `this` (chainable)

**Example:**

```typescript
app.queueInit('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  concurrency: 10,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
  },
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

**Returns:** `Promise<Job>` - The queued job (`id`, `data`, `progress`, `attemptsMade`, ...)

**Example:**

```typescript
const job = await app.addToQueue(
  'emails',
  {
    to: 'user@example.com',
    subject: 'Welcome',
    body: 'Hello!',
  },
  {
    priority: 10,
    delay: 5000, // Send after 5 seconds
  }
);
```

### `app.addBulkToQueue(queueName, jobs)`

Add multiple jobs to a queue.

**Parameters:**

- `queueName` (string) - Queue name
- `jobs` (array) - Array of job objects
  - `data` (any) - Job data
  - `options` (object, optional) - Job options

**Returns:** `Promise<Job[]>` - The queued jobs

**Example:**

```typescript
const jobs = await app.addBulkToQueue('notifications', [
  {
    data: { userId: 1, message: 'Update 1' },
    options: { priority: 10 },
  },
  {
    data: { userId: 2, message: 'Update 2' },
    options: { delay: 60000 },
  },
]);
```

### `app.processQueue(queueName, concurrencyOrHandler, handler?)`

Register a processor for a queue.

**Parameters:**

- `queueName` (string) - Queue name
- `concurrencyOrHandler` (number | function) - Concurrency or handler function
- `handler` (function, optional) - Job handler (if concurrency provided)
  - `job` - Job object with `data`, `id`, `updateProgress()`, `log()`, etc.
  - Returns `Promise<any>` - Job result

**Returns:** `Promise<void>`

**Example:**

```typescript
// Simple processor
await app.processQueue('emails', async job => {
  await sendEmail(job.data);
  return { sent: true };
});

// With concurrency
await app.processQueue('images', 5, async job => {
  await processImage(job.data);
  await job.updateProgress(100);
  return { processed: true };
});
```

### `app.getQueueStatus(queueName)`

Get queue status and statistics.

**Parameters:**

- `queueName` (string) - Queue name

**Returns:** `Promise<object>` - Queue status

- `name` (string) - Queue name
- `adapter` (string) - Adapter in use
- `isPaused` (boolean) - Queue paused status
- `workers` (number) - Registered workers
- `metrics` (object) - Job counts
  - `waiting` (number) - Jobs waiting
  - `active` (number) - Jobs in progress
  - `completed` (number) - Completed jobs
  - `failed` (number) - Failed jobs
  - `delayed` (number) - Delayed jobs
  - `paused` (number) - Paused jobs

**Example:**

```typescript
const { metrics } = await app.getQueueStatus('emails');
console.log(`Waiting: ${metrics.waiting}, Active: ${metrics.active}`);
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
- `status` (string, optional) - Job status ('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')

**Returns:** `Promise<void>`

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
