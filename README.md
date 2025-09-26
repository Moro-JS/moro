# Moro

<div align="center">

![Moro Logo](https://img.shields.io/badge/MoroJS-2563eb?style=for-the-badge&logo=typescript&logoColor=white)

**Modern TypeScript framework with intelligent routing and multi-runtime deployment**
*Functional • Type-safe • Multi-environment • Production-ready*

[![npm version](https://badge.fury.io/js/@morojs%2Fmoro.svg)](https://badge.fury.io/js/@morojs%2Fmoro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)

[**Documentation**](./docs/) • [**Quick Start**](#quick-start) • [**Examples**](#examples) • [**API Reference**](./docs/API.md)

</div>

---

## What is MoroJS?

MoroJS is a modern Node.js framework designed for building high-performance APIs and web applications. It features intelligent routing with automatic middleware ordering, ensuring your application logic runs efficiently without worrying about execution sequence.

**Core Features:**

- **Multi-Runtime Deployment** - Write once, deploy everywhere: Node.js, Vercel Edge, AWS Lambda, Cloudflare Workers
- **Intelligent Routing** - Automatic middleware ordering with chainable and schema-first API approaches
- **Enterprise Authentication** - Built-in Auth.js integration with RBAC, OAuth providers, and custom native adapter
- **Universal Validation** - Use any validation library (Zod, Joi, Yup, Class Validator) with full TypeScript inference
- **WebSocket Support** - Pluggable adapters for Socket.IO, native WebSockets, or automatic detection
- **Zero Dependencies** - Lightweight core with optional peer dependencies for flexibility
- **Functional Architecture** - Pure functional patterns without decorators for better performance
- **Type Safety** - Complete TypeScript support with compile-time and runtime type validation

## Performance

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

## How MoroJS Works

### **Intelligent Middleware Ordering**

MoroJS automatically organizes middleware execution into logical phases, eliminating order-dependency issues:

```typescript
// Write middleware in any order - the framework optimizes execution
app.post('/users')
   .body(UserSchema)                              // Validation phase
   .rateLimit({ requests: 10, window: 60000 })    // Rate limiting phase
   .auth({ roles: ['user'] })                     // Authentication phase
   .handler(createUser);                          // Handler phase (always last)

// Behind the scenes, MoroJS executes in this order:
// 1. CORS & Security (helmet)
// 2. Rate Limiting
// 3. Authentication & Authorization
// 4. Body Parsing & Validation
// 5. Custom Middleware
// 6. Route Handler
```

### **Universal Validation System**

MoroJS provides a unified validation interface that works with any validation library while maintaining full TypeScript inference:

```typescript
// Using Zod (built-in support)
import { z } from '@morojs/moro';
const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).optional()
});

// Using Joi with MoroJS adapter
import { joi } from '@morojs/moro';
import Joi from 'joi';
const UserSchemaJoi = joi(Joi.object({
  name: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  age: Joi.number().min(18).optional()
}));

// Using Yup with MoroJS adapter
import { yup } from '@morojs/moro';
import * as Yup from 'yup';
const UserSchemaYup = yup(Yup.object({
  name: Yup.string().min(2).max(50).required(),
  email: Yup.string().email().required(),
  age: Yup.number().min(18).optional()
}));

// All validation libraries provide the same TypeScript experience
app.post('/users')
   .body(UserSchema)  // Full type inference regardless of validation library
   .handler((req, res) => {
     const user = req.body; // ✨ Fully typed based on schema
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

### WebSocket Support

Pluggable WebSocket adapters with auto-detection:

```typescript
import { createApp, SocketIOAdapter, WSAdapter } from '@morojs/moro';

const app = createApp({
  // Auto-detect available WebSocket library
  websocket: { enabled: true },

  // Or use specific adapter
  websocket: { adapter: new SocketIOAdapter() },

  // Or native WebSockets
  websocket: { adapter: new WSAdapter() }
});

// Define WebSocket handlers
app.websocket('/chat', {
  connect: (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.join('general');
  },

  message: (socket, data) => {
    socket.to('general').emit('message', {
      user: socket.user,
      text: data.text,
      timestamp: new Date()
    });
  },

  disconnect: (socket) => {
    console.log(`Client disconnected: ${socket.id}`);
  }
});
```

### Authentication & Security

Built-in Auth.js integration with enterprise features:

```typescript
import { auth, requireAuth, authUtils } from '@morojs/moro/middleware';

// Setup Auth.js with multiple providers
app.use(auth({
  providers: [
    providers.github({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
    providers.google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.AUTH_SECRET!,
}));

// Protect routes with role-based access
app.get('/admin/users', withMiddleware(requireAuth({
  roles: ['admin']
}), (req, res) => {
  return { users: getAllUsers() };
}));

// Manual authentication checks
app.get('/profile', (req, res) => {
  if (!authUtils.isAuthenticated(req)) {
    return authResponses.unauthorized(res);
  }

  return {
    user: authUtils.getUser(req),
    permissions: authUtils.getUserPermissions(req)
  };
});
```

**Features:**
- **OAuth Providers** - GitHub, Google, Microsoft, LinkedIn, Discord
- **Enterprise SSO** - Okta, Auth0, AWS Cognito
- **Role-Based Access Control (RBAC)** - Fine-grained permissions
- **Native Auth.js Adapter** - Zero external dependencies
- **Security Audit Logging** - Track authentication events
- **Production Ready** - JWT sessions, CSRF protection, secure cookies

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
- [**Authentication Guide**](./docs/AUTH_GUIDE.md) - Complete Auth.js integration with RBAC
- [**Native Auth Adapter**](./docs/NATIVE_AUTH_ADAPTER.md) - Custom `@auth/morojs` adapter
- [**API Reference**](./docs/API.md) - Complete framework API documentation
- [**Migration Guide**](./docs/MIGRATION.md) - From Express, Fastify, NestJS
- [**Performance Guide**](./docs/PERFORMANCE.md) - Optimization and benchmarks
- [**Runtime System**](./docs/RUNTIME.md) - Multi-runtime deployment guide
- [**Examples Repository**](../Moro-JS/examples/) - Working examples

### **Key Concepts**
- **Multi-Runtime Support** - Same API works on Node.js, Edge, Lambda, and Workers
- **Intelligent Routing** - Automatic middleware ordering eliminates Express.js pain points
- **Enterprise Authentication** - Auth.js integration with OAuth, RBAC, and native adapter
- **Universal Validation** - Support for any validation library with full type safety
- **WebSocket Flexibility** - Choose between Socket.IO, native WebSockets, or auto-detection
- **Functional Architecture** - No decorators, pure functions, better performance
- **Type Safety** - Universal validation with compile-time and runtime type safety

## Key Benefits

**Universal Deployment** - Write your application once and deploy it seamlessly to Node.js, Vercel Edge Functions, AWS Lambda, or Cloudflare Workers using the same codebase

**Intelligent Architecture** - The framework automatically handles middleware execution order, eliminating configuration complexity and potential runtime errors

**Enterprise-Grade Authentication** - Comprehensive Auth.js integration includes OAuth providers, RBAC permissions, custom session management, and a native `@auth/morojs` adapter

**Flexible Validation** - Choose your preferred validation library (Zod, Joi, Yup, or Class Validator) while maintaining complete TypeScript inference and runtime safety

**Real-Time Communication** - Built-in WebSocket support with pluggable adapters for Socket.IO, native WebSockets, or automatic library detection

**Type Safety Throughout** - End-to-end TypeScript support ensures compile-time validation, runtime type checking, and full IDE integration

**Developer Experience** - Clean chainable APIs and schema-first routing patterns make complex applications simple to build and maintain

**Production Features** - Circuit breakers, rate limiting, event systems, caching, monitoring, and performance optimization built-in

## Contributing

We welcome contributions! See our [Contributing Guide](./docs/CONTRIBUTING.md) for details.

## License

MIT © [Moro Framework Team](https://morojs.com)

---

<div align="center">

**Ready to deploy everywhere with one codebase?**

[Get Started](./docs/GETTING_STARTED.md) • [GitHub](https://github.com/Moro-JS/moro) • [npm](https://www.npmjs.com/package/@morojs/moro) • [Discord](https://morojs.com/discord)

</div>
