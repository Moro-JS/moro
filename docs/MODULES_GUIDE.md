# Module System Guide

Complete guide to MoroJS's modular architecture for building scalable, maintainable applications.

## Overview

MoroJS provides a powerful module system that allows you to organize your application into self-contained, reusable modules. Each module can have its own routes, services, middleware, websockets, and configuration.

## Table of Contents

- [Basic Module Definition](#basic-module-definition)
- [Module Structure](#module-structure)
- [Routes in Modules](#routes-in-modules)
- [Module Services](#module-services)
- [Module Configuration](#module-configuration)
- [Module Discovery](#module-discovery)
- [Module Dependencies](#module-dependencies)
- [WebSockets in Modules](#websockets-in-modules)
- [Module Lifecycle](#module-lifecycle)
- [Best Practices](#best-practices)

## Basic Module Definition

### Simple Module

```typescript
import { defineModule } from '@morojs/moro';

export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  routes: [
    {
      method: 'GET',
      path: '/users',
      handler: async (req, res) => {
        res.json({ users: [] });
      },
    },
  ],
});
```

### Loading a Module

```typescript
import { createApp } from '@morojs/moro';
import { userModule } from './modules/user';

const app = await createApp();

// Load module manually
await app.loadModule(userModule);

await app.listen(3000);
```

## Module Structure

### Recommended File Structure

```
src/
  modules/
    user/
      index.ts         # Module definition
      services.ts      # Service classes
      handlers.ts      # Route handlers
      types.ts         # TypeScript types
    order/
      index.ts
      services.ts
      handlers.ts
    shared/
      database.ts      # Shared services
      types.ts         # Shared types
```

### Complete Module Example

```typescript
// modules/user/types.ts
export interface User {
  id: string;
  email: string;
  name: string;
}

export interface CreateUserDto {
  email: string;
  name: string;
  password: string;
}
```

```typescript
// modules/user/services.ts
export class UserService {
  constructor(private db: any) {}

  async findAll(): Promise<User[]> {
    return this.db.query('SELECT * FROM users');
  }

  async findById(id: string): Promise<User | null> {
    const users = await this.db.query('SELECT * FROM users WHERE id = ?', [id]);
    return users[0] || null;
  }

  async create(data: CreateUserDto): Promise<User> {
    const result = await this.db.query(
      'INSERT INTO users (email, name, password) VALUES (?, ?, ?)',
      [data.email, data.name, data.password]
    );
    return this.findById(result.insertId);
  }

  async delete(id: string): Promise<boolean> {
    await this.db.query('DELETE FROM users WHERE id = ?', [id]);
    return true;
  }
}
```

```typescript
// modules/user/handlers.ts
import { getApp } from '@morojs/moro';
import type { HttpRequest, HttpResponse } from '@morojs/moro';
import type { UserService } from './services';

// Services live on the app's container (registered in app.ts below)
const userService = () => getApp().getContainer().resolve<UserService>('userService');

export async function listUsers(req: HttpRequest, res: HttpResponse) {
  const users = await userService().findAll();
  res.json(users);
}

export async function getUser(req: HttpRequest, res: HttpResponse) {
  const user = await userService().findById(req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
}

export async function createUser(req: HttpRequest, res: HttpResponse) {
  const user = await userService().create(req.body);
  res.status(201).json(user);
}

export async function deleteUser(req: HttpRequest, res: HttpResponse) {
  await userService().delete(req.params.id);
  res.status(204).end();
}
```

```typescript
// modules/user/index.ts
import { defineModule, z } from '@morojs/moro';
import * as handlers from './handlers';

export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  // Define routes
  routes: [
    {
      method: 'GET',
      path: '/users',
      handler: handlers.listUsers,
    },
    {
      method: 'GET',
      path: '/users/:id',
      handler: handlers.getUser,
    },
    {
      method: 'POST',
      path: '/users',
      handler: handlers.createUser,
      validation: {
        body: z.object({
          email: z.string().email(),
          name: z.string(),
          password: z.string().min(8),
        }),
      },
    },
    {
      method: 'DELETE',
      path: '/users/:id',
      handler: handlers.deleteUser,
      auth: {
        roles: ['admin'],
      },
    },
  ],
});
```

```typescript
// app.ts
import { createApp } from '@morojs/moro';
import { UserService } from './modules/user/services';
import { userModule } from './modules/user';

const app = await createApp();

// Register the module's services on the app container. Each is built once, on first use,
// and shared (a singleton; `true` states the default).
// 'database' is the adapter registered with app.database(adapter).
const container = app.getContainer();
container.register('userService', () => new UserService(container.resolve('database')), true);

await app.loadModule(userModule);
```

## Routes in Modules

### Module URL Structure

Module routes are automatically prefixed with a versioned path. By default, the URL structure is:

```
{apiPrefix}/v{version}/{moduleName}{routePath}
```

**Default behavior:**

- `apiPrefix`: `/api/` (configurable)
- `version`: Module version (e.g., `1.0.0`)
- `moduleName`: Module name
- `routePath`: Individual route path

**Example:**

```typescript
export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',
  routes: [
    {
      method: 'GET',
      path: '/list',
      handler: async (req, res) => {
        // This route will be available at: /api/v1.0.0/user/list
        res.json({ users: [] });
      },
    },
  ],
});
```

### Configuring API Prefix

You can customize or remove the API prefix in your configuration:

```typescript
// moro.config.ts
export default {
  modules: {
    apiPrefix: '/api/', // Default - all modules start with /api/
  },
};
```

**Remove the prefix entirely:**

```typescript
export default {
  modules: {
    apiPrefix: '', // No prefix - routes start with /v{version}/{moduleName}
  },
};
```

**Custom prefix:**

```typescript
export default {
  modules: {
    apiPrefix: '/v1/', // Custom prefix - routes start with /v1/v{version}/{moduleName}
  },
};
```

**Examples with different prefixes:**

| Config            | Module Name | Version | Route Path | Final URL                    |
| ----------------- | ----------- | ------- | ---------- | ---------------------------- |
| `/api/` (default) | `user`      | `1.0.0` | `/list`    | `/api/v1.0.0/user/list`      |
| `` (empty)        | `user`      | `1.0.0` | `/list`    | `/v1.0.0/user/list`          |
| `/services/`      | `user`      | `1.0.0` | `/list`    | `/services/v1.0.0/user/list` |
| `/v1/`            | `admin`     | `2.0.0` | `/users`   | `/v1/v2.0.0/admin/users`     |

### Route Configuration

```typescript
export const productModule = defineModule({
  name: 'product',
  version: '1.0.0',

  routes: [
    {
      method: 'GET',
      path: '/products',
      handler: async (req, res) => {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const products = await getProducts(page, limit);
        res.json(products);
      },
    },
    {
      method: 'POST',
      path: '/products',
      handler: async (req, res) => {
        const product = await createProduct(req.body);
        res.status(201).json(product);
      },
      // Validation (any supported schema: body, query, params, headers)
      validation: {
        body: z.object({
          name: z.string(),
          price: z.number().min(0),
          category: z.string(),
        }),
      },
      // Authentication & Authorization
      auth: {
        roles: ['admin', 'manager'],
        permissions: ['product:create'],
      },
    },
    {
      method: 'GET',
      path: '/products/:id/price-history',
      // At most 30 requests a minute per client; over it, 429 with Retry-After
      rateLimit: { requests: 30, window: 60000 },
      // The JSON reply is kept for 60 seconds (GET only)
      cache: { ttl: 60 },
      auth: {
        required: true,
        // A check of this request, after sign-in: may be async
        validator: async req => (await getProductOwner(req.params.id)) === req.auth.user.id,
      },
      handler: async (req, res) => {
        return getPriceHistory(req.params.id);
      },
    },
  ],
});
```

A module route takes `validation`, `auth`, `rateLimit`, `cache` and `middleware`. They run in a fixed order:

1. the module's `middleware`, then the route's `middleware`
2. `rateLimit`: per client, `{ requests, window }` with the window in milliseconds
3. `auth`: sign-in (unless `optional: true`), `roles`, `permissions`, then `validator(req)`; a falsy result or a throw from the validator is a `403` (a `401` when nobody is signed in and `required: true`)
4. `validation`
5. `cache`: `{ ttl, key?, shared? }` with the lifetime in seconds. A stored reply is served only to a request that passed steps 1 to 4, and a signed-in user gets an entry of their own unless `shared: true`
6. the handler

An error that a middleware throws or passes to `next(err)`, or that the handler throws, goes to the handler registered with `app.setErrorHandler()`, as it does for a route registered on the app, and that handler decides the answer: a thrown error with `status: 404` is a `404` when the error handler answers it so. With no error handler, or one that leaves the error unanswered, the route answers `500` with `{ "success": false, "error": "Internal server error", "requestId": "..." }`, whatever status the error carries.

### Circuit Breaker

Module route handlers and module socket handlers run with **no circuit breaker by default**. Set `performance.circuitBreaker.enabled` to put each handler behind one:

```typescript
const app = await createApp({
  performance: {
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5, // failures within monitoringPeriod that open it
      resetTimeout: 60000, // ms it stays open before a trial request
      monitoringPeriod: 10000,
    },
  },
});
```

Only server-side failures count: an error the handler throws, or a `5xx` it answers with. An error that carries a `4xx` `status` / `statusCode`, a `4xx` answer and a validation failure do not, so requests a client can cause at will never open it. While a route's breaker is open the route answers `503` with `Retry-After` and the handler is not run; a socket event answers `{ success: false, code: 'CIRCUIT_OPEN' }`. See the [Circuit Breaker guide](./CIRCUIT_BREAKER.md).

### Route Middleware

Modules support both module-level and route-level middleware, with flexible options for using built-in middleware by name or custom middleware functions.

#### Module-Level Middleware

Apply middleware to all routes in a module:

```typescript
import { defineModule, middleware } from '@morojs/moro';

export const apiModule = defineModule({
  name: 'api',
  version: '1.0.0',

  // Applied to ALL routes in this module
  middleware: [
    // Built-in middleware by name (string)
    'helmet',
    'compression',

    // Custom middleware functions
    async (req, res, next) => {
      req.moduleContext = {
        moduleName: 'api',
        timestamp: Date.now(),
      };
      next();
    },

    // Mixed approach: a built-in, configured
    middleware.bodySize({ limit: '1mb' }),
  ],

  routes: [
    {
      method: 'GET',
      path: '/data',
      handler: async (req, res) => {
        // Module middleware runs before this handler
        return { data: 'public data' };
      },
    },
  ],
});
```

#### Route-Level Middleware

Apply middleware to specific routes:

```typescript
export const apiModule = defineModule({
  name: 'api',
  version: '1.0.0',

  routes: [
    {
      method: 'GET',
      path: '/public',
      handler: async (req, res) => {
        return { data: 'public' };
      },
    },
    {
      method: 'POST',
      path: '/secure',
      // Middleware specific to this route only
      middleware: [
        'helmet', // Built-in by string name (default options)
        (req, res, next) => {
          // Custom middleware function
          console.log('Processing secure request');
          next();
        },
      ],
      handler: async (req, res) => {
        return { data: 'secure data' };
      },
    },
  ],
});
```

#### Built-in Middleware Names

These built-in middleware work by string name (instantiated with default options):

- `'helmet'` - Security headers
- `'compression'` - Response compression
- `'bodySize'` - Body size limiting
- `'upload'` - File uploads
- `'range'` - Range requests
- `'requestLogger'` - Request logging
- `'performanceMonitor'` - Slow-request warnings

String names resolve in this order:

1. **User-installed middleware** registered with the middleware manager (e.g. a
   named function installed via `app.use()`), matched by function or metadata name.
2. **Built-in middleware factories**, instantiated once with **default options**.

Hook-based built-ins (`auth`, `cors`, `rateLimit`, `validation`, `cache`, `csrf`,
`csp`, `session`, `sse`, `cdn`, `graphql`) install globally with `app.use(...)`
and cannot run per-route by string name. Built-ins that require configuration
(`staticFiles`, `template`) must be passed as configured middleware functions.
For auth enforcement, validation, rate limiting and caching, use the route's
own config fields (`auth`, `validation`, `rateLimit`, `cache`).

A name that cannot be resolved **fails the request with a 500** rather than being
silently skipped — a declared middleware (such as an auth guard) never quietly
disappears from the chain.

#### Combined Module and Route Middleware

```typescript
export const apiModule = defineModule({
  name: 'api',
  version: '1.0.0',

  // Module-level: runs on ALL routes
  middleware: [
    'helmet',
    'compression',
    async (req, res, next) => {
      req.startTime = Date.now();
      next();
    },
  ],

  routes: [
    {
      method: 'GET',
      path: '/public',
      handler: async (req, res) => {
        // Only module middleware runs
        return { data: 'public' };
      },
    },
    {
      method: 'POST',
      path: '/admin',
      // Route-level: runs AFTER module middleware
      middleware: ['bodySize'],
      auth: { roles: ['admin'] },
      handler: async (req, res) => {
        // Both module AND route middleware have run
        return { data: 'admin data' };
      },
    },
  ],
});
```

#### Execution Order

Middleware executes in this order:

1. **Global middleware** (app.use())
2. **Module-level middleware** (applied to all routes in module)
3. **Route-level middleware** (applied to specific route)
4. **Route config**: `rateLimit`, `auth`, `validation`, `cache`, in that order
5. **Route handler**

```typescript
// Execution flow example
app.use(globalLogging); // 1. Runs first

export const myModule = defineModule({
  name: 'myModule',
  version: '1.0.0',

  middleware: [moduleAuth], // 2. Runs second

  routes: [
    {
      method: 'POST',
      path: '/data',
      middleware: [routeValidation], // 3. Runs third
      handler: async (req, res) => {
        // 5. Runs last
        return { success: true };
      },
    },
  ],
});
```

#### Custom Middleware Functions

```typescript
// Async middleware
const asyncLogger = async (req, res, next) => {
  await logToDatabase(req);
  next();
};

// Error handling middleware
const errorHandler = (req, res, next) => {
  try {
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Conditional middleware
const conditionalAuth = (req, res, next) => {
  if (req.path.startsWith('/admin')) {
    // Check auth for admin routes
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
};

export const myModule = defineModule({
  name: 'myModule',
  version: '1.0.0',
  middleware: [asyncLogger, errorHandler, conditionalAuth],
  routes: [/* ... */],
});
```

## Module Services

Services allow you to inject dependencies and share logic across your module. Register them on the app's container and resolve them in your handlers.

A registered service is a singleton: its factory runs once, the first time the service is resolved, and every handler gets that instance. That is the container's default, with or without `true` as the third argument. For a new instance on every resolve, pass `{ lifetime: 'transient' }` instead (see the [Dependency Injection Guide](./DEPENDENCY_INJECTION.md#2-transient)).

### Service Registration

```typescript
class EmailService {
  async send(to: string, subject: string, body: string) {
    // Email sending logic
  }
}

class NotificationService {
  constructor(
    private emailService: EmailService,
    private smsService: any
  ) {}

  async notify(user: any, message: string) {
    await this.emailService.send(user.email, 'Notification', message);
    if (user.phone) {
      await this.smsService.send(user.phone, message);
    }
  }
}

// Register on the app container: one instance of each for the app
const container = app.getContainer();
container.register('emailService', () => new EmailService(), true);
container.register(
  'notificationService',
  () => new NotificationService(container.resolve('emailService'), container.resolve('smsService')),
  true
);

export const notificationModule = defineModule({
  name: 'notification',
  version: '1.0.0',

  routes: [
    {
      method: 'POST',
      path: '/notify',
      handler: async (req, res) => {
        const notificationService = container.resolve<NotificationService>('notificationService');

        await notificationService.notify(req.body.user, req.body.message);
        res.json({ success: true });
      },
    },
  ],
});
```

## Module Configuration

### Module-Specific Config

```typescript
export const analyticsModule = defineModule({
  name: 'analytics',
  version: '1.0.0',

  config: {
    // Module configuration
    trackingId: process.env.ANALYTICS_TRACKING_ID,
    enabled: process.env.NODE_ENV === 'production',
    sampleRate: 0.1,
    endpoints: {
      track: '/track',
      events: '/events',
    },
  },

  routes: [
    {
      method: 'POST',
      path: '/track',
      handler: async (req, res) => {
        // Access module config
        const config = analyticsModule.config;

        if (!config.enabled) {
          return res.json({ tracked: false });
        }

        // Tracking logic
        res.json({ tracked: true });
      },
    },
  ],
});
```

### Environment-Based Config

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

export const authModule = defineModule({
  name: 'auth',
  version: '1.0.0',

  config: {
    jwtSecret: process.env.JWT_SECRET,
    tokenExpiry: isDevelopment ? '7d' : '1h',
    refreshTokenExpiry: '30d',
    bcryptRounds: isDevelopment ? 4 : 12,
    attemptLimits: {
      login: isDevelopment ? 1000 : 5,
      register: isDevelopment ? 1000 : 3,
    },
  },

  routes: [
    // Routes here
  ],
});
```

## Module Discovery

### Auto-Discovery

Automatically discover and load modules from a directory:

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  autoDiscover: {
    paths: ['./src/modules'],
  },
});

// Modules are automatically discovered and loaded
await app.listen(3000);
```

Discovered modules load in the order of their file paths below each directory in `paths`, compared one path segment at a time by character code (so `Users/` comes before `admin/`, and `a/` before `a-b/`), and, with the default `loadOrder: 'dependency'`, a module named in another's `dependencies` is moved ahead of it. The order is the same on every Node.js version, operating system and file system, with or without `CI` set; when one module's routes or set-up must come after another's, say so in `dependencies` and do not rely on the file names.

### Manual Discovery

```typescript
import { autoDiscoverModuleDirectories } from '@morojs/moro';

const modules = await autoDiscoverModuleDirectories(process.cwd(), './src/modules');

for (const module of modules) {
  console.log(`Discovered module: ${module.name} v${module.version}`);
  await app.loadModule(module);
}
```

## Module Dependencies

### Declaring Dependencies

```typescript
// Base module
export const databaseModule = defineModule({
  name: 'database',
  version: '1.0.0',
});

// Dependent module
export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  // Declare dependencies
  dependencies: ['database'],
});

// Services go on the app container; a factory resolves what it depends on
const container = app.getContainer();
container.register('database', () => new DatabaseService(), true);
container.register('userService', () => new UserService(container.resolve('database')), true);

// Load in correct order
await app.loadModule(databaseModule);
await app.loadModule(userModule); // Will have access to database service
```

### Cross-Module Services

```typescript
// Shared services, registered once on the app container
const container = app.getContainer();
container.register('logger', () => new LoggerService(), true);
container.register('cache', () => new CacheService(), true);

export const sharedModule = defineModule({
  name: 'shared',
  version: '1.0.0',
});

// Feature modules can use shared services
container.register(
  'orderService',
  () => new OrderService(container.resolve('logger'), container.resolve('cache')),
  true
);

export const orderModule = defineModule({
  name: 'order',
  version: '1.0.0',

  dependencies: ['shared'],
});
```

## WebSockets in Modules

### Socket Definitions

```typescript
export const chatModule = defineModule({
  name: 'chat',
  version: '1.0.0',

  sockets: [
    {
      event: 'message',
      handler: async (socket, data) => {
        const { room, message } = data;

        // Broadcast to room
        socket.to(room).emit('message', {
          user: socket.user,
          message,
          timestamp: Date.now(),
        });
      },
      rooms: ['general', 'random'],
      broadcast: true,
    },
    {
      event: 'join',
      handler: async (socket, data) => {
        const { room } = data;
        socket.join(room);
        socket.emit('joined', { room });
      },
    },
  ],

  routes: [
    {
      method: 'GET',
      path: '/chat/rooms',
      handler: async (req, res) => {
        res.json({ rooms: ['general', 'random'] });
      },
    },
  ],
});
```

## Module Lifecycle

### Initialization Hooks

```typescript
class ModuleService {
  private initialized = false;

  async initialize() {
    // Setup logic
    this.initialized = true;
  }

  async cleanup() {
    // Cleanup logic
    this.initialized = false;
  }
}

export const lifecycleModule = defineModule({
  name: 'lifecycle',
  version: '1.0.0',
});

// Application setup
const app = await createApp();
app.getContainer().register('moduleService', () => new ModuleService(), true);

// 'module:loaded' is emitted on the app event bus; listeners receive { context, data }
app.events.on('module:loaded', ({ data }) => {
  console.log(`Module ${data.moduleId} loaded`);

  // Initialize services
  if (data.moduleId === 'lifecycle') {
    const service = app.getContainer().resolve<ModuleService>('moduleService');
    service.initialize();
  }
});

await app.loadModule(lifecycleModule);

// Cleanup on shutdown
app.onClose(async () => {
  const service = app.getContainer().resolve<ModuleService>('moduleService');
  await service.cleanup();
});
```

## Best Practices

### 1. Keep Modules Focused

```typescript
// Good: Focused module
export const authModule = defineModule({
  name: 'auth',
  version: '1.0.0',
  routes: [
    // Only auth-related routes
  ],
});

// Bad: Kitchen sink module
export const appModule = defineModule({
  name: 'app',
  version: '1.0.0',
  routes: [
    // auth routes, user routes, product routes, etc.
  ],
});
```

### 2. Use Semantic Versioning

```typescript
// v1.0.0 - Initial release
export const userModuleV1 = defineModule({
  name: 'user',
  version: '1.0.0',
  // ...
});

// v1.1.0 - Backward compatible features
export const userModuleV1_1 = defineModule({
  name: 'user',
  version: '1.1.0',
  // Added new optional features
});

// v2.0.0 - Breaking changes
export const userModuleV2 = defineModule({
  name: 'user',
  version: '2.0.0',
  // Changed API structure
});
```

### 3. Document Module API

```typescript
/**
 * User Management Module
 *
 * Provides user CRUD operations and authentication.
 *
 * Services:
 * - userService: User data management
 * - authService: Authentication logic
 *
 * Routes:
 * - GET /users - List all users
 * - GET /users/:id - Get user by ID
 * - POST /users - Create new user
 * - PUT /users/:id - Update user
 * - DELETE /users/:id - Delete user
 *
 * Dependencies:
 * - database: Database connection
 * - cache: Caching service
 *
 * @since 1.0.0
 */
export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',
  // ...
});
```

### 4. Test Modules in Isolation

```typescript
import request from 'supertest';
import { createApp } from '@morojs/moro';
import { userModule } from './modules/user';

describe('User Module', () => {
  let app;

  beforeEach(async () => {
    app = await createApp();

    // Register mock services
    const container = app.getContainer();
    container.register('database', () => mockDatabase, true);

    // Load module
    await app.loadModule(userModule);
    app.listen(3456);
  });

  afterEach(async () => {
    await app.close();
  });

  it('should list users', async () => {
    // Module routes are served under {apiPrefix}/v{version}/{moduleName}
    const response = await request('http://localhost:3456').get('/api/v1.0.0/user/users');
    expect(response.status).toBe(200);
  });
});
```

### 5. Module Configuration Validation

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  apiKey: z.string().min(1),
  timeout: z.number().positive(),
  retries: z.number().int().min(0).max(10),
});

export const externalApiModule = defineModule({
  name: 'external-api',
  version: '1.0.0',

  config: ConfigSchema.parse({
    apiKey: process.env.API_KEY,
    timeout: parseInt(process.env.API_TIMEOUT || '5000'),
    retries: parseInt(process.env.API_RETRIES || '3'),
  }),
});
```

## Complete Example: E-Commerce Modules

```typescript
// modules/shared/index.ts
export const sharedModule = defineModule({
  name: 'shared',
  version: '1.0.0',
});

// modules/user/index.ts
export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',
  dependencies: ['shared'],

  routes: [
    { method: 'GET', path: '/users', handler: listUsers },
    { method: 'POST', path: '/users', handler: createUser },
  ],
});

// modules/product/index.ts
export const productModule = defineModule({
  name: 'product',
  version: '1.0.0',
  dependencies: ['shared'],

  routes: [
    { method: 'GET', path: '/products', handler: listProducts },
    { method: 'POST', path: '/products', handler: createProduct },
  ],
});

// modules/order/index.ts
export const orderModule = defineModule({
  name: 'order',
  version: '1.0.0',
  dependencies: ['shared', 'user', 'product'],

  routes: [
    { method: 'GET', path: '/orders', handler: listOrders },
    { method: 'POST', path: '/orders', handler: createOrder },
  ],
});

// app.ts
const app = await createApp();

// Register services on the app container: one instance of each for the app
const container = app.getContainer();
const get = <T>(name: string) => container.resolve<T>(name);

container.register('database', () => new DatabaseService(), true);
container.register('cache', () => new CacheService(), true);
container.register('logger', () => new LoggerService(), true);
container.register('userService', () => new UserService(get('database'), get('cache')), true);
container.register('productService', () => new ProductService(get('database'), get('cache')), true);
container.register(
  'orderService',
  () => new OrderService(get('database'), get('userService'), get('productService')),
  true
);

// Load modules in dependency order
await app.loadModule(sharedModule);
await app.loadModule(userModule);
await app.loadModule(productModule);
await app.loadModule(orderModule);

await app.listen(3000);
```

## API Reference

### defineModule(definition: ModuleDefinition): ModuleConfig

Creates a module configuration.

### ModuleDefinition Interface

```typescript
interface ModuleDefinition {
  name: string;
  version: string;
  config?: any;
  routes?: ModuleRoute[];
  sockets?: ModuleSocket[];
  dependencies?: string[];
  middleware?: ModuleMiddleware[]; // functions, or names of built-ins
}
```

### App Methods

- `loadModule(module: ModuleConfig | string): Promise<this>` - Load a module (a definition, or a path to one)
- `initModules(options?): void` - Run module auto-discovery now (`paths`, `patterns`, `maxDepth`, ...)

## See Also

- [Dependency Injection Guide](./DEPENDENCY_INJECTION.md)
- [API Reference](./API.md)
- [Getting Started](./GETTING_STARTED.md)
