# Worker Threads Guide

Complete guide to using Worker Threads in MoroJS for CPU-intensive operations.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Worker Tasks](#worker-tasks)
- [API Reference](#api-reference)
- [Use Cases](#use-cases)
- [Performance](#performance)
- [Best Practices](#best-practices)
- [Advanced Usage](#advanced-usage)
- [Troubleshooting](#troubleshooting)

---

## Overview

MoroJS includes built-in Worker Threads support for offloading CPU-intensive operations from the main event loop.

### Features

- **Separate Thread Pool** - Isolates CPU-intensive operations from main thread
- **Task Queue** - Queues and distributes tasks across available workers
- **Priority Levels** - Tasks can be marked as high, normal, or low priority
- **Timeout Support** - Tasks can have configurable timeout limits
- **Built-in Tasks** - Pre-configured tasks for common operations (JWT, crypto, compression)

### When to Use Worker Threads

**Good Use Cases:**

- JWT token signing/verification
- Password hashing (bcrypt, argon2)
- Data encryption/decryption
- Large data transformations
- Image/video processing
- Complex calculations
- Data compression/decompression

**Not Recommended:**

- Simple I/O operations (use async/await)
- Database queries (already non-blocking)
- Network requests (already non-blocking)
- Small computations (overhead > benefit)

---

## Getting Started

### Installation

Worker threads are built into Node.js 18+ and included in MoroJS core. No additional dependencies required.

### Basic Usage

```typescript
import { createApp, getWorkerManager } from '@morojs/moro';

const app = await createApp();
const workers = getWorkerManager();

// Execute a task on worker thread
app.post('/api/hash', async (req, res) => {
  const result = await workers.executeTask({
    id: `hash-${Date.now()}`,
    type: 'crypto:hash',
    data: {
      input: req.body.password,
      algorithm: 'sha256',
    },
  });

  return { hash: result };
});

app.listen(3000);
```

### Configuration

Configure worker thread pool on application startup:

```typescript
import { createApp, WorkerManager } from '@morojs/moro';

const app = await createApp({
  workers: {
    count: 4, // Number of worker threads (default: CPU cores - 1)
    maxQueueSize: 1000, // Maximum queued tasks (default: 1000)
  },
});

// Or configure manually
const workers = new WorkerManager({
  workerCount: 4,
  maxQueueSize: 1000,
});
```

---

## Worker Tasks

### Built-in Tasks

MoroJS includes several pre-configured worker tasks:

#### JWT Operations

```typescript
import { workerTasks } from '@morojs/moro';

// Verify JWT token
app.post('/api/auth/verify', async (req, res) => {
  const result = await workerTasks.verifyJWT(req.body.token, process.env.JWT_SECRET);

  if (result.valid) {
    return { user: result.payload };
  } else {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Sign JWT token
app.post('/api/auth/login', async (req, res) => {
  const user = await authenticateUser(req.body);

  const token = await workerTasks.signJWT(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return { token };
});
```

#### Cryptographic Operations

```typescript
// Hash password
app.post('/api/register', async (req, res) => {
  const hash = await workerTasks.hashData(req.body.password, 'sha256');

  const user = await createUser({
    email: req.body.email,
    password: hash,
  });

  return user;
});

// Encrypt sensitive data
app.post('/api/secrets', async (req, res) => {
  const encrypted = await workerTasks.encryptData(req.body.secret, process.env.ENCRYPTION_KEY);

  return { encrypted };
});

// Decrypt data
app.get('/api/secrets/:id', async (req, res) => {
  const secret = await getSecret(req.params.id);

  const decrypted = await workerTasks.decryptData(secret.data, process.env.ENCRYPTION_KEY);

  return { secret: decrypted };
});
```

#### Data Compression

```typescript
// Compress large response
app.get('/api/export', async (req, res) => {
  const data = await getLargeDataset();

  const compressed = await workerTasks.compressData(JSON.stringify(data));

  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Type', 'application/json');
  return compressed;
});

// Decompress data
app.post('/api/import', async (req, res) => {
  const decompressed = await workerTasks.decompressData(req.body.data);

  const data = JSON.parse(decompressed);
  await importData(data);

  return { success: true, records: data.length };
});
```

#### Heavy Computation

```typescript
// Process complex calculation
app.post('/api/calculate', async (req, res) => {
  const result = await workerTasks.heavyComputation(req.body.operation, req.body.params);

  return { result };
});

// Transform large JSON
app.post('/api/transform', async (req, res) => {
  const transformed = await workerTasks.transformJSON(req.body.data, item => ({
    ...item,
    computed: expensiveTransform(item),
  }));

  return transformed;
});
```

### Task Priority

Control task execution order with priorities:

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

// High priority task (executes first)
await workers.executeTask({
  id: 'critical-task',
  type: 'crypto:hash',
  data: { input: 'critical-data' },
  priority: 'high', // 'high' | 'normal' | 'low'
});

// Normal priority (default)
await workers.executeTask({
  id: 'normal-task',
  type: 'crypto:hash',
  data: { input: 'normal-data' },
  priority: 'normal',
});

// Low priority (executes last)
await workers.executeTask({
  id: 'background-task',
  type: 'crypto:hash',
  data: { input: 'background-data' },
  priority: 'low',
});
```

### Task Timeout

Set timeout for long-running tasks:

```typescript
await workers.executeTask({
  id: 'long-task',
  type: 'heavy:computation',
  data: { operation: 'complex-calculation' },
  timeout: 30000, // 30 seconds
});
```

---

## API Reference

### WorkerManager

Main class for managing worker threads.

#### Constructor

```typescript
new WorkerManager(options?: {
  workerCount?: number;    // Number of workers (default: CPUs - 1)
  maxQueueSize?: number;   // Max queued tasks (default: 1000)
})
```

#### Methods

##### executeTask(task)

Execute a task on worker thread.

```typescript
executeTask<T>(task: WorkerTask): Promise<T>

interface WorkerTask {
  id: string;              // Unique task ID
  type: string;            // Task type (e.g., 'crypto:hash')
  data: any;               // Task data
  priority?: 'low' | 'normal' | 'high';
  timeout?: number;        // Timeout in milliseconds
}
```

##### getStats()

Get worker pool statistics.

```typescript
getStats(): {
  workers: number;
  queueSize: number;
  activeTasks: number;
}
```

##### shutdown()

Gracefully shutdown worker pool.

```typescript
await shutdown(): Promise<void>
```

### Worker Tasks Helper

Pre-configured task helpers for common operations.

```typescript
import { workerTasks } from '@morojs/moro';

// JWT operations
workerTasks.verifyJWT(token, secret, options?): Promise<JWTResult>
workerTasks.signJWT(payload, secret, options?): Promise<string>

// Cryptography
workerTasks.hashData(input, algorithm): Promise<string>
workerTasks.encryptData(data, key): Promise<string>
workerTasks.decryptData(data, key): Promise<string>

// Compression
workerTasks.compressData(data): Promise<Buffer>
workerTasks.decompressData(data): Promise<string>

// Computation
workerTasks.heavyComputation(operation, params): Promise<any>
workerTasks.transformJSON(data, transformer): Promise<any>
```

### Global Helpers

```typescript
import { getWorkerManager, executeOnWorker } from '@morojs/moro';

// Get singleton worker manager
const workers = getWorkerManager();

// Execute task directly
const result = await executeOnWorker({
  id: 'task-1',
  type: 'crypto:hash',
  data: { input: 'test' },
});
```

---

## Use Cases

### Authentication System

```typescript
import { createApp, workerTasks } from '@morojs/moro';

const app = await createApp();

// Login with JWT signing on worker thread
app.post('/api/login', async (req, res) => {
  const user = await db.users.findOne({ email: req.body.email });

  if (!user || !(await verifyPassword(req.body.password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Sign JWT on worker thread (non-blocking)
  const token = await workerTasks.signJWT(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return { token, user: { id: user.id, email: user.email } };
});

// Verify token on worker thread
app.get('/api/profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const result = await workerTasks.verifyJWT(token, process.env.JWT_SECRET);

  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = await db.users.findOne({ id: result.payload.userId });
  return user;
});
```

### Data Export/Import

```typescript
// Export large dataset with compression
app.get('/api/export', async (req, res) => {
  const data = await db.collection.find().toArray();

  // Transform and compress on worker thread
  const processed = await workerTasks.transformJSON(data, item => ({
    id: item._id.toString(),
    ...item,
    exportedAt: new Date(),
  }));

  const compressed = await workerTasks.compressData(JSON.stringify(processed));

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="export.json.gz"');
  return compressed;
});

// Import with decompression
app.post('/api/import', async (req, res) => {
  // Decompress on worker thread
  const decompressed = await workerTasks.decompressData(req.body);

  const data = JSON.parse(decompressed);

  // Validate and transform
  const validated = await workerTasks.transformJSON(data, item => ({
    ...item,
    importedAt: new Date(),
    status: 'active',
  }));

  await db.collection.insertMany(validated);

  return { success: true, imported: validated.length };
});
```

### Image Processing

```typescript
// Resize image on worker thread
app.post('/api/images/resize', async (req, res) => {
  const result = await workerTasks.heavyComputation('image:resize', {
    image: req.body.image,
    width: req.body.width,
    height: req.body.height,
  });

  return { image: result };
});

// Generate thumbnails
app.post('/api/images/thumbnails', async (req, res) => {
  const tasks = req.body.images.map((image, i) => ({
    id: `thumbnail-${i}`,
    type: 'image:thumbnail',
    data: { image, size: 150 },
    priority: 'normal',
  }));

  const workers = getWorkerManager();
  const thumbnails = await Promise.all(tasks.map(task => workers.executeTask(task)));

  return { thumbnails };
});
```

### Analytics Processing

```typescript
// Process analytics data
app.post('/api/analytics/process', async (req, res) => {
  const events = await db.events.find({ processed: false }).toArray();

  // Process in batches on worker threads
  const batchSize = 1000;
  const batches = [];

  for (let i = 0; i < events.length; i += batchSize) {
    batches.push(events.slice(i, i + batchSize));
  }

  const workers = getWorkerManager();
  const results = await Promise.all(
    batches.map((batch, i) =>
      workers.executeTask({
        id: `analytics-batch-${i}`,
        type: 'analytics:process',
        data: { events: batch },
        priority: 'low', // Background processing
      })
    )
  );

  const aggregated = results.reduce((acc, r) => ({ ...acc, ...r }), {});

  return { processed: events.length, results: aggregated };
});
```

---

## Behavior

### How Worker Threads Work

Worker threads execute code in separate V8 isolates:

- **Main Thread** - Continues processing I/O, HTTP requests, and event loop
- **Worker Threads** - Execute CPU-intensive tasks in parallel
- **Message Passing** - Data is serialized and passed between threads
- **Task Distribution** - WorkerManager assigns tasks to available workers

### Task Execution Flow

1. Task is submitted to WorkerManager
2. Task is added to queue (sorted by priority)
3. Available worker picks up task
4. Worker executes task in separate thread
5. Result is passed back to main thread
6. Promise resolves with result

### Suitable Operations

Operations that benefit from worker threads:

- Long-running computations
- Cryptographic operations (hashing, encryption)
- Data transformations on large datasets
- Compression/decompression
- JWT token operations

Operations that should NOT use worker threads:

- Database queries (already non-blocking)
- Network requests (already non-blocking)
- File I/O (already non-blocking)
- Simple synchronous operations with minimal CPU time

### Memory Usage

Worker threads use additional memory per worker:

- **Base overhead**: ~10MB per worker
- **Task data**: Varies by task
- **Recommended**: Leave 1 CPU core for main thread

```typescript
// Optimal configuration
const cpuCount = require('os').cpus().length;

const workers = new WorkerManager({
  workerCount: Math.max(1, cpuCount - 1), // Leave 1 for main thread
  maxQueueSize: 1000,
});
```

---

## Best Practices

### 1. Use Workers for CPU-Intensive Tasks Only

```typescript
// ✅ Good: CPU-intensive
await workerTasks.hashData(password, 'sha256');
await workerTasks.compressData(largeData);
await workerTasks.heavyComputation(complexCalc);

// ❌ Bad: I/O operations (already non-blocking)
await db.users.find(); // Use normal async/await
await fetch('https://api.example.com'); // Already non-blocking
```

### 2. Set Appropriate Priorities

```typescript
// High priority: User-facing operations
await workers.executeTask({
  type: 'jwt:verify',
  data: { token },
  priority: 'high',
});

// Normal priority: Regular operations
await workers.executeTask({
  type: 'crypto:hash',
  data: { input },
  priority: 'normal',
});

// Low priority: Background tasks
await workers.executeTask({
  type: 'analytics:process',
  data: { events },
  priority: 'low',
});
```

### 3. Handle Timeouts

```typescript
try {
  const result = await workers.executeTask({
    id: 'task-1',
    type: 'heavy:computation',
    data: { operation: 'complex' },
    timeout: 10000, // 10 seconds
  });
} catch (error) {
  if (error.message.includes('timeout')) {
    console.error('Task timed out');
    return res.status(504).json({ error: 'Processing timeout' });
  }
  throw error;
}
```

### 4. Batch Related Tasks

```typescript
// Process multiple items in parallel
const tasks = items.map((item, i) => ({
  id: `task-${i}`,
  type: 'crypto:hash',
  data: { input: item.password },
  priority: 'normal',
}));

const workers = getWorkerManager();
const results = await Promise.all(tasks.map(task => workers.executeTask(task)));
```

### 5. Monitor Worker Health

```typescript
// Check worker stats periodically
setInterval(() => {
  const stats = workers.getStats();

  if (stats.queueSize > 500) {
    console.warn('Worker queue is getting large:', stats);
  }

  if (stats.activeTasks === stats.workers) {
    console.log('All workers are busy');
  }
}, 10000);

// Expose metrics endpoint
app.get('/metrics/workers', (req, res) => {
  return workers.getStats();
});
```

### 6. Graceful Shutdown

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

process.on('SIGTERM', async () => {
  console.log('Shutting down workers...');
  await workers.shutdown();
  process.exit(0);
});
```

---

## Advanced Usage

### Custom Worker Tasks

Create custom tasks by extending the worker implementation:

```typescript
// Define custom task type
const CUSTOM_TASKS = {
  IMAGE_RESIZE: 'custom:image-resize',
  PDF_GENERATE: 'custom:pdf-generate',
};

// Execute custom task
await workers.executeTask({
  id: 'custom-1',
  type: CUSTOM_TASKS.IMAGE_RESIZE,
  data: {
    image: imageBuffer,
    width: 800,
    height: 600,
  },
});
```

### Task Queue Management

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

// Check queue before adding tasks
const stats = workers.getStats();

if (stats.queueSize < 800) {
  // Queue has capacity
  await workers.executeTask(task);
} else {
  // Queue is full, handle gracefully
  return res.status(503).json({
    error: 'Service busy, try again later',
  });
}
```

### Dynamic Worker Scaling

```typescript
// Adjust workers based on load
function adjustWorkers(load: number) {
  const optimal = Math.ceil(load / 100);
  const cpuCount = require('os').cpus().length;
  const workerCount = Math.min(optimal, cpuCount - 1);

  return new WorkerManager({ workerCount });
}

// Monitor and adjust
let currentLoad = 0;

app.use((req, res, next) => {
  currentLoad++;
  res.on('finish', () => currentLoad--);
  next();
});
```

### Error Handling

```typescript
try {
  const result = await workers.executeTask({
    id: 'task-1',
    type: 'crypto:hash',
    data: { input: 'test' },
  });
} catch (error) {
  if (error.code === 'WORKER_ERROR') {
    console.error('Worker task failed:', error.message);
  } else if (error.code === 'QUEUE_FULL') {
    console.error('Worker queue is full');
  } else if (error.code === 'TIMEOUT') {
    console.error('Task timed out');
  }

  throw error;
}
```

---

## Troubleshooting

### High Memory Usage

**Symptoms:** Memory usage grows with worker threads

**Solutions:**

1. Reduce worker count
2. Limit queue size
3. Process smaller batches
4. Add task timeouts

```typescript
const workers = new WorkerManager({
  workerCount: 2, // Reduce workers
  maxQueueSize: 500, // Limit queue
});
```

### Tasks Timing Out

**Symptoms:** Tasks frequently timeout

**Solutions:**

1. Increase timeout duration
2. Optimize task implementation
3. Break large tasks into smaller chunks

```typescript
await workers.executeTask({
  type: 'heavy:computation',
  data: { operation: 'complex' },
  timeout: 30000, // Increase timeout
});
```

### Queue Overflow

**Symptoms:** Queue size exceeds limit

**Solutions:**

1. Increase max queue size
2. Add more workers
3. Implement backpressure

```typescript
const stats = workers.getStats();

if (stats.queueSize >= stats.maxQueueSize * 0.8) {
  // Queue is 80% full - implement backpressure
  return res.status(503).json({
    error: 'Service busy',
    retryAfter: 60,
  });
}
```

### Worker Crashes

**Symptoms:** Workers crash or become unresponsive

**Solutions:**

1. Add error handling in tasks
2. Implement task validation
3. Monitor worker health

```typescript
// Validate task data
if (!task.data || !task.data.input) {
  throw new Error('Invalid task data');
}

// Monitor worker health
setInterval(() => {
  const stats = workers.getStats();
  if (stats.workers === 0) {
    console.error('All workers crashed!');
    // Restart workers
  }
}, 5000);
```

---

## Examples

### Complete Example: Authentication Service

```typescript
import { createApp, workerTasks } from '@morojs/moro';
import { z } from 'zod';

const app = await createApp();

// Registration with password hashing
app
  .post('/api/register')
  .body(
    z.object({
      email: z.string().email(),
      password: z.string().min(8),
    })
  )
  .handler(async (req, res) => {
    // Hash password on worker thread
    const hash = await workerTasks.hashData(req.body.password, 'sha256');

    const user = await db.users.create({
      email: req.body.email,
      password: hash,
    });

    // Generate token on worker thread
    const token = await workerTasks.signJWT({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    return { token, user: { id: user.id, email: user.email } };
  });

// Login
app
  .post('/api/login')
  .body(
    z.object({
      email: z.string().email(),
      password: z.string(),
    })
  )
  .handler(async (req, res) => {
    const user = await db.users.findOne({ email: req.body.email });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password on worker thread
    const hash = await workerTasks.hashData(req.body.password, 'sha256');

    if (hash !== user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Sign token on worker thread
    const token = await workerTasks.signJWT({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    return { token };
  });

// Protected route
app.get('/api/profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Verify on worker thread
  const result = await workerTasks.verifyJWT(token, process.env.JWT_SECRET);

  if (!result.valid) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = await db.users.findOne({ id: result.payload.userId });
  return user;
});

app.listen(3000);
```

---

## Reference

For more information, see:

- [API Reference](./API.md) - Complete API documentation
- [Performance Guide](./PERFORMANCE.md) - Optimization strategies
- [Examples Repository](https://github.com/Moro-JS/examples) - Real-world examples

---

**Need help?** Join our [Discord community](https://morojs.com/discord) or [open an issue](https://github.com/Moro-JS/moro/issues).
