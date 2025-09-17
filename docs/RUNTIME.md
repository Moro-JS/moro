# Runtime System Guide

Complete guide to MoroJS multi-runtime deployment across Node.js, Vercel Edge, AWS Lambda, and Cloudflare Workers.

## Table of Contents

- [Overview](#overview)
- [Runtime Types](#runtime-types)
- [Node.js Runtime](#nodejs-runtime)
- [Vercel Edge Runtime](#vercel-edge-runtime)
- [AWS Lambda Runtime](#aws-lambda-runtime)
- [Cloudflare Workers Runtime](#cloudflare-workers-runtime)
- [Cross-Runtime Compatibility](#cross-runtime-compatibility)
- [Deployment Strategies](#deployment-strategies)
- [Configuration](#configuration)
- [Best Practices](#best-practices)

---

## Overview

MoroJS provides a **write-once, deploy-everywhere** approach to backend development. The same application code can run across multiple runtime environments without modification, thanks to intelligent runtime adapters.

### Supported Runtimes

| Runtime | Use Case | Strengths | Limitations |
|---------|----------|-----------|-------------|
| **Node.js** | Traditional servers, microservices | Full features, WebSockets, file system | Manual scaling, server management |
| **Vercel Edge** | Global edge applications | Fast cold starts, global distribution | Limited compute time, no file system |
| **AWS Lambda** | Event-driven, serverless | Auto-scaling, pay-per-request | Cold starts, timeout limits |
| **Cloudflare Workers** | Edge computing, global APIs | Instant deployment, KV storage | V8 isolates, limited APIs |

### Key Benefits

- **Unified API** - Same code works everywhere
- **Runtime Optimization** - Adapters optimized for each environment
- **Feature Parity** - Core features available across all runtimes
- **Easy Migration** - Switch runtimes without code changes
- **Environment-Specific Features** - Access runtime-specific capabilities when needed

---

## Runtime Types

### Automatic Runtime Detection

MoroJS automatically detects the runtime environment:

```typescript
import { createApp } from '@morojs/moro';

// Automatically detects runtime based on environment
const app = createApp();

console.log('Runtime:', app.getRuntimeType());
// Outputs: 'node' | 'vercel-edge' | 'aws-lambda' | 'cloudflare-workers'
```

### Explicit Runtime Selection

```typescript
// Explicitly specify runtime
const app = createApp({
  runtime: {
    type: 'vercel-edge',
    options: {
      regions: ['iad1', 'sfo1']
    }
  }
});
```

### Runtime-Specific App Creation

```typescript
// Runtime-specific imports for type safety
import { createApp } from '@morojs/moro';           // Node.js
import { createAppEdge } from '@morojs/moro';       // Vercel Edge
import { createAppLambda } from '@morojs/moro';     // AWS Lambda
import { createAppWorker } from '@morojs/moro';     // Cloudflare Workers
```

---

## Node.js Runtime

The Node.js runtime provides the full feature set and is ideal for traditional server deployments.

### Basic Setup

```typescript
import { createApp } from '@morojs/moro';

const app = createApp({
  cors: true,
  compression: true,
  helmet: true
});

app.get('/health', () => ({ status: 'healthy' }));

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
```

### Features Available

- ✅ Full HTTP server
- ✅ WebSocket support
- ✅ File system access
- ✅ Process management
- ✅ All middleware
- ✅ Database connections
- ✅ Event system
- ✅ Module system

### Cluster Mode

```typescript
import cluster from 'cluster';
import os from 'os';
import { createApp } from '@morojs/moro';

if (cluster.isMaster) {
  const numCPUs = os.cpus().length;

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork();
  });
} else {
  const app = createApp({
    cluster: true,
    workerId: cluster.worker.id
  });

  app.listen(3000);
}
```

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
EXPOSE 3000

CMD ["node", "server.js"]
```

### PM2 Configuration

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'moro-app',
    script: './server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
```

---

## Vercel Edge Runtime

Vercel Edge Functions run at the edge, close to users globally.

### Basic Setup

```typescript
// api/hello.ts
import { createAppEdge } from '@morojs/moro';

const app = createAppEdge();

app.get('/api/hello', (req, res) => {
  return {
    message: 'Hello from the Edge!',
    region: process.env.VERCEL_REGION
  };
});

export default app.getHandler();
```

### Features Available

- ✅ HTTP requests/responses
- ✅ Geo-location headers
- ✅ Edge caching
- ✅ Streaming responses
- ✅ Environment variables
- ❌ File system access
- ❌ WebSockets
- ❌ Process APIs

### Edge-Optimized Configuration

```typescript
const app = createAppEdge({
  // Enable streaming for large responses
  streaming: true,

  // Cache configuration
  cache: {
    edge: true,
    maxAge: 3600,
    staleWhileRevalidate: 86400
  },

  // Deploy to specific regions
  regions: ['iad1', 'sfo1', 'cdg1']
});
```

### Geo-Location Features

```typescript
app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['x-vercel-ip-country'],
    region: req.headers['x-vercel-ip-country-region'],
    city: req.headers['x-vercel-ip-city'],
    timezone: req.headers['x-vercel-ip-timezone']
  };
});
```

### Edge Caching

```typescript
app.get('/api/content/:id')
  .cache({
    ttl: 3600,
    strategy: 'edge',
    vary: ['x-vercel-ip-country'] // Cache per country
  })
  .handler((req, res) => {
    return { content: getLocalizedContent(req.params.id, req.headers['x-vercel-ip-country']) };
  });
```

### Vercel Configuration

```json
// vercel.json
{
  "functions": {
    "api/*.ts": {
      "runtime": "@vercel/node@2"
    }
  },
  "regions": ["iad1", "sfo1", "cdg1"]
}
```

---

## AWS Lambda Runtime

AWS Lambda provides event-driven, auto-scaling serverless compute.

### Basic Setup

```typescript
// handler.ts
import { createAppLambda } from '@morojs/moro';

const app = createAppLambda({
  // Lambda-specific configuration
  memorySize: 1024,
  timeout: 30,
  runtime: 'nodejs18.x'
});

app.get('/api/users/:id', (req, res) => {
  return {
    userId: req.params.id,
    lambda: true,
    requestId: req.context.awsRequestId
  };
});

export const handler = app.getHandler();
```

### Features Available

- ✅ HTTP requests/responses (via API Gateway)
- ✅ Event context access
- ✅ Environment variables
- ✅ VPC integration
- ✅ Database connections (with connection pooling)
- ❌ WebSockets (use API Gateway WebSocket API separately)
- ❌ Long-running processes
- ❌ File system (except /tmp)

### Lambda Context Access

```typescript
app.get('/api/info', (req, res) => {
  return {
    requestId: req.context.awsRequestId,
    functionName: req.context.functionName,
    functionVersion: req.context.functionVersion,
    memoryLimit: req.context.memoryLimitInMB,
    remainingTime: req.context.getRemainingTimeInMillis()
  };
});
```

### Cold Start Optimization

```typescript
const app = createAppLambda({
  coldStartOptimization: true,
  connectionReuse: true,
  preloadModules: ['database', 'auth']
});

// Warm-up handler
app.get('/_warmup', (req, res) => {
  return { status: 'warm', timestamp: new Date() };
});
```

### Serverless Framework Configuration

```yaml
# serverless.yml
service: moro-api

provider:
  name: aws
  runtime: nodejs18.x
  memorySize: 1024
  timeout: 30
  environment:
    NODE_ENV: production

functions:
  api:
    handler: handler.handler
    events:
      - http:
          path: /{proxy+}
          method: ANY
          cors: true
```

### SAM Template

```yaml
# template.yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Resources:
  MoroApi:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: handler.handler
      Runtime: nodejs18.x
      MemorySize: 1024
      Timeout: 30
      Events:
        Api:
          Type: Api
          Properties:
            Path: /{proxy+}
            Method: ANY
```

---

## Cloudflare Workers Runtime

Cloudflare Workers run in V8 isolates at the edge with instant cold starts.

### Basic Setup

```typescript
// worker.ts
import { createAppWorker } from '@morojs/moro';

const app = createAppWorker({
  kv: {
    enabled: true,
    namespace: 'API_CACHE'
  }
});

app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['cf-ipcountry'],
    ray: req.headers['cf-ray'],
    colo: req.headers['cf-colo']
  };
});

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    return app.getHandler()(request, env, ctx);
  }
};
```

### Features Available

- ✅ HTTP requests/responses
- ✅ KV storage
- ✅ Durable Objects
- ✅ WebSockets
- ✅ Geo-location data
- ✅ Edge computing
- ❌ File system
- ❌ Node.js APIs
- ❌ Traditional databases (use D1 or external APIs)

### KV Storage Integration

```typescript
app.get('/api/cache/:key')
  .handler(async (req, res, env) => {
    // Read from KV
    const value = await env.API_CACHE.get(req.params.key);

    if (value) {
      return { value: JSON.parse(value), cached: true };
    }

    // Generate new value
    const newValue = await generateValue(req.params.key);

    // Store in KV with TTL
    await env.API_CACHE.put(
      req.params.key,
      JSON.stringify(newValue),
      { expirationTtl: 3600 }
    );

    return { value: newValue, cached: false };
  });
```

### Durable Objects Integration

```typescript
// Define Durable Object
export class Counter {
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  async fetch(request: Request) {
    const count = await this.state.storage.get('count') || 0;
    await this.state.storage.put('count', count + 1);
    return new Response(JSON.stringify({ count: count + 1 }));
  }
}

// Use in Worker
app.post('/api/increment/:id')
  .handler(async (req, res, env) => {
    const id = env.COUNTER.idFromName(req.params.id);
    const stub = env.COUNTER.get(id);
    const response = await stub.fetch(req);
    const data = await response.json();

    return { success: true, data };
  });
```

### Wrangler Configuration

```toml
# wrangler.toml
name = "moro-worker"
main = "worker.ts"
compatibility_date = "2023-01-01"

[env.production]
vars = { NODE_ENV = "production" }

[[env.production.kv_namespaces]]
binding = "API_CACHE"
id = "your-kv-namespace-id"

[[env.production.durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"
```

---

## Cross-Runtime Compatibility

### Shared Application Code

Write your application logic once and deploy to any runtime:

```typescript
// shared/app.ts
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email()
});

export function setupRoutes(app: any) {
  app.get('/api/health', () => ({ status: 'healthy' }));

  app.post('/api/users')
    .body(UserSchema)
    .rateLimit({ requests: 100, window: 60000 })
    .handler(async (req, res) => {
      // This handler works on all runtimes
      const user = await createUser(req.body);
      return { success: true, data: user };
    });

  app.get('/api/users/:id')
    .params(z.object({ id: z.string().uuid() }))
    .cache({ ttl: 300 })
    .handler(async (req, res) => {
      const user = await getUser(req.params.id);
      return { success: true, data: user };
    });
}

async function createUser(userData: any) {
  // Implementation that works across runtimes
  return { id: generateId(), ...userData, createdAt: new Date() };
}
```

### Runtime-Specific Deployments

```typescript
// node.ts
import { createApp } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = createApp();
setupRoutes(app);
app.listen(3000);

// vercel-edge.ts
import { createAppEdge } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = createAppEdge();
setupRoutes(app);
export default app.getHandler();

// lambda.ts
import { createAppLambda } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = createAppLambda();
setupRoutes(app);
export const handler = app.getHandler();

// worker.ts
import { createAppWorker } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = createAppWorker();
setupRoutes(app);
export default { fetch: app.getHandler() };
```

### Runtime-Specific Features

```typescript
export function setupRoutes(app: any) {
  // Common routes work everywhere
  app.get('/api/info', (req, res) => {
    const runtime = app.getRuntimeType();

    return {
      runtime,
      timestamp: new Date(),
      ...(runtime === 'cloudflare-workers' && {
        country: req.headers['cf-ipcountry'],
        ray: req.headers['cf-ray']
      }),
      ...(runtime === 'aws-lambda' && {
        requestId: req.context?.awsRequestId,
        functionName: req.context?.functionName
      }),
      ...(runtime === 'vercel-edge' && {
        region: process.env.VERCEL_REGION
      })
    };
  });

  // Runtime-specific routes
  if (app.getRuntimeType() === 'node') {
    app.websocket('/ws', {
      connection: (socket) => console.log('Connected'),
      message: (socket, data) => socket.broadcast.emit('message', data)
    });
  }
}
```

---

## Deployment Strategies

### Multi-Runtime Deployment

Deploy the same application to multiple runtimes for different use cases:

```typescript
// package.json scripts
{
  "scripts": {
    "dev": "node src/node.js",
    "build": "tsc",
    "deploy:node": "pm2 start ecosystem.config.js",
    "deploy:vercel": "vercel deploy",
    "deploy:lambda": "serverless deploy",
    "deploy:worker": "wrangler publish",
    "deploy:all": "npm run deploy:vercel && npm run deploy:lambda && npm run deploy:worker"
  }
}
```

### Environment-Based Selection

```typescript
// deploy.ts
const runtime = process.env.DEPLOY_TARGET || 'node';

switch (runtime) {
  case 'vercel-edge':
    await deployToVercel();
    break;
  case 'aws-lambda':
    await deployToLambda();
    break;
  case 'cloudflare-workers':
    await deployToWorkers();
    break;
  default:
    await deployToNode();
}
```

### CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy Multi-Runtime

on:
  push:
    branches: [main]

jobs:
  deploy-vercel:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run build
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}

  deploy-lambda:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run build
      - run: npx serverless deploy
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

  deploy-workers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run build
      - run: npx wrangler publish
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## Configuration

### Environment Variables

```typescript
// config.ts
export const config = {
  database: {
    url: process.env.DATABASE_URL,
    pool: {
      min: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN) : 2,
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX) : 10
    }
  },
  cache: {
    redis: process.env.REDIS_URL,
    ttl: process.env.CACHE_TTL ? parseInt(process.env.CACHE_TTL) : 300
  },
  auth: {
    secret: process.env.JWT_SECRET || 'dev-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  }
};
```

### Runtime-Specific Configuration

```typescript
// config/runtime.ts
export function getRuntimeConfig(runtime: string) {
  const baseConfig = {
    cors: true,
    compression: true,
    helmet: true
  };

  switch (runtime) {
    case 'node':
      return {
        ...baseConfig,
        cluster: process.env.NODE_ENV === 'production',
        websockets: true
      };

    case 'vercel-edge':
      return {
        ...baseConfig,
        streaming: true,
        regions: ['iad1', 'sfo1'],
        cache: { edge: true }
      };

    case 'aws-lambda':
      return {
        ...baseConfig,
        coldStartOptimization: true,
        memorySize: 1024,
        timeout: 30
      };

    case 'cloudflare-workers':
      return {
        ...baseConfig,
        kv: { enabled: true },
        durableObjects: true
      };

    default:
      return baseConfig;
  }
}
```

---

## Best Practices

### 1. Runtime-Agnostic Code

```typescript
// ✅ Good - Works everywhere
app.get('/api/users', async (req, res) => {
  const users = await fetchUsers();
  return { users };
});

// ❌ Bad - Node.js specific
app.get('/api/files', async (req, res) => {
  const fs = require('fs'); // Not available in edge/workers
  const files = fs.readdirSync('./uploads');
  return { files };
});
```

### 2. Handle Runtime Differences

```typescript
// ✅ Good - Graceful degradation
app.get('/api/features', (req, res) => {
  const runtime = app.getRuntimeType();

  return {
    websockets: runtime === 'node',
    fileSystem: runtime === 'node',
    kv: runtime === 'cloudflare-workers',
    edge: ['vercel-edge', 'cloudflare-workers'].includes(runtime),
    serverless: ['aws-lambda', 'vercel-edge', 'cloudflare-workers'].includes(runtime)
  };
});
```

### 3. Optimize for Target Runtime

```typescript
// Node.js optimization
if (app.getRuntimeType() === 'node') {
  app.use(middleware.compression({ level: 9 }));
  app.use(middleware.cluster());
}

// Edge optimization
if (['vercel-edge', 'cloudflare-workers'].includes(app.getRuntimeType())) {
  app.use(middleware.cache({ strategy: 'edge' }));
}

// Lambda optimization
if (app.getRuntimeType() === 'aws-lambda') {
  app.use(middleware.connectionReuse());
  app.use(middleware.coldStartOptimization());
}
```

### 4. Testing Across Runtimes

```typescript
// test/runtime.test.ts
import { createApp, createAppEdge, createAppLambda, createAppWorker } from '@morojs/moro';
import { setupRoutes } from '../src/shared/app.js';

const runtimes = [
  { name: 'node', factory: createApp },
  { name: 'vercel-edge', factory: createAppEdge },
  { name: 'aws-lambda', factory: createAppLambda },
  { name: 'cloudflare-workers', factory: createAppWorker }
];

describe.each(runtimes)('$name runtime', ({ name, factory }) => {
  let app;

  beforeEach(() => {
    app = factory();
    setupRoutes(app);
  });

  test('health check works', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
  });

  test('user creation works', async () => {
    const userData = { name: 'John Doe', email: 'john@example.com' };
    const response = await request(app).post('/api/users').send(userData);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
```

### 5. Monitoring Across Runtimes

```typescript
// monitoring.ts
export function setupMonitoring(app: any) {
  const runtime = app.getRuntimeType();

  // Universal monitoring
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    next();
  });

  // Runtime-specific monitoring
  switch (runtime) {
    case 'node':
      app.use(middleware.prometheus({ endpoint: '/metrics' }));
      break;

    case 'aws-lambda':
      app.use(middleware.cloudWatch({ namespace: 'MoroAPI' }));
      break;

    case 'cloudflare-workers':
      app.use(middleware.analytics({ datadog: true }));
      break;
  }
}
```

---

This runtime guide provides comprehensive information for deploying MoroJS applications across all supported environments. For specific deployment examples, check the [examples repository](https://github.com/Moro-JS/examples/tree/main/runtime-examples).
