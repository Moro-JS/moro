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
- **200k+ req/s** - built-in clustering or uWebSockets.js integration (single core)
- **Intelligent Routing** - Automatic middleware ordering, no configuration needed
- **Enterprise Auth** - Built-in Auth.js with OAuth & RBAC
- **Universal Validation** - Works with Zod, Joi, Yup, or Class Validator
- **Message Queues** - Production-ready queues (Bull, RabbitMQ, SQS, Kafka)
- **gRPC Support** - Native gRPC for high-performance microservices
- **Multi-Runtime** - Deploy to Node.js, Edge, Lambda, or Workers
- **Powerful CLI** - Scaffold projects, generate modules, deploy with one command
- **Zero Dependencies** - Lightweight core with optional integrations

## Performance

| Framework | Req/sec | Latency | Memory | Notes |
|-----------|---------|---------|--------|-------|
| **Moro + uWebSockets.js** | **200,000+** | **3.93ms** | **25MB** | Single core |
| **Moro (Clustering)**  | **190,000+** | **3.62ms** | **24MB** | Multi-core |
| **Moro (Standard)**  | **87,000** | **7.8ms** | **14MB** | Single core |
| Fastify   | 38,120  | 2.9ms   | 35MB   | Single core |
| Express   | 28,540  | 3.8ms   | 45MB   | Single core |
| NestJS    | 22,100  | 4.5ms   | 58MB   | Single core |

> **uWebSockets.js** achieves multi-core performance on a single core - perfect for WebSockets and serverless. **Clustering** scales across CPU cores for traditional HTTP workloads.

## Quick Start

### Install Manually

```bash
npm install @morojs/moro
```

```typescript
import { createApp, z } from '@morojs/moro';

const app = createApp();

// Intelligent routing - order doesn't matter!
app.post('/users')
   .body(z.object({
     name: z.string().min(2),
     email: z.string().email()
   }))
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

### Ultra-High Performance (Optional)

```typescript
// uWebSockets.js - 200k+ req/s on single core
const app = createApp({
  server: {
    useUWebSockets: true
  }
});

// Or combine with worker thread clustering for even more power
const app = createApp({
  server: {
    useUWebSockets: true
  },
  performance: {
    clustering: {
      enabled: true,
      workers: 4  // or 'auto' for CPU count
    }
  }
});
```

See [uWebSockets Guide](./docs/UWEBSOCKETS_GUIDE.md)

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

**vs Fastify** - 4x faster with uWebSockets.js, plus multi-runtime deployment without adapters

**vs NestJS** - Functional architecture without decorators, 9x faster, 3x less memory

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./docs/CONTRIBUTING.md)

## License

MIT © [Moro Framework Team](https://morojs.com)

---

<div align="center">

**Ready to build high-performance APIs?**

[Get Started](https://morojs.com/docs/getting-started) • [GitHub](https://github.com/Moro-JS/moro) • [npm](https://www.npmjs.com/package/@morojs/moro) • [Discord](https://morojs.com/discord)

</div>
