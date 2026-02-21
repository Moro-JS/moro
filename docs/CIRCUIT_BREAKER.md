# Circuit Breaker Guide

Complete guide to MoroJS's built-in circuit breaker pattern for fault tolerance and resilience.

## Overview

The Circuit Breaker pattern prevents cascading failures in distributed systems by automatically detecting failures and preventing operations that are likely to fail. MoroJS includes built-in circuit breaker support for routes, websockets, and background jobs.

## Table of Contents

- [How Circuit Breakers Work](#how-circuit-breakers-work)
- [Built-in Circuit Breakers](#built-in-circuit-breakers)
- [Manual Circuit Breaker Usage](#manual-circuit-breaker-usage)
- [Configuration](#configuration)
- [Monitoring and Events](#monitoring-and-events)
- [Best Practices](#best-practices)

## How Circuit Breakers Work

A circuit breaker has three states:

### States

1. **CLOSED** (Normal Operation)
   - Requests pass through normally
   - Failures are tracked
   - Moves to OPEN when failure threshold is reached

2. **OPEN** (Failing)
   - Requests fail immediately without attempting
   - Prevents cascade failures
   - After reset timeout, moves to HALF_OPEN

3. **HALF_OPEN** (Testing Recovery)
   - Allows a limited number of requests
   - If successful, returns to CLOSED
   - If failed, returns to OPEN

### State Diagram

```
CLOSED ──[failures >= threshold]──> OPEN
                                      │
                          [reset timeout expires]
                                      │
                                      ▼
                                 HALF_OPEN
                               ╱          ╲
                  [success] ╱              ╲ [failure]
                           ▼                  ▼
                        CLOSED             OPEN
```

## Built-in Circuit Breakers

MoroJS automatically provides circuit breakers for:

### 1. Background Jobs

Jobs automatically use circuit breakers to prevent repeated failures:

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

// Circuit breaker is automatically configured
app.scheduleJob({
  name: 'external-api-sync',
  schedule: '*/5 * * * *', // Every 5 minutes
  handler: async () => {
    // If this fails repeatedly, circuit breaker opens
    const response = await fetch('https://api.example.com/data');
    return await response.json();
  },
  options: {
    enableCircuitBreaker: true, // Enabled by default
    maxRetries: 3,
  },
});
```

### 2. WebSocket Handlers

WebSocket event handlers have automatic circuit breaker protection:

```typescript
const chatModule = defineModule({
  name: 'chat',
  version: '1.0.0',

  sockets: [
    {
      event: 'message',
      handler: async (socket, data) => {
        // Circuit breaker protects this handler
        await processMessage(data);
      },
    },
  ],
});
```

### 3. Routes (Manual Integration)

For HTTP routes, integrate circuit breakers manually:

```typescript
import { CircuitBreaker } from '@morojs/moro';

const externalApiBreaker = new CircuitBreaker({
  failureThreshold: 5, // Open after 5 failures
  resetTimeout: 30000, // Try again after 30 seconds
  monitoringPeriod: 10000, // Track failures over 10 seconds
});

app.get('/external-data', async (req, res) => {
  try {
    const data = await externalApiBreaker.execute(async () => {
      const response = await fetch('https://api.example.com/data');
      return await response.json();
    });

    res.json(data);
  } catch (error: any) {
    if (error.message === 'Circuit breaker is OPEN') {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        retryAfter: 30,
      });
    }
    throw error;
  }
});
```

## Manual Circuit Breaker Usage

### Basic Usage

```typescript
import { CircuitBreaker } from '@morojs/moro';

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeout: 5000,
});

// Execute protected function
try {
  const result = await breaker.execute(async () => {
    return await riskyOperation();
  });

  console.log('Success:', result);
} catch (error) {
  console.error('Failed:', error);
}
```

### With Fallback

```typescript
async function fetchDataWithFallback() {
  try {
    return await breaker.execute(async () => {
      return await fetchFromPrimaryAPI();
    });
  } catch (error: any) {
    if (error.message === 'Circuit breaker is OPEN') {
      // Use cached data or secondary source
      return await fetchFromCache();
    }
    throw error;
  }
}
```

### Multiple Circuit Breakers

```typescript
const breakers = {
  database: new CircuitBreaker({
    failureThreshold: 5,
    resetTimeout: 30000,
  }),

  externalApi: new CircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 60000,
  }),

  cache: new CircuitBreaker({
    failureThreshold: 10,
    resetTimeout: 5000,
  }),
};

