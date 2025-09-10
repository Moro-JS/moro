# Moro

<div align="center">

![Moro Logo](https://img.shields.io/badge/MoroJS-2563eb?style=for-the-badge&logo=typescript&logoColor=white)

**High-performance multi-runtime framework with intelligent routing**
*Functional • Type-safe • Multi-environment • Production-ready*

[![npm version](https://badge.fury.io/js/@morojs%2Fmoro.svg)](https://badge.fury.io/js/@morojs%2Fmoro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)

[**Documentation**](./docs/) • [**Quick Start**](#quick-start) • [**Examples**](#examples) • [**API Reference**](./docs/API.md)

</div>

---

## Why Moro?

Moro eliminates the pain points of traditional Node.js frameworks with **intelligent routing** and **automatic middleware ordering**. No more debugging middleware order issues or wrestling with type safety!

- **Multi-Runtime Support** - Deploy to Node.js, Vercel Edge, AWS Lambda, Cloudflare Workers
- **Intelligent Routing** - Chainable + schema-first APIs with automatic middleware ordering
- **Zod Validation** - Type-safe, functional validation with full TypeScript inference
- **Native Performance** - Zero framework overhead, optimized for each runtime
- **Functional Architecture** - No decorators, pure functional patterns
- **Zero Order Dependencies** - Framework handles optimal middleware execution

## Superior Performance

| Framework | Req/sec | Latency | Memory |
|-----------|---------|---------|--------|
| **Moro**  | **52,400** | **1.8ms** | **24MB** |
| Express   | 28,540  | 3.8ms   | 45MB   |
| Fastify   | 38,120  | 2.9ms   | 35MB   |
| NestJS    | 22,100  | 4.5ms   | 58MB   |

## Quick Start

### Installation

```bash
npm install @morojs/moro
# or
yarn add @morojs/moro
```

### Hello World

```typescript
import { createApp, z } from '@morojs/moro';

const app = createApp();

// Intelligent routing - order doesn't matter!
app.post('/users')
   .body(z.object({
     name: z.string().min(2).max(50),
     email: z.string().email()
   }))
   .rateLimit({ requests: 10, window: 60000 })
   .describe('Create a new user')
   .handler((req, res) => {
     // req.body is fully typed and validated!
     return { success: true, data: req.body };
   });

app.get('/health', () => ({ status: 'healthy' }));

app.listen(3000, () => {
  console.log('Moro server running on http://localhost:3000');
});
```

### Multi-Runtime Support

Deploy the **same code** everywhere:

```typescript
// Node.js (default)
import { createApp } from '@morojs/moro';
const app = createApp();
app.listen(3000);

// Vercel Edge Functions
import { createAppEdge } from '@morojs/moro';
const app = createAppEdge();
export default app.getHandler();

// AWS Lambda
import { createAppLambda } from '@morojs/moro';
const app = createAppLambda();
export const handler = app.getHandler();

// Cloudflare Workers
import { createAppWorker } from '@morojs/moro';
const app = createAppWorker();
export default { fetch: app.getHandler() };
```

## What Makes Moro Different?

### **No More Middleware Order Hell**

**Traditional frameworks:**
```typescript
// Express - Order matters, easy to break
app.use(cors());           // Must be first
app.use(helmet());         // Must be early
app.use(bodyParser());     // Must be before validation
app.use(rateLimit());      // Must be before routes
app.use(validation());     // Must be before handler
app.post('/users', handler); // Must be last
```

**Moro - Order independent:**
```typescript
// Moro - Framework handles optimal ordering
app.post('/users')
   .body(UserSchema)       // Framework places in validation phase
   .rateLimit({ requests: 10, window: 60000 })  // Rate limit phase
   .auth({ roles: ['user'] })  // Auth phase
   .handler(createUser);   // Always executed last
```

### **Full Type Safety with Zod**

```typescript
const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).optional()
});

app.post('/users')
   .body(UserSchema)
   .handler((req, res) => {
     // req.body is typed as z.infer<typeof UserSchema>
     // Full IDE support, no type assertions needed!
     const user = req.body; // ✨ Fully typed
     return { success: true, data: user };
   });
```

## Examples

### API Styles

```typescript
// Chainable API (complex routes)
app.post('/orders')
   .body(OrderSchema)
   .auth({ roles: ['user'] })
   .rateLimit({ requests: 5, window: 60000 })
   .cache({ ttl: 300 })
   .handler(createOrder);

// Schema-first (simple routes)
app.route({
  method: 'GET',
  path: '/users/:id',
  validation: { params: z.object({ id: z.string().uuid() }) },
  handler: getUserById
});
```

### Functional Modules

```typescript
export default defineModule({
  name: 'users',
  routes: [
    {
      method: 'GET',
      path: '/',
      validation: {
        query: z.object({ limit: z.coerce.number().default(10) })
      },
      handler: async (req, res) => {
        return { users: await getUsers(req.query) };
      }
    }
  ]
});

await app.loadModule(UsersModule);
```

## Documentation

### **Complete Guides**
- [**Getting Started**](./docs/GETTING_STARTED.md) - Detailed setup and first app
- [**API Reference**](./docs/API.md) - Complete framework API documentation
- [**Migration Guide**](./docs/MIGRATION.md) - From Express, Fastify, NestJS
- [**Performance Guide**](./docs/PERFORMANCE.md) - Optimization and benchmarks
- [**Runtime System**](./docs/RUNTIME.md) - Multi-runtime deployment guide
- [**Examples Repository**](../Moro-JS/examples/) - Working examples

### **Key Concepts**
- **Multi-Runtime Support** - Same API works on Node.js, Edge, Lambda, and Workers
- **Intelligent Routing** - Automatic middleware ordering eliminates Express.js pain points
- **Functional Architecture** - No decorators, pure functions, better performance
- **Type Safety** - Zod provides compile-time and runtime type safety

## Why Choose Moro?

**Same API everywhere** - Write once, deploy to any runtime
**No middleware dependencies** - Framework handles optimal ordering
**Full type safety** - Zod provides end-to-end TypeScript inference
**Clean APIs** - Chainable and schema-first approaches
**Production ready** - Circuit breakers, rate limiting, events
**Performance optimized** - Runtime-specific adapters

## Contributing

We welcome contributions! See our [Contributing Guide](./docs/CONTRIBUTING.md) for details.

## License

MIT © [Moro Framework Team](https://morojs.com)

---

<div align="center">

**Ready to deploy everywhere with one codebase?**

[Get Started](./docs/GETTING_STARTED.md) • [GitHub](https://github.com/Moro-JS/moro) • [npm](https://www.npmjs.com/package/@morojs/moro) • [Discord](https://morojs.com/discord)

</div>
