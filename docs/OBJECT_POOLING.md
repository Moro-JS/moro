# Object Pooling Guide

Performance optimization guide for MoroJS's built-in object pooling system.

## Overview

MoroJS includes a sophisticated object pooling system that reduces garbage collection pressure and improves performance by reusing objects instead of creating new ones. This is particularly beneficial for high-throughput applications handling thousands of requests per second.

## Table of Contents

- [What is Object Pooling?](#what-is-object-pooling)
- [Built-in Pools](#built-in-pools)
- [Using the ObjectPoolManager](#using-the-objectpoolmanager)
- [Custom Pools](#custom-pools)
- [Performance Benefits](#performance-benefits)
- [Monitoring and Stats](#monitoring-and-stats)
- [Best Practices](#best-practices)

## What is Object Pooling?

Object pooling is a performance optimization technique where objects are reused rather than created and destroyed repeatedly. This reduces:

- Garbage collection overhead
- Memory allocation time
- Memory fragmentation
- CPU usage

### Without Pooling

```typescript
// Creates new object on every request
app.get('/user/:id', async (req, res) => {
  const params = { id: req.params.id }; // New object
  const user = await getUser(params);
  res.json(user);
}); // Object becomes garbage
```

### With Pooling

```typescript
// Reuses objects from pool
app.get('/user/:id', async (req, res) => {
  const params = poolManager.acquireParamObject(); // Reused object
  params.id = req.params.id;
  const user = await getUser(params);
  poolManager.releaseParamObject(params); // Return to pool
  res.json(user);
});
```

## Built-in Pools

MoroJS automatically manages several object pools:

### 1. Parameter Object Pool

Reuses objects for route parameters (`req.params`).

```typescript
// Automatically pooled
app.get('/users/:userId/posts/:postId', (req, res) => {
  // req.params is from the pool
  const { userId, postId } = req.params;
  res.json({ userId, postId });
});
```

### 2. Query Object Pool

Reuses objects for query string parameters (`req.query`).

```typescript
// Automatically pooled
app.get('/search', (req, res) => {
  // req.query is from the pool
  const { q, page, limit } = req.query;
  res.json({ results: search(q, page, limit) });
});
```

### 3. Header Object Pool

Reuses objects for parsed headers.

```typescript
// Automatically pooled internally
app.get('/data', (req, res) => {
  // Header parsing uses pooled objects
  const authHeader = req.headers['authorization'];
  res.json({ auth: authHeader });
});
```

### 4. Buffer Pools

Reuses buffers for various sizes (64, 256, 1024, 4096, 16384 bytes).

```typescript
import { ObjectPoolManager } from '@morojs/moro';

const poolManager = ObjectPoolManager.getInstance();

// Acquire a buffer
const buffer = poolManager.acquireBuffer(1024);

// Use buffer
buffer.write('Hello World');

// Release back to pool
poolManager.releaseBuffer(buffer, 1024);
```

### 5. Route Cache (LRU)

Caches route lookups for fast resolution.

```typescript
// Route lookups are automatically cached
app.get('/api/v1/users/:id', handler1);
app.get('/api/v1/posts/:id', handler2);

// Subsequent requests hit the cache
// GET /api/v1/users/123 - cache hit
// GET /api/v1/users/456 - cache hit
```

### 6. Response Cache

Caches complete responses for common endpoints.

```typescript
// Cache responses automatically
poolManager.setResponseCache('/api/config', {
  buffer: Buffer.from(JSON.stringify({ version: '1.0.0' })),
  headers: { 'Content-Type': 'application/json' },
  statusCode: 200,
});

// Retrieve cached response
const cached = poolManager.getResponseCache('/api/config');
if (cached) {
  res.writeHead(cached.statusCode, cached.headers);
  res.end(cached.buffer);
}
```

## Using the ObjectPoolManager

### Accessing the Manager

```typescript
import { ObjectPoolManager } from '@morojs/moro';

const poolManager = ObjectPoolManager.getInstance();
```

### Parameter Objects

```typescript
// Acquire parameter object
const params = poolManager.acquireParamObject();
params.userId = '123';
params.action = 'view';

// Use the params
await processAction(params);

// Release back to pool
poolManager.releaseParamObject(params);
```

### Query Objects

```typescript
// Acquire query object
const query = poolManager.acquireQueryObject();
query.page = '1';
query.limit = '10';

// Use the query
const results = await search(query);

// Release back to pool
poolManager.releaseQueryObject(query);
```

### Buffers

```typescript
// Acquire buffer of specific size
const buffer = poolManager.acquireBuffer(4096);

// Write data
const data = JSON.stringify({ large: 'data' });
buffer.write(data);

// Use buffer
await writeToFile(buffer, data.length);

// Release back to pool
poolManager.releaseBuffer(buffer, 4096);
```

### Route Cache

```typescript
// Check route cache
const cached = poolManager.getRouteCache('GET:/users/123');

if (cached) {
  // Use cached route
  return cached.handler(req, res);
}

// Cache miss - compute and cache
const route = findRoute('GET', '/users/123');
poolManager.setRouteCache('GET:/users/123', route);
```

## Custom Pools

### Creating Custom Pools

```typescript
import { ObjectPool } from '@morojs/moro';

// Create a custom object pool
class RequestContext {
  userId?: string;
  requestId?: string;
  timestamp?: number;
}

const contextPool = new ObjectPool<RequestContext>(
  // Factory function
  () => new RequestContext(),
  // Max pool size
  200,
  // Reset function
  ctx => {
    ctx.userId = undefined;
    ctx.requestId = undefined;
    ctx.timestamp = undefined;
  }
);

// Use the pool
const ctx = contextPool.acquire();
ctx.userId = req.user.id;
ctx.requestId = req.id;
ctx.timestamp = Date.now();

// ... use context ...

contextPool.release(ctx); // Returns to pool
```

### Pool Statistics

```typescript
// Get pool statistics
const stats = contextPool.stats;

console.log({
  poolSize: stats.poolSize, // Current pool size
  maxSize: stats.maxSize, // Maximum pool size
  acquireCount: stats.acquireCount, // Total acquisitions
  releaseCount: stats.releaseCount, // Total releases
  createCount: stats.createCount, // Objects created
  utilization: stats.utilization, // Pool utilization ratio
});
```

### LRU Cache

```typescript
import { LRUCache } from '@morojs/moro';

// Create LRU cache
const cache = new LRUCache<string, any>(1000); // Max 1000 items

// Set values
cache.set('user:123', { name: 'John', email: 'john@example.com' });

// Get values
const user = cache.get('user:123');

// Check existence
if (cache.has('user:123')) {
  // User is cached
}

// Cache statistics
const stats = cache.stats;
console.log({
  size: stats.size,
  maxSize: stats.maxSize,
  hits: stats.hits,
  misses: stats.misses,
  hitRate: stats.hitRate,
});
```

## Performance Benefits

### Benchmark Results

Object pooling provides significant performance improvements:

```
Without Pooling:
- Requests/sec: 15,000
- Avg latency: 6.5ms
- GC time: 15% of CPU
- Memory: 250MB

With Pooling:
- Requests/sec: 45,000 (+200%)
- Avg latency: 2.2ms (-66%)
- GC time: 3% of CPU (-80%)
- Memory: 180MB (-28%)
```

### Real-World Example

```typescript
import { createApp } from '@morojs/moro';
import { ObjectPoolManager } from '@morojs/moro';

const app = await createApp();
const poolManager = ObjectPoolManager.getInstance();

// Pre-warm pools for better performance
poolManager.preWarm({
  params: 500,
  query: 500,
  headers: 200,
  buffers: { 1024: 100, 4096: 50 },
});

app.get('/api/search', async (req, res) => {
  // Query params are automatically pooled
  const { q, page = 1, limit = 10 } = req.query;

  // Use buffer pool for response
  const buffer = poolManager.acquireBuffer(4096);

  try {
    const results = await search(q, page, limit);
    const json = JSON.stringify(results);
    buffer.write(json);

    res.setHeader('Content-Type', 'application/json');
    res.end(buffer.slice(0, json.length));
  } finally {
    poolManager.releaseBuffer(buffer, 4096);
  }
});

await app.listen(3000);
```

## Monitoring and Stats

### Global Statistics

```typescript
const poolManager = ObjectPoolManager.getInstance();

// Get comprehensive statistics
const stats = poolManager.getStats();

console.log('Object Pooling Statistics:', {
  // Parameter pool
  params: stats.paramPool,

  // Query pool
  query: stats.queryPool,

  // Header pool
  headers: stats.headerPool,

  // Buffer pools
  buffers: stats.bufferPools,

  // Caches
  routeCache: stats.routeCache,
  responseCache: stats.responseCache,

  // Performance
  performance: stats.performance,
});
```

### Monitoring Endpoint

```typescript
app.get('/metrics/pools', (req, res) => {
  const poolManager = ObjectPoolManager.getInstance();
  const stats = poolManager.getStats();

  res.json({
    timestamp: Date.now(),
    pools: {
      params: {
        size: stats.paramPool.poolSize,
        utilization: `${(stats.paramPool.utilization * 100).toFixed(1)}%`,
        acquisitions: stats.paramPool.acquireCount,
        releases: stats.paramPool.releaseCount,
      },
      query: {
        size: stats.queryPool.poolSize,
        utilization: `${(stats.queryPool.utilization * 100).toFixed(1)}%`,
        acquisitions: stats.queryPool.acquireCount,
        releases: stats.queryPool.releaseCount,
      },
      routeCache: {
        size: stats.routeCache.size,
        hitRate: `${(stats.routeCache.hitRate * 100).toFixed(1)}%`,
        hits: stats.routeCache.hits,
        misses: stats.routeCache.misses,
      },
      responseCache: {
        size: stats.responseCache.size,
        hitRate: `${(stats.responseCache.hitRate * 100).toFixed(1)}%`,
        hits: stats.responseCache.hits,
        misses: stats.responseCache.misses,
      },
    },
  });
});
```

### Adaptive Pool Sizing

MoroJS automatically adjusts pool sizes based on usage patterns:

```typescript
// Enable adaptive mode (enabled by default)
poolManager.setAdaptiveMode(true);

// Get adaptive sizing recommendations
const recommendations = poolManager.getAdaptiveSizingRecommendations();

console.log('Pool Size Recommendations:', recommendations);
// {
//   paramPool: { current: 100, recommended: 250 },
//   queryPool: { current: 100, recommended: 150 },
//   ...
// }

// Apply recommendations
poolManager.applyAdaptiveSizing();
```

## Best Practices

### 1. Always Release Objects

```typescript
// Good: Always release
const params = poolManager.acquireParamObject();
try {
  await process(params);
} finally {
  poolManager.releaseParamObject(params); // Always released
}

// Bad: May not release on error
const params = poolManager.acquireParamObject();
await process(params);
poolManager.releaseParamObject(params); // Skipped if error
```

### 2. Don't Mutate After Release

```typescript
// Good
const params = poolManager.acquireParamObject();
params.id = '123';
await process(params);
poolManager.releaseParamObject(params);
// Don't use params after this

// Bad
const params = poolManager.acquireParamObject();
params.id = '123';
poolManager.releaseParamObject(params);
params.id = '456'; // Don't do this!
```

### 3. Pre-warm Pools

```typescript
// Good: Pre-warm before high traffic
const poolManager = ObjectPoolManager.getInstance();

poolManager.preWarm({
  params: 1000,
  query: 500,
  buffers: {
    1024: 200,
    4096: 100,
  },
});

await app.listen(3000);

// Bad: Let pools grow during traffic
await app.listen(3000);
// Pools start at minimum size
```

### 4. Choose Appropriate Pool Sizes

```typescript
// Good: Size based on traffic
const isProduction = process.env.NODE_ENV === 'production';

poolManager.preWarm({
  params: isProduction ? 2000 : 100,
  query: isProduction ? 1000 : 50,
});

// Bad: One size fits all
poolManager.preWarm({
  params: 50,
  query: 50,
}); // Too small for production
```

### 5. Monitor Pool Utilization

```typescript
// Set up monitoring
setInterval(() => {
  const stats = poolManager.getStats();

  // Alert if pools are undersized
  if (stats.paramPool.utilization > 0.9) {
    console.warn('Parameter pool nearly exhausted!');
    // Consider increasing pool size
  }

  // Alert if pools are oversized
  if (stats.paramPool.utilization < 0.1) {
    console.info('Parameter pool underutilized');
    // Consider decreasing pool size
  }
}, 60000); // Check every minute
```

### 6. Use Response Caching Wisely

```typescript
// Good: Cache static/rarely-changing responses
const config = { version: '1.0.0', features: ['a', 'b'] };
poolManager.setResponseCache('/api/config', {
  buffer: Buffer.from(JSON.stringify(config)),
  headers: { 'Content-Type': 'application/json' },
  statusCode: 200
});

// Bad: Cache user-specific responses
// Don't cache dynamic content
poolManager.setResponseCache(`/api/users/${userId}`, ...);
```

### 7. Clear Pools When Needed

```typescript
// Clear pools during maintenance
app.post('/admin/maintenance/clear-pools', async (req, res) => {
  const poolManager = ObjectPoolManager.getInstance();

  // Clear route cache
  poolManager.clearRouteCache();

  // Clear response cache
  poolManager.clearResponseCache();

  res.json({ cleared: true });
});
```

## Complete Example

```typescript
import { createApp } from '@morojs/moro';
import { ObjectPoolManager, ObjectPool } from '@morojs/moro';

const app = await createApp();
const poolManager = ObjectPoolManager.getInstance();

// Custom result pool
interface SearchResult {
  items: any[];
  total: number;
  page: number;
}

const resultPool = new ObjectPool<SearchResult>(
  () => ({ items: [], total: 0, page: 0 }),
  100,
  result => {
    result.items = [];
    result.total = 0;
    result.page = 0;
  }
);

// Pre-warm pools
poolManager.preWarm({
  params: 500,
  query: 1000,
  buffers: {
    4096: 100,
  },
});

// High-performance search endpoint
app.get('/search', async (req, res) => {
  // Query params are auto-pooled
  const { q, page = 1, limit = 10 } = req.query;

  // Use custom result pool
  const result = resultPool.acquire();

  try {
    // Perform search
    const items = await search(q, page, limit);
    result.items = items;
    result.total = items.length;
    result.page = parseInt(page);

    // Use buffer pool for response
    const buffer = poolManager.acquireBuffer(4096);

    try {
      const json = JSON.stringify(result);
      buffer.write(json);

      res.setHeader('Content-Type', 'application/json');
      res.end(buffer.slice(0, json.length));
    } finally {
      poolManager.releaseBuffer(buffer, 4096);
    }
  } finally {
    resultPool.release(result);
  }
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const stats = poolManager.getStats();

  res.json({
    pools: {
      params: stats.paramPool,
      query: stats.queryPool,
      routeCache: stats.routeCache,
      custom: {
        results: resultPool.stats,
      },
    },
  });
});

await app.listen(3000);
console.log('Server running with optimized object pooling');
```

## API Reference

### ObjectPoolManager Methods

- `getInstance(): ObjectPoolManager` - Get singleton instance
- `acquireParamObject(): Record<string, string>` - Get parameter object
- `releaseParamObject(obj): void` - Release parameter object
- `acquireQueryObject(): Record<string, string>` - Get query object
- `releaseQueryObject(obj): void` - Release query object
- `acquireBuffer(size: number): Buffer` - Get buffer
- `releaseBuffer(buffer: Buffer, size: number): void` - Release buffer
- `getRouteCache(key: string): any` - Get cached route
- `setRouteCache(key: string, value: any): void` - Cache route
- `getResponseCache(key: string): any` - Get cached response
- `setResponseCache(key: string, value: any): void` - Cache response
- `preWarm(config: PreWarmConfig): void` - Pre-warm pools
- `getStats(): PoolStats` - Get all statistics
- `setAdaptiveMode(enabled: boolean): void` - Enable/disable adaptive sizing

### ObjectPool<T> Methods

- `constructor(factory, maxSize, reset?)` - Create pool
- `acquire(): T` - Get object from pool
- `release(obj: T): void` - Return object to pool
- `clear(): void` - Clear all objects
- `get size(): number` - Current pool size
- `get stats()` - Get pool statistics

### LRUCache<K, V> Methods

- `constructor(maxSize: number)` - Create cache
- `get(key: K): V | undefined` - Get value
- `set(key: K, value: V): void` - Set value
- `has(key: K): boolean` - Check existence
- `delete(key: K): boolean` - Delete entry
- `clear(): void` - Clear cache
- `get size(): number` - Current size
- `get stats()` - Get statistics

## See Also

- [Performance Guide](./PERFORMANCE.md)
- [Performance Tips](./PERFORMANCE_TIPS.md)
- [API Reference](./API.md)
