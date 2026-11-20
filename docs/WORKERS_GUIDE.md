# Worker Threads Guide

Complete guide to using Worker Threads in MoroJS for CPU-intensive operations.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Worker Tasks](#worker-tasks)
- [API Reference](#api-reference)
- [Use Cases](#use-cases)
- [Behavior](#behavior)
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
- **Built-in Tasks** - Pre-configured tasks for common operations (JWT, crypto, compression). The pool runs these task types only: a task with any other `type` rejects with `Unknown task type: <type>`

### When to Use Worker Threads

**Good Use Cases:**

- JWT token signing/verification
- Checksums and fingerprints (fast digests)
- Data encryption/decryption
- Large data transformations
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

Worker threads are built into Node.js and included in MoroJS core. The pool itself needs no additional dependencies; the JWT helpers need the `jsonwebtoken` package and `transformJSON` needs `isolated-vm`.

### Basic Usage

```typescript
import { createApp, getWorkerManager } from '@morojs/moro';

const app = await createApp();
const workers = getWorkerManager();

// Execute a task on worker thread: SHA-256 checksum of an uploaded document
app.post('/api/checksum', async (req, res) => {
  const result = await workers.executeTask({
    id: `hash-${Date.now()}`,
    type: 'crypto:hash',
    data: {
      data: req.body.content,
      algorithm: 'sha256',
    },
  });

  return { checksum: result };
});

app.listen(3000);
```

> **`crypto:hash` is not a password hash.** It computes a single fast, unsalted digest, which is right for checksums and fingerprints and wrong for passwords. Store passwords with a key-derivation function — see [Password Hashing](#password-hashing).

### Configuration

Configure worker thread pool on application startup:

```typescript
import { createApp, getWorkerManager, WorkerManager } from '@morojs/moro';

const app = await createApp({
  workers: {
    count: 4, // Number of worker threads (default: CPU cores - 1)
    maxQueueSize: 1000, // Maximum waiting tasks (default: 1000)
  },
});

// Or configure the shared pool directly: the first call creates it, later
// calls return the same pool and ignore their options
const workers = getWorkerManager({
  workerCount: 4,
  maxQueueSize: 1000,
});

// Or create a separate pool of your own
const ownPool = new WorkerManager({
  workerCount: 4,
  maxQueueSize: 1000,
});
```

The shared pool is the one `workerTasks`, `getWorkerManager()` and `app.executeOnWorker()` use, and its size is fixed by whichever call creates it. `createApp({ workers })` creates it in the background, so when you also call `getWorkerManager()` right after `createApp()`, pass it the same options.

The pool is shut down when the last app that uses it is closed (`await app.close()`). Whoever asks for it after that gets a new one: an app created later, or one that first uses workers then, takes it over like the first. A bare `getWorkerManager()`, `executeOnWorker()` or `workerTasks` call made when no app holds a pool starts one too and its tasks run, but its idle threads do not keep the process alive, so code that outlived its app cannot stop the process from ending.

### Memory limits per worker

`resourceLimits` sets V8 limits for every thread of the pool. It is passed to Node's `new Worker()` as given and is not set by default.

```typescript
const app = await createApp({
  workers: {
    count: 4,
    resourceLimits: {
      maxOldGenerationSizeMb: 512, // main heap of each worker
      maxYoungGenerationSizeMb: 64, // heap for short-lived objects
      stackSizeMb: 4, // default stack size
    },
  },
});

// The same option on a pool of your own
const ownPool = new WorkerManager({
  workerCount: 2,
  resourceLimits: { maxOldGenerationSizeMb: 256 },
});
```

- **Without it**, each worker has the heap ceiling Node gives any thread of the process: the same as the main thread's, not a share of it. On a 64 GB machine with Node 24 that is a 4096 MB old generation, a 192 MB young generation and a 4 MB stack per worker. Inside a worker, `resourceLimits` from `node:worker_threads` reports the values in force.
- **At a limit**, Node terminates that worker (`ERR_WORKER_OUT_OF_MEMORY`). The task it was running is rejected, the other workers and the main thread are not affected, and the pool starts a replacement with the same limits.
- The limits cover the JavaScript heap only. Buffers and other memory outside the heap are not counted.
- `--max-old-space-size` on the Node command line applies to worker threads too and takes precedence over `maxOldGenerationSizeMb`.

Choose a limit above what your largest task needs: a task that reaches it is not retried.

---

## Worker Tasks

### Built-in Tasks

MoroJS includes several pre-configured worker tasks:

#### JWT Operations

```typescript
import { workerTasks } from '@morojs/moro';

// Verify JWT token (resolves to the decoded payload, rejects if the token is invalid)
app.post('/api/auth/verify', async (req, res) => {
  try {
    const payload = await workerTasks.verifyJWT(req.body.token, process.env.JWT_SECRET);
    return { user: payload };
  } catch {
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

`options` are the `jsonwebtoken` options for `sign()` / `verify()` (`expiresIn`,
`audience`, `issuer`, …). `verifyJWT` accepts HS256 tokens only unless you name
the algorithms yourself, and refuses a PEM public key or certificate as the
secret until you do:

```typescript
import { workerTasks } from '@morojs/moro';

// Tokens signed with a private key: verify with the public key and say which algorithm
const payload = await workerTasks.verifyJWT(token, process.env.JWT_PUBLIC_KEY, {
  algorithms: ['RS256'],
});
```

Without `algorithms`, a public key would be used as an HS256 secret, which
anyone holding the public key can sign with; that call rejects with `JWT
verification with a public key requires options.algorithms`.

#### Cryptographic Operations

```typescript
// Fingerprint a document (checksums, cache keys, deduplication)
app.post('/api/documents', async (req, res) => {
  const checksum = await workerTasks.hash(req.body.content, 'sha256');

  const document = await saveDocument({
    content: req.body.content,
    checksum,
  });

  return document;
});

// Encryption has no helper on workerTasks: run the built-in 'crypto:encrypt' and
// 'crypto:decrypt' task types. The default algorithm is aes-256-cbc, so the key
// must be 32 bytes. A random IV is generated for every call.
const workers = getWorkerManager(); // import { getWorkerManager } from '@morojs/moro'

// Encrypt sensitive data
app.post('/api/secrets', async (req, res) => {
  const encrypted = await workers.executeTask<string>({
    id: `encrypt-${Date.now()}`,
    type: 'crypto:encrypt',
    data: { data: req.body.secret, key: process.env.ENCRYPTION_KEY },
  });

  return { encrypted }; // "<iv hex>:<ciphertext hex>"
});

// Decrypt data
app.get('/api/secrets/:id', async (req, res) => {
  const secret = await getSecret(req.params.id);

  const decrypted = await workers.executeTask<string>({
    id: `decrypt-${req.params.id}`,
    type: 'crypto:decrypt',
    data: { data: secret.data, key: process.env.ENCRYPTION_KEY },
  });

  return { secret: decrypted };
});
```

#### Password Hashing

Do not hash passwords with `workerTasks.hash` / `crypto:hash`. A plain SHA-256 digest is fast and unsalted, so equal passwords produce equal hashes and a leaked table can be brute-forced cheaply. Passwords need a deliberately slow, salted key-derivation function, and stored hashes must be compared in constant time.

There is no built-in worker task for this, and none is needed: Node's asynchronous `crypto.scrypt` already runs on the libuv thread pool, so it does not block the event loop.

```typescript
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

// Stored format: "<salt hex>:<derived key hex>". Every password gets its own random salt.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  const actual = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH)) as Buffer;
  // Constant-time comparison: never compare hashes with === / !==.
  return timingSafeEqual(actual, expected);
}
```

```typescript
app.post('/api/register', async (req, res) => {
  const user = await createUser({
    email: req.body.email,
    password: await hashPassword(req.body.password),
  });

  return { id: user.id, email: user.email };
});
```

#### Data Compression

```typescript
// Compress large response
app.get('/api/export', async (req, res) => {
  const data = await getLargeDataset();

  // Formats: 'gzip' (default), 'deflate', 'brotli'. Resolves to a Buffer.
  const compressed = await workerTasks.compress(JSON.stringify(data));

  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Type', 'application/json');
  return compressed;
});

// Decompress data (here the client sends the gzip bytes base64-encoded in a JSON body)
app.post('/api/import', async (req, res) => {
  // Takes a Buffer or Uint8Array and resolves to a Buffer
  const decompressed = await workerTasks.decompress(Buffer.from(req.body.data, 'base64'));

  const data = JSON.parse(decompressed.toString('utf8'));
  await importData(data);

  return { success: true, records: data.length };
});
```

#### Heavy Computation

```typescript
// Run the built-in CPU-bound routine: { iterations } resolves to { result, iterations }
app.post('/api/calculate', async (req, res) => {
  const result = await workerTasks.heavyComputation({ iterations: 1_000_000 });

  return { result };
});

// Transform large JSON. The transformer is sent to the worker as source text:
// it receives the whole value and cannot use anything defined outside its own
// body. transformJSON requires the optional `isolated-vm` package
// (npm install isolated-vm): the transformer runs inside an isolate with no
// access to Node.js APIs. Without the package the call is rejected at once
// with an error that names it, and the transformer is not run.
app.post('/api/transform', async (req, res) => {
  const transformed = await workerTasks.transformJSON(req.body.data, (rows: any[]) =>
    rows.map(row => ({
      ...row,
      total: row.price * row.quantity,
    }))
  );

  return transformed;
});
```

### Task Priority

Priority orders the tasks that are waiting for a worker. Each worker runs one task at a time; when every worker is busy, waiting tasks are dispatched highest priority first, and first in, first out within the same priority:

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

// High priority task (executes first)
await workers.executeTask({
  id: 'critical-task',
  type: 'crypto:hash',
  data: { data: 'critical-data' },
  priority: 'high', // 'high' | 'normal' | 'low'
});

// Normal priority (default)
await workers.executeTask({
  id: 'normal-task',
  type: 'crypto:hash',
  data: { data: 'normal-data' },
  priority: 'normal',
});

// Low priority (executes last)
await workers.executeTask({
  id: 'background-task',
  type: 'crypto:hash',
  data: { data: 'background-data' },
  priority: 'low',
});
```

### Task Timeout

Set timeout for long-running tasks:

```typescript
await workers.executeTask({
  id: 'long-task',
  type: 'computation:heavy',
  data: { iterations: 50_000_000 },
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
  maxQueueSize?: number;   // Max waiting tasks (default: 1000); beyond it executeTask rejects with 'Worker queue is full'
  resourceLimits?: {       // V8 limits per worker, passed to new Worker() (default: not set)
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  };
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
  workerCount: number; // live worker threads
  busyWorkers: number; // workers with a dispatched task that has not settled
  idleWorkers: number;
  activeTasks: number; // submitted tasks that have not settled (queued + running)
  queuedTasks: number; // tasks waiting for a worker
  isShuttingDown: boolean;
}
```

##### shutdown()

Shut down the worker pool: tasks that have not settled are rejected with `Worker manager shutting down` and the threads are terminated. The manager stays shut down; the next `getWorkerManager()` call returns a new one.

```typescript
await shutdown(): Promise<void>
```

### Worker Tasks Helper

Pre-configured task helpers for common operations.

```typescript
import { workerTasks } from '@morojs/moro';

// JWT operations (require the `jsonwebtoken` package)
workerTasks.verifyJWT(token, secret, options?): Promise<any> // decoded payload; rejects if invalid; HS256 unless options.algorithms
workerTasks.signJWT(payload, secret, options?): Promise<string>

// Cryptography
workerTasks.hash(data, algorithm?): Promise<string> // fast digest (default 'sha256') — not for passwords
// Encryption has no helper: use the 'crypto:encrypt' / 'crypto:decrypt' task types
// with executeTask (see Cryptographic Operations)

// Compression: `format` is 'gzip' (default), 'deflate' or 'brotli'
workerTasks.compress(data, { format? }): Promise<Buffer> // data: string | Buffer | Uint8Array
// `maxOutputLength` caps the decompressed size in bytes (default 256 MiB);
// larger output rejects with "Decompressed data exceeds the ... byte limit".
workerTasks.decompress(data, { format?, maxOutputLength? }): Promise<Buffer> // data: Buffer | Uint8Array

// Computation
workerTasks.heavyComputation(data): Promise<any>
workerTasks.transformJSON(data, transformer): Promise<any> // requires the `isolated-vm` package
```

### Global Helpers

```typescript
import { createApp, getWorkerManager } from '@morojs/moro';

// Get singleton worker manager
const workers = getWorkerManager();

// Execute task directly from the app (runs on the same pool)
const app = await createApp();
const result = await app.executeOnWorker({
  id: 'task-1',
  type: 'crypto:hash',
  data: { data: 'test', algorithm: 'sha256' },
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

  // verifyPassword: the scrypt + timingSafeEqual helper from "Password Hashing" above
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

  // Resolves to the decoded payload, rejects if the token is invalid
  let payload;
  try {
    payload = await workerTasks.verifyJWT(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = await db.users.findOne({ id: payload.userId });
  return user;
});
```

### Data Export/Import

```typescript
// Export large dataset with compression
app.get('/api/export', async (req, res) => {
  const data = await db.collection.find().toArray();

  // Transform and compress on worker thread.
  // The transformer receives the whole array and must be self-contained;
  // transformJSON requires the optional `isolated-vm` package.
  const processed = await workerTasks.transformJSON(data, (rows: any[]) =>
    rows.map(row => ({
      ...row,
      exportedAt: Date.now(),
    }))
  );

  const compressed = await workerTasks.compress(JSON.stringify(processed));

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="export.json.gz"');
  return compressed;
});

// Import with decompression (the upload is sent as application/gzip, so req.body is a Buffer)
app.post('/api/import', async (req, res) => {
  // Decompress on worker thread
  const decompressed = await workerTasks.decompress(req.body);

  const data = JSON.parse(decompressed.toString('utf8'));

  // Validate and transform
  const validated = await workerTasks.transformJSON(data, (rows: any[]) =>
    rows.map(row => ({
      ...row,
      importedAt: Date.now(),
      status: 'active',
    }))
  );

  await db.collection.insertMany(validated);

  return { success: true, imported: validated.length };
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

  // Count events per type, one batch per worker task.
  // transformJSON requires the optional `isolated-vm` package.
  const results = await Promise.all(
    batches.map(batch =>
      workerTasks.transformJSON(batch, (rows: any[]) =>
        rows.reduce(
          (counts, event) => {
            counts[event.type] = (counts[event.type] || 0) + 1;
            return counts;
          },
          {} as Record<string, number>
        )
      )
    )
  );

  // Merge the per-batch counts
  const aggregated: Record<string, number> = {};
  for (const counts of results) {
    for (const [type, count] of Object.entries<number>(counts)) {
      aggregated[type] = (aggregated[type] || 0) + count;
    }
  }

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
- **Heap ceiling**: each worker can grow to the same heap limit as the main thread unless `resourceLimits` is set (see [Memory limits per worker](#memory-limits-per-worker))
- **Recommended**: Leave 1 CPU core for main thread

```typescript
// Optimal configuration
import { cpus } from 'node:os';

const cpuCount = cpus().length;

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
await workerTasks.hash(fileContents, 'sha256'); // checksum — passwords use scrypt, see Password Hashing
await workerTasks.compress(largeData);
await workerTasks.heavyComputation(complexCalc);

// ❌ Bad: I/O operations (already non-blocking)
await db.users.find(); // Use normal async/await
await fetch('https://api.example.com'); // Already non-blocking
```

### 2. Set Appropriate Priorities

```typescript
// High priority: User-facing operations
await workers.executeTask({
  id: 'verify-1',
  type: 'jwt:verify',
  data: { token, secret: process.env.JWT_SECRET },
  priority: 'high',
});

// Normal priority: Regular operations
await workers.executeTask({
  id: 'hash-1',
  type: 'crypto:hash',
  data: { data: input, algorithm: 'sha256' },
  priority: 'normal',
});

// Low priority: Background tasks
await workers.executeTask({
  id: 'background-1',
  type: 'computation:heavy',
  data: { iterations: 50_000_000 },
  priority: 'low',
});
```

### 3. Handle Timeouts

```typescript
try {
  const result = await workers.executeTask({
    id: 'task-1',
    type: 'computation:heavy',
    data: { iterations: 50_000_000 },
    timeout: 10000, // 10 seconds
  });
} catch (error) {
  // A timed-out task rejects with "Task <id> timed out"
  if (error.message.includes('timed out')) {
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
  data: { data: item.content, algorithm: 'sha256' },
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

  if (stats.queuedTasks > 500) {
    console.warn('Worker queue is getting large:', stats);
  }

  if (stats.idleWorkers === 0) {
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

### Task Queue Management

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

// Check queue before adding tasks
const stats = workers.getStats();

if (stats.queuedTasks < 800) {
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
  const cpuCount = cpus().length; // import { cpus } from 'node:os'
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
    data: { data: 'test', algorithm: 'sha256' },
  });
} catch (error) {
  // Worker errors are plain Error objects: tell them apart by message
  if (error.message === 'Worker queue is full') {
    console.error('Worker queue is full');
  } else if (error.message.endsWith('timed out')) {
    console.error('Task timed out');
  } else {
    console.error('Worker task failed:', error.message);
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
5. Cap each worker's heap with `resourceLimits`

```typescript
const workers = new WorkerManager({
  workerCount: 2, // Reduce workers
  maxQueueSize: 500, // Limit queue
  resourceLimits: { maxOldGenerationSizeMb: 512 }, // A worker that reaches it is replaced
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
  id: 'long-task',
  type: 'computation:heavy',
  data: { iterations: 50_000_000 },
  timeout: 30000, // Increase timeout
});
```

### Queue Overflow

**Symptoms:** `executeTask` rejects with `Worker queue is full`

**Solutions:**

1. Increase max queue size
2. Add more workers
3. Implement backpressure

```typescript
const MAX_QUEUE_SIZE = 1000; // the maxQueueSize the pool was created with
const stats = workers.getStats();

if (stats.queuedTasks >= MAX_QUEUE_SIZE * 0.8) {
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
// Validate task data before submitting it (here: a 'crypto:hash' task)
if (!task.data || typeof task.data.data !== 'string') {
  throw new Error('Invalid task data');
}

// Monitor worker health (a crashed worker is restarted automatically)
setInterval(() => {
  const stats = workers.getStats();
  if (stats.workerCount === 0) {
    console.error('No live workers!');
  }
}, 5000);
```

---

## Examples

### Complete Example: Authentication Service

```typescript
import { createApp, workerTasks } from '@morojs/moro';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const app = await createApp();

// Passwords: salted scrypt + constant-time compare (see "Password Hashing").
// crypto.scrypt runs on the libuv thread pool, so it needs no worker task.
const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  const actual = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH)) as Buffer;
  return timingSafeEqual(actual, expected);
}

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
    // Salted scrypt hash (off the event loop via the libuv thread pool)
    const hash = await hashPassword(req.body.password);

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

    // Verify against the stored scrypt hash in constant time
    if (!(await verifyPassword(req.body.password, user.password))) {
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

  // Verify on worker thread (resolves to the decoded payload, rejects if invalid)
  let payload;
  try {
    payload = await workerTasks.verifyJWT(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = await db.users.findOne({ id: payload.userId });
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
