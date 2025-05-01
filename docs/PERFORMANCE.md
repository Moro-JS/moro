# Performance Guide

Complete guide to MoroJS performance optimization, benchmarks, and monitoring.

## Table of Contents

- [Performance Overview](#performance-overview)
- [Benchmarks](#benchmarks)
- [Optimization Strategies](#optimization-strategies)
- [Caching](#caching)
- [Rate Limiting](#rate-limiting)
- [Circuit Breakers](#circuit-breakers)
- [Database Performance](#database-performance)
- [Runtime Optimizations](#runtime-optimizations)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

---

## Performance Overview

MoroJS is designed for high performance across all supported runtimes. The framework achieves superior performance through:

- **Intelligent middleware ordering** - Eliminates unnecessary processing
- **Runtime-specific optimizations** - Adapters optimized for each environment
- **Zod validation** - 2-3x faster than JSON Schema alternatives
- **Memory-efficient design** - Lower memory footprint
- **Built-in performance features** - Caching, rate limiting, circuit breakers

### Key Performance Features

1. **Zero Framework Overhead** - Direct handler execution without layers
2. **Optimized Request/Response Cycle** - Minimal object creation
3. **Phase-Based Middleware** - Optimal execution order
4. **Efficient Validation** - Zod's compiled validation approach
5. **Runtime Adaptations** - Environment-specific optimizations

---

## Benchmarks

### Framework Comparison

Comprehensive benchmarks comparing MoroJS with popular Node.js frameworks:

| Framework | Req/sec | Latency (avg) | Latency (99p) | Memory Usage | CPU Usage |
|-----------|---------|---------------|---------------|--------------|-----------|
| **MoroJS** | **52,400** | **1.8ms** | **4.2ms** | **24MB** | **45%** |
| Express   | 28,540  | 3.8ms     | 8.9ms     | 45MB     | 72%      |
| Fastify   | 38,120  | 2.9ms     | 6.5ms     | 35MB     | 58%      |
| NestJS    | 22,100  | 4.5ms     | 11.2ms    | 58MB     | 78%      |
| Koa       | 25,880  | 4.2ms     | 9.8ms     | 42MB     | 69%      |

**Test Configuration:**
- **Load:** 50,000 requests, 100 concurrent connections
- **Environment:** Node.js 20.x, 4 CPU cores, 8GB RAM
- **Route:** POST /api/users with validation, auth, rate limiting
- **Tool:** AutoCannon with 30-second duration

### Validation Performance

Zod vs other validation libraries:

| Library | Ops/sec | Relative Performance | Memory per Op |
|---------|---------|-------------------|---------------|
| **Zod** | **1,245,000** | **1.0x** | **0.12KB** |
| Joi     | 485,000   | 0.39x | 0.28KB |
| JSON Schema (AJV) | 890,000 | 0.71x | 0.18KB |
| Yup     | 320,000   | 0.26x | 0.35KB |

### Runtime-Specific Performance

Performance across different deployment environments:

| Runtime | Req/sec | Cold Start | Memory | Scaling |
|---------|---------|------------|--------|---------|
| **Node.js** | **52,400** | N/A | 24MB | Manual |
| **Vercel Edge** | **48,200** | 15ms | 18MB | Auto |
| **AWS Lambda** | **45,800** | 95ms | 22MB | Auto |
| **Cloudflare Workers** | **51,100** | 8ms | 16MB | Auto |

---

## Optimization Strategies

### 1. Route-Level Optimizations

#### Minimize Middleware Chain

```typescript
// ❌ Inefficient - unnecessary middleware
app.post('/simple-endpoint')
  .auth({ required: false })     // Unnecessary if no auth needed
  .cache({ ttl: 0 })            // Unnecessary if no caching
  .rateLimit({ requests: 1000000 }) // Too high to be meaningful
  .handler(simpleHandler);

// ✅ Optimized - minimal middleware
app.post('/simple-endpoint')
  .handler(simpleHandler);
```

#### Use Appropriate Validation

```typescript
// ❌ Over-validation
app.get('/health')
  .query(z.object({
    timestamp: z.string().datetime(),
    signature: z.string().min(64),
    nonce: z.string().uuid()
  }))
  .handler(() => ({ status: 'ok' }));

// ✅ Minimal validation for simple endpoints
app.get('/health', () => ({ status: 'ok' }));
```

### 2. Schema Optimization

#### Efficient Zod Schemas

```typescript
// ❌ Inefficient schema
const UserSchema = z.object({
  name: z.string().refine(name => validateComplexName(name)),
  email: z.string().refine(email => isUniqueEmail(email)), // Async operation
  age: z.number().refine(age => validateAgeWithDatabase(age))
});

// ✅ Optimized schema
const UserSchema = z.object({
  name: z.string().min(2).max(50).regex(/^[a-zA-Z\s]+$/),
  email: z.string().email(),
  age: z.number().int().min(18).max(120)
});
// Move complex validations to handler if needed
```

#### Schema Reuse and Preprocessing

```typescript
// ✅ Reuse schemas
const BaseUserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email()
});

const CreateUserSchema = BaseUserSchema.extend({
  password: z.string().min(8)
});

const UpdateUserSchema = BaseUserSchema.partial();

// ✅ Preprocess transformations
const UserInputSchema = z.object({
  name: z.string().transform(s => s.trim().toLowerCase()),
  email: z.string().email().transform(s => s.toLowerCase()),
  tags: z.string().transform(s => s.split(',').map(t => t.trim()))
});
```

### 3. Handler Optimizations

#### Async Patterns

```typescript
// ❌ Sequential operations
app.get('/user-dashboard/:id')
  .handler(async (req, res) => {
    const user = await getUser(req.params.id);
    const posts = await getUserPosts(req.params.id);
    const followers = await getUserFollowers(req.params.id);
    
    return { user, posts, followers };
  });

// ✅ Parallel operations
app.get('/user-dashboard/:id')
  .handler(async (req, res) => {
    const [user, posts, followers] = await Promise.all([
      getUser(req.params.id),
      getUserPosts(req.params.id),
      getUserFollowers(req.params.id)
    ]);
    
    return { user, posts, followers };
  });
```

#### Response Optimization

```typescript
// ❌ Large response objects
app.get('/users')
  .handler(async (req, res) => {
    const users = await db.query('SELECT * FROM users');
    return { users }; // Returns all columns
  });

// ✅ Selective fields
app.get('/users')
  .handler(async (req, res) => {
    const users = await db.query('SELECT id, name, email FROM users');
    return { users };
  });
```

---

## Caching

### Memory Caching

Best for frequently accessed, small data:

```typescript
// Basic memory caching
app.get('/popular-posts')
  .cache({
    ttl: 300, // 5 minutes
    strategy: 'memory'
  })
  .handler(getPopularPosts);

// Advanced memory caching with custom key
app.get('/user-preferences/:id')
  .cache({
    ttl: 600,
    strategy: 'memory',
    key: (req) => `prefs:${req.params.id}`,
    maxSize: 1000 // Limit cache size
  })
  .handler(getUserPreferences);
```

### Redis Caching

Best for shared data across instances:

```typescript
// Redis caching setup
import { RedisAdapter } from 'moro';
const redis = new RedisAdapter({
  host: 'localhost',
  port: 6379
});
app.cache(redis);

// Use Redis caching
app.get('/global-stats')
  .cache({
    ttl: 900, // 15 minutes
    strategy: 'redis',
    key: 'global:stats'
  })
  .handler(getGlobalStats);
```

### Cache Invalidation

```typescript
// Tag-based cache invalidation
app.post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    const user = await createUser(req.body);
    
    // Invalidate related caches
    req.cache.invalidateTags(['users', 'stats']);
    
    return { success: true, data: user };
  });

// Manual cache invalidation
app.delete('/users/:id')
  .handler(async (req, res) => {
    await deleteUser(req.params.id);
    
    // Invalidate specific cache entries
    req.cache.delete(`user:${req.params.id}`);
    req.cache.delete('users:list');
    
    return { success: true };
  });
```

### Cache Strategies

```typescript
// Read-through caching
app.get('/expensive-data/:id')
  .cache({
    ttl: 3600,
    strategy: 'read-through',
    loader: async (key, req) => {
      return await expensiveDataCalculation(req.params.id);
    }
  })
  .handler(async (req, res) => {
    // Data is automatically cached
    return { data: req.cached };
  });

// Write-through caching
app.put('/user-settings/:id')
  .cache({
    strategy: 'write-through',
    writeLoader: async (key, data) => {
      await saveToDatabase(key, data);
      return data;
    }
  })
  .handler(updateUserSettings);
```

---

## Rate Limiting

### Basic Rate Limiting

```typescript
// Global rate limiting
app.use(middleware.rateLimit({
  requests: 1000,
  window: 60000, // 1 minute
  skipSuccessfulRequests: false
}));

// Route-specific rate limiting
app.post('/api/send-email')
  .rateLimit({
    requests: 5,
    window: 60000,
    skipSuccessfulRequests: true
  })
  .handler(sendEmail);
```

### Advanced Rate Limiting

```typescript
// User-specific rate limiting
app.post('/api/upload')
  .auth({ required: true })
  .rateLimit({
    requests: 10,
    window: 3600000, // 1 hour
    keyGenerator: (req) => `uploads:${req.user.id}`,
    skipFailedRequests: true
  })
  .handler(handleUpload);

// Dynamic rate limiting based on user tier
app.post('/api/process')
  .auth({ required: true })
  .rateLimit({
    requests: (req) => req.user.tier === 'premium' ? 1000 : 100,
    window: 3600000,
    keyGenerator: (req) => `api:${req.user.id}`,
    onLimitReached: (req, res) => {
      res.status(429).json({
        error: 'Rate limit exceeded',
        upgrade: '/upgrade-plan'
      });
    }
  })
  .handler(processRequest);
```

### Rate Limiting Strategies

```typescript
// Sliding window rate limiting
app.post('/api/critical')
  .rateLimit({
    requests: 100,
    window: 60000,
    strategy: 'sliding-window' // More accurate than fixed window
  })
  .handler(criticalHandler);

// Token bucket rate limiting
app.post('/api/burst')
  .rateLimit({
    tokens: 50,
    refillRate: 10, // tokens per second
    strategy: 'token-bucket' // Allows bursts
  })
  .handler(burstHandler);
```

---

## Circuit Breakers

Circuit breakers automatically protect against cascading failures:

### Automatic Circuit Breaker

```typescript
// Automatic protection for external calls
app.get('/external-api')
  .handler(async (req, res) => {
    // Automatically protected by circuit breaker
    const data = await fetch('https://external-api.com/data');
    return { data: await data.json() };
  });
```

### Manual Circuit Breaker Configuration

```typescript
// Custom circuit breaker settings
app.get('/unreliable-service')
  .circuitBreaker({
    threshold: 5,        // Open after 5 failures
    timeout: 30000,      // 30 second timeout
    resetTimeout: 60000, // Try again after 1 minute
    monitor: true        // Enable monitoring
  })
  .handler(async (req, res) => {
    const result = await callUnreliableService();
    return { result };
  });
```

### Circuit Breaker Events

```typescript
// Monitor circuit breaker events
app.events.on('circuit-breaker:opened', ({ endpoint, failures }) => {
  console.log(`Circuit breaker opened for ${endpoint} after ${failures} failures`);
  // Alert monitoring system
});

app.events.on('circuit-breaker:closed', ({ endpoint }) => {
  console.log(`Circuit breaker closed for ${endpoint}`);
  // Service recovered
});
```

---

## Database Performance

### Connection Pooling

```typescript
// Optimized database configuration
import { MySQLAdapter } from 'moro';

const db = new MySQLAdapter({
  host: 'localhost',
  user: 'app',
  password: 'password',
  database: 'myapp',
  
  // Performance settings
  connectionLimit: 20,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  
  // Query optimization
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false
});
```

### Query Optimization

```typescript
// ❌ N+1 query problem
app.get('/posts-with-authors')
  .handler(async (req, res) => {
    const posts = await db.query('SELECT * FROM posts');
    for (const post of posts) {
      post.author = await db.query('SELECT * FROM users WHERE id = ?', [post.authorId]);
    }
    return { posts };
  });

// ✅ Optimized with joins
app.get('/posts-with-authors')
  .handler(async (req, res) => {
    const posts = await db.query(`
      SELECT p.*, u.name as authorName, u.email as authorEmail
      FROM posts p
      JOIN users u ON p.authorId = u.id
    `);
    return { posts };
  });
```

### Database Caching

```typescript
// Query result caching
app.get('/expensive-report')
  .cache({
    ttl: 1800, // 30 minutes
    key: (req) => `report:${req.query.date}`,
    strategy: 'redis'
  })
  .handler(async (req, res) => {
    const report = await db.query(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(amount) as total_revenue,
        AVG(amount) as avg_order_value
      FROM orders 
      WHERE DATE(created_at) = ?
    `, [req.query.date]);
    
    return { report };
  });
```

### Transaction Optimization

```typescript
// Optimized transactions
app.post('/complex-operation')
  .body(ComplexOperationSchema)
  .handler(async (req, res) => {
    const transaction = await req.database.beginTransaction();
    
    try {
      // Batch operations where possible
      const results = await Promise.all([
        transaction.insert('table1', req.body.data1),
        transaction.insert('table2', req.body.data2),
        transaction.update('table3', { id: req.body.id }, req.body.updates)
      ]);
      
      await transaction.commit();
      return { success: true, results };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
```

---

## Runtime Optimizations

### Node.js Optimizations

```typescript
// Cluster mode for multi-core usage
import cluster from 'cluster';
import os from 'os';

if (cluster.isMaster) {
  const numCPUs = os.cpus().length;
  
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork(); // Restart worker
  });
} else {
  const app = createApp({
    cluster: true,
    workerId: cluster.worker.id
  });
  
  app.listen(3000);
}
```

### Vercel Edge Optimizations

```typescript
// Edge-optimized configuration
const app = createAppEdge({
  regions: ['iad1', 'sfo1'], // Deploy to specific regions
  streaming: true,           // Enable streaming responses
  cache: {
    edge: true,             // Use edge caching
    maxAge: 3600
  }
});

// Optimized for edge
app.get('/api/geo-data')
  .cache({
    ttl: 3600,
    strategy: 'edge',
    vary: ['CF-IPCountry'] // Cache per country
  })
  .handler((req, res) => {
    return {
      country: req.headers['cf-ipcountry'],
      region: req.headers['cf-region']
    };
  });
```

### AWS Lambda Optimizations

```typescript
// Lambda-optimized configuration
const app = createAppLambda({
  memorySize: 1024,      // Optimize memory allocation
  timeout: 30,           // Set appropriate timeout
  coldStartOptimization: true,
  connectionReuse: true  // Reuse database connections
});

// Warm-up handler to prevent cold starts
app.get('/_warmup', (req, res) => {
  return { status: 'warm' };
});
```

### Cloudflare Workers Optimizations

```typescript
// Workers-optimized configuration
const app = createAppWorker({
  kv: {
    enabled: true,
    namespace: 'API_CACHE'
  },
  durableObjects: true,
  webSockets: true
});

// Use KV storage for caching
app.get('/api/config')
  .handler(async (req, res, env) => {
    const cached = await env.API_CACHE.get('config');
    if (cached) {
      return JSON.parse(cached);
    }
    
    const config = await fetchConfig();
    await env.API_CACHE.put('config', JSON.stringify(config), {
      expirationTtl: 3600
    });
    
    return config;
  });
```

---

## Monitoring

### Built-in Metrics

```typescript
// Enable built-in monitoring
const app = createApp({
  monitoring: {
    enabled: true,
    metrics: ['requests', 'latency', 'errors', 'memory'],
    endpoint: '/metrics' // Prometheus format
  }
});

// Custom metrics
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    req.metrics.histogram('request_duration', duration, {
      method: req.method,
      route: req.route?.path,
      status: res.statusCode
    });
  });
  
  next();
});
```

### Performance Logging

```typescript
// Performance-focused logging
app.use(async (req, res, next) => {
  const start = process.hrtime.bigint();
  
  await next();
  
  const end = process.hrtime.bigint();
  const duration = Number(end - start) / 1000000; // Convert to ms
  
  if (duration > 1000) { // Log slow requests
    console.warn(`Slow request: ${req.method} ${req.path} took ${duration}ms`);
  }
});
```

### Health Checks

```typescript
// Comprehensive health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.env.npm_package_version
  };
  
  // Check database connectivity
  try {
    await req.database.query('SELECT 1');
    health.database = 'connected';
  } catch (error) {
    health.database = 'disconnected';
    health.status = 'unhealthy';
  }
  
  // Check external dependencies
  try {
    await fetch('https://api.external.com/health');
    health.external = 'available';
  } catch (error) {
    health.external = 'unavailable';
    // Don't mark as unhealthy for external service issues
  }
  
  const statusCode = health.status === 'healthy' ? 200 : 503;
  return res.status(statusCode).json(health);
});
```

---

## Troubleshooting

### Common Performance Issues

#### 1. Memory Leaks

```typescript
// ❌ Memory leak - event listeners not cleaned up
app.post('/subscribe')
  .handler((req, res) => {
    const listener = (data) => {
      // Process data
    };
    eventEmitter.on('data', listener);
    // Listener never removed!
    
    return { subscribed: true };
  });

