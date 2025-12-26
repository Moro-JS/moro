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

const app = createApp();

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
import type { Request, Response } from '@morojs/moro';

export async function listUsers(req: Request, res: Response) {
  const userService = req.app.getContainer().resolve('userService');
  const users = await userService.findAll();
  res.json(users);
}

export async function getUser(req: Request, res: Response) {
  const userService = req.app.getContainer().resolve('userService');
  const user = await userService.findById(req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
}

export async function createUser(req: Request, res: Response) {
  const userService = req.app.getContainer().resolve('userService');
  const user = await userService.create(req.body);
  res.status(201).json(user);
}

export async function deleteUser(req: Request, res: Response) {
  const userService = req.app.getContainer().resolve('userService');
  await userService.delete(req.params.id);
  res.status(204).send();
}
```

```typescript
// modules/user/index.ts
import { defineModule } from '@morojs/moro';
import { UserService } from './services';
import * as handlers from './handlers';

export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  // Register module services
  services: [
    {
      name: 'userService',
      implementation: UserService,
      dependencies: ['database'],
      singleton: true,
    },
  ],

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
        body: {
          email: { type: 'string', required: true },
          name: { type: 'string', required: true },
          password: { type: 'string', required: true, min: 8 },
        },
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

## Routes in Modules

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
      // Cache configuration
      cache: {
        ttl: 300, // 5 minutes
        key: req => `products:${req.query.page}:${req.query.limit}`,
      },
      // Rate limiting
      rateLimit: {
        requests: 100,
        window: 60000, // 1 minute
      },
    },
    {
      method: 'POST',
      path: '/products',
      handler: async (req, res) => {
        const product = await createProduct(req.body);
        res.status(201).json(product);
      },
      // Validation
      validation: {
        body: {
          name: { type: 'string', required: true },
          price: { type: 'number', required: true, min: 0 },
          category: { type: 'string', required: true },
        },
      },
      // Authentication & Authorization
      auth: {
        roles: ['admin', 'manager'],
        permissions: ['product:create'],
      },
    },
  ],
});
```

### Route Middleware

```typescript
// Module-level middleware
export const apiModule = defineModule({
  name: 'api',
  version: '1.0.0',

  middleware: [
    // Apply to all routes in this module
    async (req, res, next) => {
      req.moduleContext = {
        moduleName: 'api',
        timestamp: Date.now(),
      };
      next();
    },
  ],

  routes: [
    {
      method: 'GET',
      path: '/data',
      // Route-specific middleware
      middleware: ['auth', 'validateApiKey'],
      handler: async (req, res) => {
        res.json({ data: 'secure data' });
      },
    },
  ],
});
```

## Module Services

Services allow you to inject dependencies and share logic across your module.

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

export const notificationModule = defineModule({
  name: 'notification',
  version: '1.0.0',

  services: [
    {
      name: 'emailService',
      implementation: EmailService,
      singleton: true,
    },
    {
      name: 'notificationService',
      implementation: NotificationService,
      dependencies: ['emailService', 'smsService'],
      singleton: true,
    },
  ],

  routes: [
    {
      method: 'POST',
      path: '/notify',
      handler: async (req, res) => {
        const notificationService = req.app.getContainer().resolve('notificationService');

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
        const config = req.app.getModuleConfig('analytics');

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
    rateLimit: {
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

const app = createApp({
  modules: {
    directory: './src/modules',
    autoLoad: true,
  },
});

// Modules are automatically discovered and loaded
await app.listen(3000);
```

### Manual Discovery

```typescript
import { autoDiscoverModuleDirectories } from '@morojs/moro';

const modules = await autoDiscoverModuleDirectories(process.cwd(), './src/modules');

for (const module of modules) {
  console.log(`Discovered module: ${module.name} v${module.version}`);
  await app.loadModule(module);
}
```

### Module Registry

```typescript
import { ModuleRegistry } from '@morojs/moro';

const registry = new ModuleRegistry();

// Register modules
registry.register(userModule);
registry.register(productModule);

// Check if module is loaded
if (registry.isLoaded('user', '1.0.0')) {
  console.log('User module is loaded');
}

// Get module
const module = registry.getModule('user', '1.0.0');
const latestUserModule = registry.getModule('user'); // Gets latest version

// Get all modules
const allModules = registry.getAllModules();

// Get only loaded modules
const loadedModules = registry.getLoadedModules();
```

