# Moro

<div align="center">

![Moro Logo](https://morojs.com/MoroText.png)

**Modern TypeScript framework with intelligent routing, ESM, and extreme performance**

[![npm version](https://badge.fury.io/js/@morojs%2Fmoro.svg)](https://badge.fury.io/js/@morojs%2Fmoro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

[**Website**](https://morojs.com) • [**Documentation**](https://morojs.com/docs) • [**Quick Start**](https://morojs.com/docs/getting-started) • [**Discord**](https://morojs.com/discord)

</div>

---

## Why MoroJS?

Build high-performance APIs with intelligent routing that automatically orders middleware execution. Deploy anywhere: Node.js, Vercel Edge, AWS Lambda, or Cloudflare Workers - same code, zero configuration.

**Key Features:**

- **Native C++ Engine** - ~102k req/s real-world through the full framework, 572k pipelined, on a single thread
- **Intelligent Routing** - Automatic middleware ordering, no configuration needed
- **Enterprise Auth** - Built-in Auth.js with OAuth & RBAC
- **Universal Validation** - Works with Zod, Joi, Yup, or Class Validator
- **Message Queues** - Production-ready queues (Bull, RabbitMQ, SQS, Kafka)
- **gRPC Support** - Native gRPC for high-performance microservices
- **Multi-Runtime** - Deploy to Node.js, Edge, Lambda, or Workers
- **Powerful CLI** - Scaffold projects, generate modules, deploy with one command
- **Zero third-party dependencies** - lightweight core (just Moro's own native engine) with optional integrations

## Performance

MoroJS is the fastest Node.js framework we've measured (not just because its ours) — its native engine beats uWebSockets.js in both benchmark profiles while running the **full framework** (routing, validation, middleware): **~102k req/s real-world at 0.9 ms latency** and **572k req/s pipelined**, on a single thread. That's ~1.5× Fastify and ~2× Express out of the box. Full comparison tables, methodology, and saved results live in the **[MoroJS Benchmark repo](https://github.com/Moro-JS/benchmark)**.

## Quick Start

### Install Manually

```bash
npm install @morojs/moro
```

```typescript
import { createApp, z } from '@morojs/moro';

const app = createApp();

// Intelligent routing - order doesn't matter!
app
  .post('/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .rateLimit({ requests: 10, window: 60000 })
  .handler((req, res) => {
    // req.body is fully typed and validated
    return { success: true, data: req.body };
  });

app.listen(3000);
```

### Or Use the CLI

Scaffold a complete project with auth, database, WebSockets, and deployment ready:

```bash
npm install -g @morojs/cli
morojs-cli init my-api --runtime=node --database=postgresql --features=auth,websocket,docs
cd my-api
npm run dev
```

Learn more at [morojs.com/cli](https://morojs.com/cli)

### HTTP Engine

Moro ships its own native HTTP engine (`@morojs/engine`) and uses it by default,
falling back to the Node.js http server wherever a prebuilt binary isn't
available. Pick the backend with `server.engine`:

```typescript
const app = createApp({
  server: {
    engine: 'moro', // default - Moro's native engine (Node.js fallback if it can't load)
    // engine: 'node' - the Node.js http server (no native engine)
    // engine: 'uws'  - opt in to uWebSockets.js
  },
});

// Check which engine actually booted (logged at startup too)
app.engine; // { server, enginePackage?, engineVersion?, protocols?, fallbackReason? }
```

#### TLS / HTTPS (unified config)

One `server.ssl` config flows to whichever runtime serves — the Moro engine terminates TLS in-process, as do the Node https server, uWebSockets.js (file paths only), and the HTTP/2 server. Both shapes are accepted:

```typescript
// Inline PEM (node-style) — works on engine, node, http2
createApp({ server: { engine: 'moro', ssl: { key, cert, ca } } });

// File paths — works on every runtime incl. uWS
createApp({ server: { engine: 'moro', ssl: { keyFile: './key.pem', certFile: './cert.pem' } } });
```

#### HTTP/2

`http2: true` serves ALPN h2 + http/1.1. When `engine: 'moro'` and the engine
build supports h2 it is served natively; otherwise Moro uses its dedicated
HTTP/2 server. Requires TLS.

```typescript
createApp({ server: { engine: 'moro', http2: true, ssl: { key, cert } } });
```

#### Configurable limits (no arbitrary caps)

Every limit is a documented default you can override; values flow through to
the engine. Nothing is silently capped.

```typescript
createApp({
  server: {
    bodySizeLimit: '10mb', // maxUploadSize: '100mb' for multipart
    maxConnections: 0, // 0 = unlimited
    timeouts: { request: 30000, idle: 0, keepAlive: 5000, headers: 6000 },
    limits: {
      maxHeaderSize: '64kb',
      maxHeaders: 100,
      wsMaxMessageSize: '16mb',
      wsBackpressureLimit: '1mb',
      multipart: { maxParts: 1000, maxFiles: 20, maxFileSize: '25mb' },
    },
  },
});
```

See [HTTP Engine Guide](./docs/UWEBSOCKETS_GUIDE.md),
[HTTP/2 Guide](./docs/HTTP2_GUIDE.md), and the
[Configuration Reference](./docs/CONFIGURATION_REFERENCE.md) for the full
defaults table.

## Deploy Everywhere

Same code, multiple platforms:

```typescript
// Node.js
app.listen(3000);

// Vercel Edge
export default app.getHandler();

// AWS Lambda
export const handler = app.getHandler();

// Cloudflare Workers
export default { fetch: app.getHandler() };
```

## Documentation

📚 **Complete guides at [morojs.com/docs](https://morojs.com/docs)**

- [Getting Started](https://morojs.com/docs)
- [CLI Tools](https://morojs.com/cli)
- [Authentication](https://morojs.com/docs/features/authentication)
- [Validation](https://morojs.com/docs/validation)
- [WebSockets](https://morojs.com/docs/features/websockets)
- [uWebSockets.js Setup](./docs/UWEBSOCKETS_GUIDE.md)
- [API Reference](https://morojs.com/technical)

## Examples

Check out [working examples](https://github.com/Moro-JS/examples) for:

- REST APIs with validation
- Real-time WebSocket apps
- Auth.js integration
- Multi-runtime deployment
- Database integration
- And more...

## Why Choose MoroJS?

**vs Express** - Intelligent middleware ordering eliminates configuration complexity and race conditions

**vs Fastify** - ~1.5x the throughput out of the box (Moro's native engine), plus multi-runtime deployment without adapters

**vs NestJS** - Functional architecture without decorators, with a fraction of the per-request overhead

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./docs/CONTRIBUTING.md)

## License

MIT © [Moro Framework Team](https://morojs.com)

---

<div align="center">

**Ready to build high-performance APIs?**

[Get Started](https://morojs.com/docs/getting-started) • [GitHub](https://github.com/Moro-JS/moro) • [npm](https://www.npmjs.com/package/@morojs/moro) • [Discord](https://morojs.com/discord)

</div>