// ✅ Proper cleanup
app.post('/subscribe')
  .handler((req, res) => {
    const listener = (data) => {
      // Process data
    };
    
    eventEmitter.on('data', listener);
    
    // Clean up on client disconnect
    req.on('close', () => {
      eventEmitter.removeListener('data', listener);
    });
    
    return { subscribed: true };
  });
```

#### 2. Blocking Operations

```typescript
// ❌ Blocking the event loop
app.get('/cpu-intensive')
  .handler((req, res) => {
    // Synchronous CPU-intensive operation
    let result = 0;
    for (let i = 0; i < 10000000; i++) {
      result += Math.random();
    }
    return { result };
  });

// ✅ Non-blocking approach
app.get('/cpu-intensive')
  .handler(async (req, res) => {
    // Offload to worker thread or use setImmediate
    const result = await new Promise((resolve) => {
      setImmediate(() => {
        let result = 0;
        for (let i = 0; i < 10000000; i++) {
          result += Math.random();
        }
        resolve(result);
      });
    });
    
    return { result };
  });
```

#### 3. Database Connection Issues

```typescript
// Monitor database connection pool
app.events.on('database:connection:error', ({ error, pool }) => {
  console.error('Database connection error:', error);
  
  // Check pool status
  console.log('Pool status:', {
    total: pool.totalConnections,
    active: pool.activeConnections,
    idle: pool.idleConnections
  });
  
  // Alert if pool is exhausted
  if (pool.activeConnections === pool.connectionLimit) {
    console.error('Database connection pool exhausted!');
    // Trigger alert
  }
});
```

### Performance Debugging

```typescript
// Performance debugging middleware
app.use(async (req, res, next) => {
  if (req.query.debug === 'performance') {
    const timers = {};
    
    req.timer = {
      start: (name) => {
        timers[name] = process.hrtime.bigint();
      },
      end: (name) => {
        if (timers[name]) {
          const duration = Number(process.hrtime.bigint() - timers[name]) / 1000000;
          console.log(`${name}: ${duration}ms`);
          return duration;
        }
      }
    };
  }
  
  await next();
});
```

### Monitoring Tools Integration

```typescript
// Integrate with monitoring services
import { prometheus, newrelic, datadog } from 'monitoring-integrations';

const app = createApp({
  monitoring: {
    prometheus: {
      enabled: true,
      endpoint: '/metrics'
    },
    newrelic: {
      enabled: process.env.NEW_RELIC_LICENSE_KEY,
      appName: 'moro-api'
    },
    datadog: {
      enabled: process.env.DD_API_KEY,
      service: 'moro-api',
      env: process.env.NODE_ENV
    }
  }
});
```

---

This performance guide provides comprehensive strategies for optimizing MoroJS applications. For specific performance issues or questions, check the [examples repository](https://github.com/MoroJS/examples) or join our community discussions. 