// Use different breakers for different operations
app.get('/users/:id', async (req, res) => {
  try {
    const user = await breakers.database.execute(async () => {
      return await db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    });

    res.json(user);
  } catch (error) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.get('/external/data', async (req, res) => {
  try {
    const data = await breakers.externalApi.execute(async () => {
      return await fetch('https://api.example.com/data');
    });

    res.json(data);
  } catch (error) {
    res.status(503).json({ error: 'External API unavailable' });
  }
});
```

## Configuration

### Options

```typescript
interface CircuitBreakerOptions {
  failureThreshold: number; // Failures before opening
  resetTimeout: number; // Ms before trying again
  monitoringPeriod?: number; // Ms to track failures (optional)
}
```

### Configuration Examples

```typescript
// Fast recovery for transient errors
const fastBreaker = new CircuitBreaker({
  failureThreshold: 2,
  resetTimeout: 5000,
});

// Slow recovery for persistent failures
const slowBreaker = new CircuitBreaker({
  failureThreshold: 10,
  resetTimeout: 300000, // 5 minutes
});

// Sensitive breaker for critical operations
const sensitiveBreaker = new CircuitBreaker({
  failureThreshold: 1, // Open immediately on failure
  resetTimeout: 60000,
});

// Tolerant breaker for flaky services
const tolerantBreaker = new CircuitBreaker({
  failureThreshold: 20,
  resetTimeout: 10000,
});
```

### Dynamic Configuration

```typescript
class AdaptiveCircuitBreaker {
  private breaker: CircuitBreaker;
  private successCount = 0;
  private failureRate = 0;

  constructor() {
    this.breaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
    });
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await this.breaker.execute(fn);
      this.successCount++;
      this.adjustThreshold();
      return result;
    } catch (error) {
      this.adjustThreshold();
      throw error;
    }
  }

  private adjustThreshold() {
    // Adjust based on success rate
    const total = this.successCount + this.breaker.getFailures();
    if (total > 100) {
      this.failureRate = this.breaker.getFailures() / total;

      // Adjust threshold based on failure rate
      if (this.failureRate > 0.5) {
        // High failure rate - be more sensitive
        this.breaker = new CircuitBreaker({
          failureThreshold: 3,
          resetTimeout: 60000,
        });
      }
    }
  }
}
```

## Monitoring and Events

### State Change Events

```typescript
const breaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeout: 5000,
});

breaker.on('open', () => {
  console.log('⚠️  Circuit breaker opened - service is failing');
  // Alert monitoring system
  alertMonitoring('circuit_breaker_open');
});

breaker.on('closed', () => {
  console.log('✅ Circuit breaker closed - service recovered');
  alertMonitoring('circuit_breaker_closed');
});

breaker.on('halfOpen', () => {
  console.log('🔄 Circuit breaker half-open - testing recovery');
  alertMonitoring('circuit_breaker_half_open');
});

breaker.on('reset', () => {
  console.log('🔄 Circuit breaker manually reset');
});
```

### Health Check Endpoint

```typescript
const breakers = new Map<string, CircuitBreaker>();