## Module Dependencies

### Declaring Dependencies

```typescript
// Base module
export const databaseModule = defineModule({
  name: 'database',
  version: '1.0.0',

  services: [
    {
      name: 'database',
      implementation: DatabaseService,
      singleton: true,
    },
  ],
});

// Dependent module
export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  // Declare dependencies
  dependencies: ['database'],

  services: [
    {
      name: 'userService',
      implementation: UserService,
      dependencies: ['database'], // Service-level dependency
      singleton: true,
    },
  ],
});

// Load in correct order
await app.loadModule(databaseModule);
await app.loadModule(userModule); // Will have access to database service
```

### Cross-Module Services

```typescript
// Shared services module
export const sharedModule = defineModule({
  name: 'shared',
  version: '1.0.0',

  services: [
    {
      name: 'logger',
      implementation: LoggerService,
      singleton: true,
    },
    {
      name: 'cache',
      implementation: CacheService,
      singleton: true,
    },
  ],
});

// Feature modules can use shared services
export const orderModule = defineModule({
  name: 'order',
  version: '1.0.0',

  dependencies: ['shared'],

  services: [
    {
      name: 'orderService',
      implementation: OrderService,
      dependencies: ['logger', 'cache'],
      singleton: true,
    },
  ],
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

  services: [
    {
      name: 'moduleService',
      implementation: ModuleService,
      singleton: true,
    },
  ],
});

// Application setup
const app = createApp();

app.on('moduleLoaded', moduleName => {
  console.log(`Module ${moduleName} loaded`);

  // Initialize services
  if (moduleName === 'lifecycle') {
    const service = app.getContainer().resolve('moduleService');
    service.initialize();
  }
});

await app.loadModule(lifecycleModule);

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  const service = app.getContainer().resolve('moduleService');
  await service.cleanup();
  process.exit(0);
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

### 4. Lazy Load Heavy Modules

```typescript
const app = createApp();

// Load core modules immediately
await app.loadModule(coreModule);
await app.loadModule(authModule);

// Lazy load heavy modules
app.get('/admin/*', async (req, res, next) => {
  if (!app.isModuleLoaded('admin')) {
    const { adminModule } = await import('./modules/admin');
    await app.loadModule(adminModule);
  }
  next();
});
```

### 5. Test Modules in Isolation

```typescript
import { createApp } from '@morojs/moro';
import { userModule } from './modules/user';

describe('User Module', () => {
  let app;

  beforeEach(async () => {
    app = createApp();

    // Register mock services
    const container = app.getContainer();
    container.register('database', () => mockDatabase, true);

    // Load module
    await app.loadModule(userModule);
  });

  it('should list users', async () => {
    const response = await request(app).get('/users');
    expect(response.status).toBe(200);
  });
});
```

### 6. Module Configuration Validation

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

  services: [
    {
      name: 'database',
      implementation: DatabaseService,
      singleton: true,
    },
    {
      name: 'cache',
      implementation: CacheService,
      singleton: true,
    },
    {
      name: 'logger',
      implementation: LoggerService,
      singleton: true,
    },
  ],
});

// modules/user/index.ts
export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',
  dependencies: ['shared'],

  services: [
    {
      name: 'userService',
      implementation: UserService,
      dependencies: ['database', 'cache'],
      singleton: true,
    },
  ],

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

  services: [
    {
      name: 'productService',
      implementation: ProductService,
      dependencies: ['database', 'cache'],
      singleton: true,
    },
  ],

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

  services: [
    {
      name: 'orderService',
      implementation: OrderService,
      dependencies: ['database', 'userService', 'productService'],
      singleton: true,
    },
  ],

  routes: [
    { method: 'GET', path: '/orders', handler: listOrders },
    { method: 'POST', path: '/orders', handler: createOrder },
  ],
});

// app.ts
const app = createApp();

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
}
```

### App Methods

- `loadModule(module: ModuleConfig): Promise<void>` - Load a module
- `isModuleLoaded(name: string): boolean` - Check if module is loaded
- `getModuleConfig(name: string): any` - Get module configuration

## See Also

- [Dependency Injection Guide](./DEPENDENCY_INJECTION.md)
- [API Reference](./API.md)
- [Getting Started](./GETTING_STARTED.md)
