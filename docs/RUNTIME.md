# Runtime System Guide

Complete guide to MoroJS multi-runtime deployment across Node.js, Vercel Edge, AWS Lambda, and Cloudflare Workers.

## Table of Contents

- [Overview](#overview)
- [Runtime Types](#runtime-types)
- [Node.js Runtime](#nodejs-runtime)
- [Vercel Edge Runtime](#vercel-edge-runtime)
- [AWS Lambda Runtime](#aws-lambda-runtime)
- [Cloudflare Workers Runtime](#cloudflare-workers-runtime)
- [Requests and Responses on Serverless Runtimes](#requests-and-responses-on-serverless-runtimes)
- [Cross-Runtime Compatibility](#cross-runtime-compatibility)
- [Deployment Strategies](#deployment-strategies)
- [Configuration](#configuration)
- [Best Practices](#best-practices)

---

## Overview

MoroJS provides a **write-once, deploy-everywhere** approach to backend development. The same application code can run across multiple runtime environments without modification, thanks to intelligent runtime adapters.

### Supported Runtimes

| Runtime                | Use Case                           | Strengths                              | Limitations                          |
| ---------------------- | ---------------------------------- | -------------------------------------- | ------------------------------------ |
| **Node.js**            | Traditional servers, microservices | Full features, WebSockets, file system | Manual scaling, server management    |
| **Vercel Edge**        | Global edge applications           | Fast cold starts, global distribution  | Limited compute time, no file system |
| **AWS Lambda**         | Event-driven, serverless           | Auto-scaling, pay-per-request          | Cold starts, timeout limits          |
| **Cloudflare Workers** | Edge computing, global APIs        | Instant deployment, KV storage         | V8 isolates, limited APIs            |

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
const app = await createApp();

console.log('Runtime:', app.getRuntimeType());
// Outputs: 'node' | 'vercel-edge' | 'aws-lambda' | 'cloudflare-workers'
```

### Explicit Runtime Selection

```typescript
// Explicitly specify runtime
const app = await createApp({
  runtime: {
    type: 'vercel-edge',
    options: {
      regions: ['iad1', 'sfo1'],
    },
  },
});
```

### Runtime-Specific App Creation

```typescript
// Runtime-specific imports for type safety
import { createApp } from '@morojs/moro'; // Node.js
import { createAppEdge } from '@morojs/moro'; // Vercel Edge
import { createAppLambda } from '@morojs/moro'; // AWS Lambda
import { createAppWorker } from '@morojs/moro'; // Cloudflare Workers
```

---

## Node.js Runtime

The Node.js runtime provides the full feature set and is ideal for traditional server deployments.

### Basic Setup

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  cors: true,
  compression: true,
  helmet: true,
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
import { createApp } from '@morojs/moro';

// Clustering is built in: the primary starts the workers (threads or processes) and starts
// one that dies again, after a delay that grows from 200 ms to 5 s
const app = await createApp({
  performance: {
    clustering: {
      enabled: true,
      workers: 'auto', // or a number
    },
  },
});

app.listen(3000);
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
  apps: [
    {
      name: 'moro-app',
      script: './server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
```

---

## Vercel Edge Runtime

Vercel Edge Functions run at the edge, close to users globally.

### Basic Setup

```typescript
// api/hello.ts
import { createAppEdge } from '@morojs/moro';

const app = await createAppEdge();

app.get('/api/hello', (req, res) => {
  return {
    message: 'Hello from the Edge!',
    region: process.env.VERCEL_REGION,
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
const app = await createAppEdge();

export default app.getHandler();

// Regions are chosen in the platform's own route config, not in the app
export const config = { runtime: 'edge', regions: ['iad1', 'sfo1', 'cdg1'] };
```

### Geo-Location Features

```typescript
app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['x-vercel-ip-country'],
    region: req.headers['x-vercel-ip-country-region'],
    city: req.headers['x-vercel-ip-city'],
    timezone: req.headers['x-vercel-ip-timezone'],
  };
});
```

### Edge Caching

```typescript
// Route-level cache config is { ttl, key?, tags? }.
// The response differs per country, so the country is part of the key:
// without it every country would be served the first cached response.
app
  .get('/api/content/:id')
  .cache({
    ttl: 3600,
    tags: ['content'],
    key: req => `content:${req.params.id}:${req.headers['x-vercel-ip-country']}`,
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

// Memory, timeout and Node.js version are set on the Lambda function itself
// (see the deployment config below), not in the app
const app = await createAppLambda();

app.get('/api/users/:id', (req, res) => {
  return {
    userId: req.params.id,
    lambda: true,
    requestId: req.requestId, // the invocation's awsRequestId
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

### Event Sources

The same handler serves every HTTP event source. The event's shape is recognised per invocation and the response is returned in the shape that source reads:

| Event source                                                    | Recognised by        | Response                                                                                                     |
| --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| API Gateway REST API, HTTP API on payload format 1.0            | `httpMethod`, `path` | `headers`; when more than one cookie is set, `multiValueHeaders['Set-Cookie']`                               |
| API Gateway HTTP API on payload format 2.0, Lambda Function URL | `version: '2.0'`     | `headers`; cookies in `cookies`                                                                              |
| Application Load Balancer                                       | `requestContext.elb` | `headers`; with multi-value headers enabled on the target group, every header in `multiValueHeaders` as well |

What a handler sees is the same for all of them:

- `req.method`, `req.path`, `req.query` and `req.params` come from the event. A parameter that is repeated in the query string has its last value.
- `req.query` holds decoded names and values on every event source. A REST API (and payload format 1.0) delivers them decoded, and the raw query string of an HTTP API on payload format 2.0 or a Function URL is parsed by the parser the Node.js server uses (so is the URL a Vercel Edge or Cloudflare Workers function receives). A load balancer delivers them as the client sent them, still percent-encoded, and they are decoded by the parser the Node.js server uses, so `req.query` is what that server gives for the same request line: `%20` and `+` are a space, an escape that cannot be decoded stays as it was sent, and a parameter with no value is `''`. Do not decode `req.query` values again: a value that contains a literal `%` would be decoded twice.
- `req.url` is the path with its query string on every event source, as on the Node.js server: `/items?tag=a&tag=b`, or the bare path when there is no query. HTTP APIs with payload format 2.0 and Function URLs deliver the query string as it was sent. A REST API (and payload format 1.0) and a load balancer deliver the path and the parameters apart, and `req.url` is put together from them, every value of a repeated parameter included (from `multiValueQueryStringParameters` when the event has it); parameters of one name end up next to each other. API Gateway hands names and values over decoded, so they are percent-encoded again in `req.url`. A load balancer hands them over as the client sent them, still percent-encoded: they are written into `req.url` unchanged. Use `req.path` where the query string is not wanted.
- `req.headers` can be read with lower-case names on every event source. HTTP APIs with payload format 2.0, Function URLs and load balancers send lower-case names. A REST API (and payload format 1.0) hands header names over in the client's casing; those names stay, and each is readable in lower case too, so `req.headers.authorization` is set whether the client sent `Authorization` or `authorization`. The lower-case names are added the first time a handler reads `req.headers`.
- `req.cookies` is parsed from the `Cookie` header (REST API, load balancer) or from the event's `cookies` list (payload format 2.0). On REST API events the header is found under the names `cookie`, `Cookie` and `COOKIE`. Values are URL-decoded, as on Node.js.
- `req.ip` is the source address API Gateway or the Function URL reports. A load balancer with multi-value headers enabled reports it in `X-Forwarded-For`, and `req.ip` is the address the load balancer itself appended (the last one). For a load balancer without multi-value headers `req.ip` is `'unknown'`: read `X-Forwarded-For` yourself.
- The path is routed as the event gives it. On payload format 2.0 a named stage is part of the path (`/prod/users`); the `$default` stage and Function URLs have no prefix.

A load balancer without multi-value headers can carry one `Set-Cookie` per response (the last cookie set is the one sent). Enable multi-value headers on the target group to set several.

### Binary Responses

A `Buffer`, a typed array or an `ArrayBuffer` passed to `res.send()` / `res.end()` is returned base64-encoded with `isBase64Encoded: true`, under the `Content-Type` the handler set (`application/octet-stream` when it set none):

```typescript
import { readFileSync } from 'node:fs';

// Read once, at cold start
const logo = readFileSync(new URL('./logo.png', import.meta.url));

app.get('/logo.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(logo);
});
```

HTTP APIs, Function URLs and load balancers decode the body by themselves. A REST API decodes it only for the media types listed in the API's `binaryMediaTypes` setting (`*/*` covers all of them).

### Lambda Context Access

```typescript
app.get('/api/info', (req, res) => {
  return {
    requestId: req.context.awsRequestId,
    functionName: req.context.functionName,
    functionVersion: req.context.functionVersion,
    memoryLimit: req.context.memoryLimitInMB,
    remainingTime: req.context.getRemainingTimeInMillis(),
  };
});
```

### Cold Start Optimization

MoroJS keeps cold starts small by default — optional subsystems (worker
threads, job scheduler, adapters) are lazy-loaded on first use, so an
unconfigured app pays nothing for them at startup.

```typescript
const app = await createAppLambda({
  // Reuse connections between invocations
  server: {
    timeouts: { keepAlive: 5000 },
  },
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
  runtime: nodejs22.x
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
      Runtime: nodejs22.x
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

// KV namespaces, Durable Objects and other bindings are declared in
// wrangler.toml (below) and reach handlers on req.env
const app = await createAppWorker();

app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['cf-ipcountry'],
    ray: req.headers['cf-ray'],
    colo: req.headers['cf-colo'],
  };
});

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    return app.getHandler()(request, env, ctx);
  },
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
app.get('/api/cache/:key').handler(async (req, res) => {
  const env = req.env; // the Worker's bindings

  // Read from KV
  const value = await env.API_CACHE.get(req.params.key);

  if (value) {
    return { value: JSON.parse(value), cached: true };
  }

  // Generate new value
  const newValue = await generateValue(req.params.key);

  // Store in KV with TTL
  await env.API_CACHE.put(req.params.key, JSON.stringify(newValue), { expirationTtl: 3600 });

  return { value: newValue, cached: false };
});
```

### Durable Objects Integration

```typescript
// Define Durable Object
export class Counter {
  constructor(
    private state: DurableObjectState,
    env: any
  ) {}

  async fetch(request: Request) {
    const count = (await this.state.storage.get('count')) || 0;
    await this.state.storage.put('count', count + 1);
    return new Response(JSON.stringify({ count: count + 1 }));
  }
}

// Use in Worker
app.post('/api/increment/:id').handler(async (req, res) => {
  const env = req.env; // the Worker's bindings
  const id = env.COUNTER.idFromName(req.params.id);
  const stub = env.COUNTER.get(id);
  const response = await stub.fetch(req.url, { method: 'POST' });
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

## Requests and Responses on Serverless Runtimes

On AWS Lambda, Vercel Edge and Cloudflare Workers a handler receives the same `req` and `res` as on Node.js, backed by the platform's event or `Request`. The differences that matter:

### Global Middleware and Hooks

The function `app.getHandler()` returns runs a request through the same steps as the Node.js servers, in the same order:

1. `request` hooks (`app.hooks.before('request', ...)` and hook-based middleware such as `middleware.session()`).
2. The global middleware chain: the config-driven middleware (helmet, CORS, compression, request logging) and then every function registered with `app.use(fn)` or `app.use('/prefix', fn)`, in registration order. Middleware registered after `getHandler()` was called is part of the chain too.
3. The documentation routes, then the router: the route's own phases (`.before()`, `.rateLimit()`, `.auth()`, validation, ...) and its handler.
4. `response` hooks, awaited before the function returns (the platform may freeze the function right after).

A middleware that answers the request ends it there, so a guard registered with `app.use()` protects every route:

```typescript
const app = await createAppLambda();

app.use((req, res, next) => {
  if (req.headers.authorization !== `Bearer ${process.env.API_TOKEN}`) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return; // no next(): the request ends here
  }
  next();
});

app.get('/reports', () => ({ reports: [] })); // only reached with the token

export const handler = app.getHandler();
```

Errors follow the standard contract: `next(err)`, a throw or a rejected promise skips to the next error middleware (a function declared with four parameters, `(err, req, res, next)`). An error no error middleware handled goes to the handler set with `app.setErrorHandler()`, and otherwise the request is answered `500` with `{ "success": false, "error": "Internal server error", "requestId": "..." }`. `error` hooks observe it first.

The response is buffered: it is handed to the platform as a whole when the request has been handled. What follows from that:

- `res.on('finish', ...)` and `res.on('close', ...)` fire once the request has been handled, just before the response is returned to the platform. Request logging (`server.requestLogging`, on by default outside production) logs then.
- There is no `res.write()` or `res.writeHead()`. Middleware that streams its response fails on these runtimes exactly as it does when attached to a single route.
- Config-driven helmet and CORS behave as on Node.js: headers are set on every response, a CORS preflight is answered `204` and a disallowed origin `403`. That includes the responses a request hook answers before the global middleware runs: the `429` of a rate limit and the `403` of a CSRF check carry the helmet and CORS headers here too.
- Compression is left to the platform. With `performance.compression` enabled, or `app.use(middleware.compression())`, the body is returned as the handler produced it and API Gateway, CloudFront, Vercel or Cloudflare negotiates the encoding with the client. A `filter` passed to `middleware.compression()` is not consulted on these runtimes, since nothing is compressed inside the function.
- A middleware that answers from a callback and never calls `next()` (the callback style of an asynchronous check) completes the request: the function returns as soon as the response is answered.

### Cookies

Every cookie is sent as a `Set-Cookie` header of its own, whichever way it is set: `res.cookie()` or `res.clearCookie()` called several times, `res.append('Set-Cookie', ...)`, or `res.setHeader('Set-Cookie', [...])`.

**Cookie options are applied on these runtimes, as on Node.js.** `res.cookie(name, value, options)` and `res.clearCookie(name, options)` send the same `Set-Cookie` value the Node.js server sends for the same arguments: the value is URL-encoded, `Path` defaults to `/`, and `maxAge` (milliseconds, sent as seconds of `Max-Age`), `expires`, `httpOnly`, `secure`, `sameSite`, `domain` and `path` become the matching attributes. An invalid cookie name, `domain`, `path` or `sameSite` throws a `TypeError` at the call, as on Node.js.

A cookie set with no `secure` option is `Secure` when the request reached the platform over https, as on the Node.js server it is when the request arrived over TLS. There is no connection to look at in a function, so the platform's word is taken: the scheme of the request URL on Vercel Edge and Cloudflare Workers, and the `X-Forwarded-Proto` header that API Gateway, a Function URL or a load balancer writes on AWS Lambda. `secure: true` and `secure: false` are taken as written.

```typescript
app.post('/login', (req, res) => {
  res.cookie('session', 'abc123', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 60 * 60 * 1000, // one hour, in milliseconds
  });
  // Set-Cookie: session=abc123; Max-Age=3600; HttpOnly; Secure; SameSite=strict; Path=/
  return { success: true };
});

app.post('/logout', (req, res) => {
  res.clearCookie('session');
  // Set-Cookie: session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; Path=/
  // (`Secure` because the request arrived over https; over plain http it is left out)
  return { success: true };
});
```

`res.cookie()` does not sign by itself on these runtimes: without the cookie middleware, `signed: true` sends the value as given and logs a warning once. Install `middleware.cookie({ secret })` with `app.use()` and signed cookies are signed on the way out and verified into `req.signedCookies` on the way in, as on Node.js.

`req.cookies` holds the request's cookies on all three runtimes, parsed as on Node.js: values are URL-decoded, so what `res.cookie('name', 'a b')` wrote (`name=a%20b` on the wire) reads back as `req.cookies.name === 'a b'`. A value that is not valid percent-encoding is kept as sent, a repeated name has its last value, and a cookie with an empty value is left out.

### Response Bodies

- A string is sent as it is; an object is sent as JSON with `Content-Type: application/json`.
- A `Buffer`, a typed array or an `ArrayBuffer` is sent as bytes under the `Content-Type` the handler set (`application/octet-stream` when it set none). On Lambda the bytes are base64-encoded for the platform (see [Binary Responses](#binary-responses)).
- On Vercel Edge and Cloudflare Workers a web `ReadableStream` passed to `res.send()` is streamed to the client. `res.send()` is typed for strings and Buffers, so TypeScript needs a cast for a stream or a typed array.
- On Vercel Edge and Cloudflare Workers a response with status 204, 205 or 304 is sent without a body, whatever the handler passed.
- CR and LF characters are removed from header values (`res.setHeader()`, `res.append()`, `res.redirect()`, `res.cookie()`).

### Request Bodies

- A JSON body (`Content-Type: application/json`) is parsed into `req.body`.
- On Vercel Edge and Cloudflare Workers a malformed JSON body is answered with `400` and `{ "success": false, "error": "Invalid request body", "requestId": "..." }` before the handler runs, as on Node.js; an empty body gives `req.body === null`.
- On Lambda a malformed JSON body reaches the handler as the string that was sent.
- A URL-encoded form body is parsed into an object on Cloudflare Workers and reaches the handler as a string on Lambda and Vercel Edge.
- Other bodies reach the handler as a string. Binary request bodies are not supported on these runtimes: the bytes are decoded as text.

---

## Cross-Runtime Compatibility

### Shared Application Code

Write your application logic once and deploy to any runtime:

```typescript
// shared/app.ts
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

export function setupRoutes(app: any) {
  app.get('/api/health', () => ({ status: 'healthy' }));

  app
    .post('/api/users')
    .body(UserSchema)
    .rateLimit({ requests: 100, window: 60000 })
    .handler(async (req, res) => {
      // This handler works on all runtimes
      const user = await createUser(req.body);
      return { success: true, data: user };
    });

  app
    .get('/api/users/:id')
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

// setupRoutes() registers a WebSocket namespace on Node.js, and WebSockets are opt-in
const app = await createApp({ websocket: { enabled: true } });
setupRoutes(app);
app.listen(3000);

// vercel-edge.ts
import { createAppEdge } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = await createAppEdge();
setupRoutes(app);
export default app.getHandler();

// lambda.ts
import { createAppLambda } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = await createAppLambda();
setupRoutes(app);
export const handler = app.getHandler();

// worker.ts
import { createAppWorker } from '@morojs/moro';
import { setupRoutes } from './shared/app.js';

const app = await createAppWorker();
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
        ray: req.headers['cf-ray'],
      }),
      ...(runtime === 'aws-lambda' && {
        requestId: req.context?.awsRequestId,
        functionName: req.context?.functionName,
      }),
      ...(runtime === 'vercel-edge' && {
        region: process.env.VERCEL_REGION,
      }),
    };
  });

  // Runtime-specific routes
  if (app.getRuntimeType() === 'node') {
    app.websocket('/ws', {
      connection: socket => console.log('Connected'),
      message: (socket, data) => socket.broadcast.emit('message', data),
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

// Secrets have no fallback value. A default in code becomes the production
// secret the first time the variable is missing, so fail at startup instead.
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET is not set (generate one with: openssl rand -hex 32)');
}

export const config = {
  database: {
    url: process.env.DATABASE_URL,
    pool: {
      min: process.env.DB_POOL_MIN ? parseInt(process.env.DB_POOL_MIN) : 2,
      max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX) : 10,
    },
  },
  cache: {
    redis: process.env.REDIS_URL,
    ttl: process.env.CACHE_TTL ? parseInt(process.env.CACHE_TTL) : 300,
  },
  auth: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
};
```

### Runtime-Specific Configuration

```typescript
// config/runtime.ts
import type { MoroOptions } from '@morojs/moro';

export function getRuntimeConfig(runtime: string): MoroOptions {
  const baseConfig: MoroOptions = {
    cors: true,
    compression: true,
    helmet: true,
  };

  switch (runtime) {
    case 'node':
      return {
        ...baseConfig,
        // Fork workers across cores in production
        performance: {
          clustering: { enabled: process.env.NODE_ENV === 'production' },
        },
        websocket: { enabled: true },
      };

    case 'aws-lambda':
      return {
        ...baseConfig,
        // Reuse connections between invocations; memory and timeout are
        // configured on the Lambda function itself, not in the app
        server: { timeouts: { keepAlive: 5000 } },
      };

    case 'vercel-edge':
    case 'cloudflare-workers':
      // Nothing runtime-specific to pass here: regions are chosen in the
      // platform's own route config (`export const config` / vercel.json),
      // and KV namespaces and Durable Objects are bound in wrangler.toml and
      // reach a handler as `req.env`
      return baseConfig;

    default:
      return baseConfig;
  }
}
```

The object is what `createApp()` (or the runtime's own factory) takes: `createApp(getRuntimeConfig('node'))`.

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
    serverless: ['aws-lambda', 'vercel-edge', 'cloudflare-workers'].includes(runtime),
  };
});
```

### 3. Optimize for Target Runtime

Clustering and socket reuse are configuration, not middleware — they are settled
when the app is created, so pass them to `createApp()`:

```typescript
const app = await createApp({
  // Node.js: one worker per core (SO_REUSEPORT; Node server on Windows)
  performance: {
    clustering: { enabled: true, workers: 'auto' },
  },
  // Keep sockets warm between invocations
  server: {
    timeouts: { keepAlive: 5000 },
  },
});
```

Middleware is what varies per runtime:

```typescript
// Node.js optimization
if (app.getRuntimeType() === 'node') {
  app.use(middleware.compression({ level: 9 }));
}

// Edge optimization
if (['vercel-edge', 'cloudflare-workers'].includes(app.getRuntimeType())) {
  app.use(middleware.cache({ defaultTtl: 60 }));
}

// Lambda observability: CloudWatch metrics via Embedded Metric Format
// (zero-dependency — emitted through stdout, ingested by CloudWatch Logs)
if (app.getRuntimeType() === 'aws-lambda') {
  app.use(middleware.cloudWatch({ namespace: 'MoroAPI' }));
}
```

### 4. Testing Across Runtimes

```typescript
// test/runtime.test.ts
import { createApp, createAppEdge, createAppLambda, createAppWorker } from '@morojs/moro';
// setupRoutes is your own application code (not a framework export)
import { setupRoutes } from './shared/app.js';

const runtimes = [
  { name: 'node', factory: createApp },
  { name: 'vercel-edge', factory: createAppEdge },
  { name: 'aws-lambda', factory: createAppLambda },
  { name: 'cloudflare-workers', factory: createAppWorker },
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
      app.use(middleware.requestLogger());
      break;
  }
}
```

---

This runtime guide provides comprehensive information for deploying MoroJS applications across all supported environments. For specific deployment examples, check the [examples repository](https://github.com/Moro-JS/examples/tree/main/runtime-examples).