app.get('/health/circuit-breakers', (req, res) => {
  const status = Array.from(breakers.entries()).map(([name, breaker]) => ({
    name,
    state: breaker.getState(),
    failures: breaker.getFailures(),
    isOpen: breaker.isOpen(),
  }));

  const anyOpen = status.some(b => b.isOpen);

  res.status(anyOpen ? 503 : 200).json({
    status: anyOpen ? 'degraded' : 'healthy',
    breakers: status,
  });
});
```

### Metrics Collection

```typescript
class CircuitBreakerMetrics {
  private metrics = new Map<
    string,
    {
      opens: number;
      closes: number;
      totalFailures: number;
      lastOpen?: Date;
      lastClose?: Date;
    }
  >();

  track(name: string, breaker: CircuitBreaker) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, {
        opens: 0,
        closes: 0,
        totalFailures: 0,
      });
    }

    const metrics = this.metrics.get(name)!;

    breaker.on('open', () => {
      metrics.opens++;
      metrics.lastOpen = new Date();
    });

    breaker.on('closed', () => {
      metrics.closes++;
      metrics.lastClose = new Date();
    });
  }

  getMetrics() {
    return Array.from(this.metrics.entries()).map(([name, data]) => ({
      name,
      ...data,
    }));
  }
}

const metrics = new CircuitBreakerMetrics();
metrics.track('database', dbBreaker);
metrics.track('api', apiBreaker);

app.get('/metrics/circuit-breakers', (req, res) => {
  res.json(metrics.getMetrics());
});
```

## Best Practices

### 1. Set Appropriate Thresholds

```typescript
// Good: Based on service characteristics
const databaseBreaker = new CircuitBreaker({
  failureThreshold: 5, // Database should be stable
  resetTimeout: 30000, // Give it time to recover
});

const flakySaaSBreaker = new CircuitBreaker({
  failureThreshold: 10, // More tolerant of occasional failures
  resetTimeout: 60000, // Longer recovery time
});

// Bad: Too sensitive
const overSensitive = new CircuitBreaker({
  failureThreshold: 1, // Opens on first failure
  resetTimeout: 1000, // Tries again too quickly
});
```

### 2. Provide Fallbacks

```typescript
// Good: Always have a fallback
async function getUserData(userId: string) {
  try {
    return await breaker.execute(() => fetchFromDatabase(userId));
  } catch (error: any) {
    if (error.message === 'Circuit breaker is OPEN') {
      // Fallback to cache
      return await fetchFromCache(userId);
    }
    throw error;
  }
}

// Bad: No fallback
async function getUserDataBad(userId: string) {
  return await breaker.execute(() => fetchFromDatabase(userId));
  // Fails completely when breaker is open
}
```

### 3. Monitor Circuit Breaker State

```typescript
// Good: Alert on state changes
breaker.on('open', () => {
  logger.error('Service degraded - circuit breaker open');
  sendAlert('CircuitBreakerOpen', { service: 'external-api' });
});

breaker.on('closed', () => {
  logger.info('Service recovered - circuit breaker closed');
  sendAlert('CircuitBreakerClosed', { service: 'external-api' });
});
```

### 4. Use Different Breakers for Different Services

```typescript
// Good: Separate breakers for independent services
const breakers = {
  auth: new CircuitBreaker({ failureThreshold: 3, resetTimeout: 30000 }),
  payment: new CircuitBreaker({ failureThreshold: 2, resetTimeout: 60000 }),
  email: new CircuitBreaker({ failureThreshold: 10, resetTimeout: 30000 }),
};

// Bad: Single breaker for everything
const globalBreaker = new CircuitBreaker({
  /* ... */
});
```

### 5. Manual Reset for Critical Issues

```typescript
// Provide admin endpoint to manually reset
app.post('/admin/circuit-breaker/:name/reset', (req, res) => {
  const breaker = breakers.get(req.params.name);

  if (!breaker) {
    return res.status(404).json({ error: 'Breaker not found' });
  }

  breaker.reset();
  logger.info(`Circuit breaker ${req.params.name} manually reset`);

  res.json({ reset: true });
});
```

## Complete Example

```typescript
import { createApp, CircuitBreaker } from '@morojs/moro';

const app = await createApp();

// Create circuit breakers for different services
const breakers = {
  database: new CircuitBreaker({
    failureThreshold: 5,
    resetTimeout: 30000,
  }),

  cache: new CircuitBreaker({
    failureThreshold: 10,
    resetTimeout: 10000,
  }),

  externalApi: new CircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 60000,
  }),
};

// Setup monitoring
Object.entries(breakers).forEach(([name, breaker]) => {
  breaker.on('open', () => {
    console.error(`❌ ${name} circuit breaker OPEN`);
  });

  breaker.on('closed', () => {
    console.log(`✅ ${name} circuit breaker CLOSED`);
  });
});

// Protected database operation
async function getUser(id: string) {
  try {
    return await breakers.database.execute(async () => {
      return await db.query('SELECT * FROM users WHERE id = ?', [id]);
    });
  } catch (error: any) {
    if (error.message === 'Circuit breaker is OPEN') {
      // Try cache fallback
      return await breakers.cache.execute(async () => {
        return await cache.get(`user:${id}`);
      });
    }
    throw error;
  }
}

// Protected external API call
async function getExternalData() {
  try {
    return await breakers.externalApi.execute(async () => {
      const response = await fetch('https://api.example.com/data');
      return await response.json();
    });
  } catch (error: any) {
    if (error.message === 'Circuit breaker is OPEN') {
      return { data: [], cached: true };
    }
    throw error;
  }
}

// Routes
app.get('/users/:id', async (req, res) => {
  try {
    const user = await getUser(req.params.id);
    res.json({ user });
  } catch (error) {
    res.status(503).json({ error: 'Service unavailable' });
  }
});

app.get('/external/data', async (req, res) => {
  try {
    const data = await getExternalData();
    res.json(data);
  } catch (error) {
    res.status(503).json({ error: 'External service unavailable' });
  }
});

// Health check
app.get('/health', (req, res) => {
  const status = Object.entries(breakers).map(([name, breaker]) => ({
    name,
    state: breaker.getState(),
    failures: breaker.getFailures(),
    open: breaker.isOpen(),
  }));

  const anyOpen = status.some(b => b.open);

  res.status(anyOpen ? 503 : 200).json({
    status: anyOpen ? 'degraded' : 'healthy',
    breakers: status,
    timestamp: new Date().toISOString(),
  });
});

// Admin reset endpoint
app.post('/admin/breaker/:name/reset', (req, res) => {
  const breaker = breakers[req.params.name as keyof typeof breakers];

  if (!breaker) {
    return res.status(404).json({ error: 'Breaker not found' });
  }

  breaker.reset();
  res.json({ reset: true, breaker: req.params.name });
});

await app.listen(3000);
console.log('Server with circuit breakers running on port 3000');
```

## API Reference

### CircuitBreaker Class

```typescript
class CircuitBreaker extends EventEmitter {
  constructor(options: CircuitBreakerOptions);

  // Execute protected function
  execute<T>(fn: () => Promise<T>): Promise<T>;

  // Get current state
  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';

  // Check if open
  isOpen(): boolean;

  // Get failure count
  getFailures(): number;

  // Manually reset
  reset(): void;

  // Events
  on(event: 'open', listener: () => void): this;
  on(event: 'closed', listener: () => void): this;
  on(event: 'halfOpen', listener: () => void): this;
  on(event: 'reset', listener: () => void): this;
}
```

### Options

```typescript
interface CircuitBreakerOptions {
  failureThreshold: number; // Number of failures before opening
  resetTimeout: number; // Milliseconds before trying HALF_OPEN
  monitoringPeriod?: number; // Milliseconds for failure tracking window
}
```

## See Also

- [Jobs Guide](./JOBS_GUIDE.md) - Background jobs with circuit breakers
- [Performance Guide](./PERFORMANCE.md) - Performance optimization
- [API Reference](./API.md) - Complete API documentation
