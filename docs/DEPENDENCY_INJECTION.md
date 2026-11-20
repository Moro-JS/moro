# Dependency Injection Guide

Comprehensive guide to MoroJS's built-in dependency injection container and service management system.

## Overview

MoroJS includes a sophisticated dependency injection (DI) system for managing services, dependencies, and application architecture. The DI container supports:

- **Automatic Type Safety** - No manual type annotations or interface extensions needed
- **Multiple Scopes** - Singleton, Transient, Request, and Module scopes
- **Lifecycle Hooks** - Initialize, dispose, and health check hooks
- **Advanced Features** - Interceptors, decorators, and fallback mechanisms

## Table of Contents

- [Type-Safe DI (Recommended)](#type-safe-di-recommended)
- [Basic Usage](#basic-usage)
- [Service Scopes](#service-scopes)
- [Service Registration](#service-registration)
- [Dependency Resolution](#dependency-resolution)
- [Module Services](#module-services)
- [Advanced Features](#advanced-features)
- [Best Practices](#best-practices)

## Type-Safe DI (Recommended)

The recommended approach is to use typed service references. This provides automatic type safety without any manual configuration.

### Pattern: Define, Register, Store Reference

```typescript
import { createApp } from '@morojs/moro';

// 1. Define your service interface
interface UserService {
  findById(id: string): Promise<{ id: string; name: string }>;
  create(data: { name: string }): Promise<{ id: string; name: string }>;
}

// 2. Register and store the typed reference
const app = await createApp();
const container = app.getContainer().getEnhanced();

const userServiceRef = container
  .register<UserService>('userService')
  .factory(() => {
    return {
      async findById(id: string) {
        // Implementation
        return { id, name: 'John Doe' };
      },
      async create(data: { name: string }) {
        // Implementation
        return { id: '123', name: data.name };
      },
    };
  })
  .singleton()
  .build();

// 3. Resolve anywhere with automatic type safety
const userService = await userServiceRef.resolve();

// TypeScript knows all methods and their signatures
const user = await userService.findById('123'); // ✓ Fully typed
console.log(user.name); // ✓ Fully typed

// userService.nonExistent(); // ✗ Compile error
```

### Why This Approach?

**Before (Not Type Safe):**

```typescript
// Had to manually specify type
container
  .register('authService')
  .factory(() => ({ signIn() {} }))
  .build();

const authService = await container.resolve('authService'); // unknown
authService.signIn; // Error - authService is unknown

// Workaround - manual type annotation
const authService = await container.resolve<AuthService>('authService');
```

**After (Automatic Type Safety):**

```typescript
// Type is captured automatically
const authServiceRef = container
  .register<AuthService>('authService')
  .factory(() => ({ signIn() {} }))
  .build();

const authService = await authServiceRef.resolve(); // AuthService
authService.signIn(); // ✓ Fully typed, no manual annotation needed
```

### Organizing Service References

For larger applications, organize your service references in a central location:

```typescript
// services.ts
import { createApp } from '@morojs/moro';

const app = await createApp();
const container = app.getContainer().getEnhanced();

// Define all service types
interface UserService {
  findById(id: string): Promise<User>;
  create(data: CreateUserDto): Promise<User>;
}

interface AuthService {
  signIn(username: string, password: string): Promise<{ token: string }>;
  signOut(): void;
}

interface EmailService {
  send(to: string, subject: string, body: string): Promise<void>;
}

// Register and export typed references
export const services = {
  user: container
    .register<UserService>('userService')
    .factory(() => new UserServiceImpl())
    .singleton()
    .build(),

  auth: container
    .register<AuthService>('authService')
    .factory(deps => {
      const userService = deps.userService as UserService;
      return new AuthServiceImpl(userService);
    })
    .dependsOn('userService')
    .singleton()
    .build(),

  email: container
    .register<EmailService>('emailService')
    .factory(() => new EmailServiceImpl())
    .singleton()
    .build(),
};

export { app };
```

Then use in routes:

```typescript
// routes/users.ts
import { services } from '../services';

app.get('/users/:id', async (req, res) => {
  const userService = await services.user.resolve();
  const user = await userService.findById(req.params.id);
  res.json(user);
});

app.post('/auth/signin', async (req, res) => {
  const authService = await services.auth.resolve();
  const result = await authService.signIn(req.body.username, req.body.password);
  res.json(result);
});
```

## Basic Usage

### Simple Service Registration

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();

// Access the DI container
const container = app.getContainer();

// Register a simple service
container.register(
  'logger',
  () => {
    return {
      log: (message: string) => console.log(message),
    };
  },
  true
); // true = singleton, which is also what you get without it

// Resolve and use the service
const logger = container.resolve('logger');
logger.log('Hello from DI!');
```

A service registered with `container.register(name, factory)` is a singleton: the factory runs once, on the first `resolve`, and every later `resolve` returns that instance, however many services the container holds. The optional third argument names the lifetime:

```typescript
// One instance for the app: the default, the same as `true` or { lifetime: 'singleton' }
container.register('settings', () => ({ startedAt: Date.now() }));

// A new instance on every resolve
container.register('requestId', () => crypto.randomUUID(), { lifetime: 'transient' });

container.resolve('settings') === container.resolve('settings'); // true
container.resolve('requestId') === container.resolve('requestId'); // false
```

The third argument may still be a boolean. `true` registers a singleton, and so does `false`: a boolean never makes a service transient, and the container logs one warning the first time it is given `false`. Write `{ lifetime: 'transient' }` when you want a new instance on every resolve.

### Class-Based Services

```typescript
class DatabaseService {
  constructor(private config: any) {
    this.config = config;
  }

  async query(sql: string) {
    // Database logic
    return [];
  }
}

// Register class as service
container.register(
  'database',
  () => {
    return new DatabaseService({ host: 'localhost', port: 5432 });
  },
  true
);

// Use in routes
app.get('/users', async (req, res) => {
  const db = container.resolve('database');
  const users = await db.query('SELECT * FROM users');
  res.json(users);
});
```

## Service Scopes

MoroJS supports four service scopes:

### 1. Singleton

One instance shared across the entire application.

```typescript
container
  .getEnhanced()
  .register('cache')
  .factory(() => new Map())
  .singleton()
  .build();
```

**Use case:** Shared resources like database connections, caches, configuration.

### 2. Transient

New instance created every time it's resolved, through the basic container (`container.resolve()`) or the enhanced one (`enhanced.resolve()`, `enhanced.resolveSync()` or a typed reference).

```typescript
container
  .getEnhanced()
  .register('requestId')
  .factory(() => crypto.randomUUID())
  .transient()
  .build();

// The same lifetime through the basic container
container.register('traceId', () => crypto.randomUUID(), { lifetime: 'transient' });
```

**Use case:** Request-specific data, unique identifiers, temporary objects.

**Transient is never the default.** A service registered without a lifetime (`container.register(name, factory)`, or a builder chain with no scope call) is a singleton. Ask for a transient service by name: `{ lifetime: 'transient' }` on the basic container, `.transient()` on the builder, or `enhanced.transient(name, factory)`.

### 3. Request Scope

One instance per `requestId` in the context you pass to `enhanced.resolve()`.

```typescript
container
  .getEnhanced()
  .register('requestContext')
  .factory((deps, context) => ({
    requestId: context?.requestId,
    timestamp: Date.now(),
  }))
  .requestScoped()
  .build();
```

**Use case:** Request-scoped services, user context, per-request state.

The container does not know about HTTP requests: the request id is the one you pass (see [Request Context](#request-context)).

- Resolved without a `requestId` (no context, or `container.resolve(name)`), a request-scoped service is one instance shared by every such caller. A warning is logged the first time this happens for a service.
- The instances of a request are kept until you call `enhanced.clearRequestScope(requestId)`. The framework does not call it when a response ends; scopes left behind are removed after 30 minutes without use.

### 4. Module Scope

One instance per `moduleId` in the context you pass to `enhanced.resolve()`.

```typescript
container
  .getEnhanced()
  .register('moduleCache')
  .factory(() => new Map())
  .moduleScoped()
  .build();

// Each module id gets its own instance
const userCache = await container.getEnhanced().resolve('moduleCache', {
  context: { moduleId: 'users', metadata: {}, timestamp: Date.now() },
});
```

**Use case:** Module-specific services, isolated state per module.

Resolved without a `moduleId`, a module-scoped service is one instance shared by every such caller.

## Service Registration

### Enhanced Container API

The enhanced container provides a fluent API for advanced service registration:

```typescript
const enhanced = container.getEnhanced();

enhanced
  .register('emailService')
  .factory(deps => {
    const mailer = deps.mailer;
    return {
      sendEmail: async (to: string, subject: string, body: string) => {
        await mailer.send({ to, subject, body });
      },
    };
  })
  .dependsOn('mailer')
  .singleton()
  .tags('email', 'messaging')
  .build();
```

### With Lifecycle Hooks

```typescript
const db = {
  connection: null,
  async connect() {
    // Connect to database
  },
  async disconnect() {
    // Close connection
  },
};

enhanced
  .register('databaseConnection')
  .factory(() => db)
  // Runs when the service is first created by `await enhanced.resolve(...)`
  .onInit(async () => {
    await db.connect();
  })
  // Runs from `await enhanced.dispose()`
  .onDispose(async () => {
    await db.disconnect();
  })
  // Reported by `await enhanced.healthCheck()`
  .healthCheck(async () => db.connection !== null)
  .singleton()
  .build();
```

When the hooks run:

- `onInit` runs when `await enhanced.resolve()` creates the instance. `resolveSync()` and `container.resolve()` create it without running the hook.
- `onDispose` runs from `await enhanced.dispose()`, for singleton services. It does not run for request- or module-scoped services: `dispose()`, `clearRequestScope()` and `clearModuleScope()` drop those instances without calling it.
- `app.close()` does not dispose the container. Call `enhanced.dispose()` yourself when shutting down (see [Lifecycle Management](#4-lifecycle-management)).
- After `dispose()`, resolving a service builds a new instance.

### With Timeout

Wrap the factory with `withTimeout()` to limit how long creation may take:

```typescript
import { withTimeout } from '@morojs/moro';

enhanced
  .register('externalApi')
  .factory(async () => {
    // Potentially slow initialization
    const response = await fetch('https://api.example.com/config');
    return await response.json();
  })
  .compose(withTimeout(5000)) // Fail creation after 5 seconds
  .fallback(() => ({ default: 'config' })) // Used when creation fails or times out
  .singleton()
  .build();

const config = await enhanced.resolve('externalApi');
```

`.compose()` wraps the factory set before it, so call it after `.factory()`. The fallback is used by `await enhanced.resolve()`; `resolveSync()` and `container.resolve()` do not use it.

The builder also has a `.timeout(ms)` method. It records the value in the service metadata and does not time anything: creation is not interrupted and the fallback is not triggered by it.

## Dependency Resolution

### Manual Resolution

```typescript
// Simple resolution
const service = container.resolve('serviceName');

// Check if service exists
if (container.has('serviceName')) {
  const service = container.resolve('serviceName');
}
```

### Automatic Dependency Injection

```typescript
// Register service A
enhanced
  .register('configService')
  .factory(() => ({
    apiUrl: process.env.API_URL || 'http://localhost:3000',
  }))
  .singleton()
  .build();

// Register service B that depends on A
enhanced
  .register('apiClient')
  .factory(deps => {
    const config = deps.configService; // Auto-injected
    return {
      async get(path: string) {
        return fetch(`${config.apiUrl}${path}`);
      },
    };
  })
  .dependsOn('configService')
  .singleton()
  .build();

// Use the service
const client = container.resolve('apiClient');
await client.get('/users');
```

### Optional Dependencies

```typescript
enhanced
  .register('notificationService')
  .factory(deps => {
    const email = deps.emailService; // Required
    const sms = deps.smsService; // Optional

    return {
      async notify(user: any, message: string) {
        await email.send(user.email, message);
        if (sms) {
          await sms.send(user.phone, message);
        }
      },
    };
  })
  .dependsOn('emailService')
  .optionalDependsOn('smsService')
  .singleton()
  .build();
```

## Module Services

Register a module's services on the app container and resolve them in its handlers:

```typescript
import { defineModule } from '@morojs/moro';

class UserService {
  constructor(private db: any) {}

  async findById(id: string) {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }

  async create(data: any) {
    return this.db.query('INSERT INTO users SET ?', [data]);
  }
}

// Module services with DI: one instance for the app (a singleton, the default lifetime)
const container = app.getContainer();
container.register('userService', () => new UserService(container.resolve('database')), true);

export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  routes: [
    {
      method: 'GET',
      path: '/users/:id',
      handler: async (req, res) => {
        const userService = container.resolve<UserService>('userService');
        const user = await userService.findById(req.params.id);
        res.json(user);
      },
    },
  ],
});

// Load module
await app.loadModule(userModule);
```

## Advanced Features

### Service Interceptors

Intercept service creation and add cross-cutting concerns. Two patterns are supported:

**Pattern 1: Factory Wrapping (Recommended)**

```typescript
enhanced
  .register('userService')
  .factory(() => new UserService())
  .interceptor((name, factory, deps, context) => {
    // Return a new factory that wraps the original
    return async () => {
      console.log(`Creating service: ${name}`);
      const startTime = Date.now();
      const service = await factory();
      console.log(`Service ${name} created in ${Date.now() - startTime}ms`);
      return service;
    };
  })
  .singleton()
  .build();
```

**Pattern 2: Middleware-Style with next() Callback**

```typescript
enhanced
  .register('userService')
  .factory(() => new UserService())
  .interceptor((name, deps, context, next) => {
    // Call next() to continue the chain
    console.log(`Before creating: ${name}`);
    const service = next();
    console.log(`After creating: ${name}`);
    return service;
  })
  .singleton()
  .build();
```

Both patterns allow you to:

- Log service creation
- Measure initialization time
- Add custom initialization logic
- Modify dependencies before creation

The container tells the two patterns apart by what an interceptor does, not by how its parameters are named, so renaming them (or a bundler doing so) changes nothing:

- an interceptor that calls its fourth argument, or returns anything other than a function, follows pattern 2;
- an interceptor that returns a function without calling its fourth argument follows pattern 1.

This is worked out the first time an interceptor runs, by calling it as pattern 2. A pattern 1 interceptor is then called again with its real arguments, so on that first run it is called twice (only its returned factory from the second call is used). Keep the work of a pattern 1 interceptor inside the factory it returns, as in the example above.

### Service Decorators

Wrap services with additional functionality:

```typescript
enhanced
  .register('apiService')
  .factory(() => ({
    getData: async () => {
      return { data: 'example' };
    },
  }))
  .decorator(async (service, context) => {
    // Wrap all methods with error handling
    return new Proxy(service, {
      get(target, prop) {
        const original = target[prop];
        if (typeof original === 'function') {
          return async (...args: any[]) => {
            try {
              return await original.apply(target, args);
            } catch (error) {
              console.error(`Error in ${String(prop)}:`, error);
              throw error;
            }
          };
        }
        return original;
      },
    });
  })
  .singleton()
  .build();
```

### Service Tags

Organize services with tags for batch resolution:

```typescript
// Register multiple services with tags
enhanced
  .register('postgresPlugin')
  .factory(() => new PostgresPlugin())
  .tags('plugin', 'database')
  .singleton()
  .build();

enhanced
  .register('redisPlugin')
  .factory(() => new RedisPlugin())
  .tags('plugin', 'cache')
  .singleton()
  .build();

// Resolve all services with specific tag
const plugins = await enhanced.resolveByTag('plugin');
for (const plugin of plugins) {
  await plugin.initialize();
}
```

### Async Service Initialization

```typescript
enhanced
  .register('database')
  .factory(async deps => {
    const config = deps.config;
    const connection = await createConnection(config.database);
    await connection.connect();
    return connection;
  })
  .dependsOn('config')
  .singleton()
  .build();

// Resolve with async support
const db = await enhanced.resolve('database');
```

Callers that resolve a singleton, request- or module-scoped service while it is still being created wait for that one creation: the factory runs once and they all receive the same instance. If the creation fails, they all receive the error, nothing is kept, and the next `resolve()` runs the factory again.

### Request Context

Pass context through the DI system:

```typescript
// Middleware to provide request context
app.use(async (req, res, next) => {
  const requestId = crypto.randomUUID();
  req.context = {
    requestId,
    metadata: { userId: req.user?.id },
    timestamp: Date.now(),
  };
  // Release this request's scoped instances once the response is out
  res.on('finish', () => enhanced.clearRequestScope(requestId));
  next();
});

// Register request-scoped service
enhanced
  .register('logger')
  .factory((deps, context) => ({
    log: (message: string) => {
      console.log(`[${context?.requestId}] ${message}`);
    },
  }))
  .requestScoped()
  .build();

// Use in route
app.get('/data', async (req, res) => {
  const logger = await enhanced.resolve('logger', {
    context: req.context,
  });
  logger.log('Fetching data');
  res.json({ data: 'example' });
});
```

## Best Practices

### 1. Use Singletons for Shared Resources

```typescript
// Good: Singleton for database connection (the default lifetime; `true` says it out loud)
container.register('database', () => createConnection(), true);

// Bad: Transient for database (a new connection on every resolve)
container.register('database', () => createConnection(), { lifetime: 'transient' });
```

### 2. Inject Dependencies, Don't Import

```typescript
// Good: Use dependency injection
class UserService {
  constructor(private db: DatabaseService) {}
}

// Bad: Direct import creates tight coupling
import { database } from './database';
class UserService {
  getData() {
    return database.query('...');
  }
}
```

### 3. Use Interfaces for Flexibility

```typescript
interface IEmailService {
  send(to: string, subject: string, body: string): Promise<void>;
}

class SmtpEmailService implements IEmailService {
  async send(to: string, subject: string, body: string) {
    // SMTP implementation
  }
}

class SendGridEmailService implements IEmailService {
  async send(to: string, subject: string, body: string) {
    // SendGrid implementation
  }
}

// Register based on environment
const emailService =
  process.env.NODE_ENV === 'production' ? new SendGridEmailService() : new SmtpEmailService();

container.register('emailService', () => emailService, true);
```

### 4. Lifecycle Management

```typescript
// Always provide cleanup for resources
const queue = new QueueConnection();

enhanced
  .register('queueConnection')
  .factory(() => queue)
  .onInit(async () => {
    await queue.connect();
  })
  .onDispose(async () => {
    await queue.disconnect();
  })
  .singleton()
  .build();

// Cleanup on app shutdown
process.on('SIGTERM', async () => {
  await container.getEnhanced().dispose();
  process.exit(0);
});
```

### 5. Testing with DI

```typescript
// Production service
class ProductionEmailService {
  async send(to: string, subject: string, body: string) {
    // Real email sending
  }
}

// Test service
class MockEmailService {
  emails: any[] = [];

  async send(to: string, subject: string, body: string) {
    this.emails.push({ to, subject, body });
  }
}

// In tests: registering a name again replaces the service, also after it was resolved
const container = app.getContainer();
container.register('emailService', () => new MockEmailService(), true);

// Test your code
const emailService = container.resolve('emailService');
await sendWelcomeEmail('user@example.com');
expect(emailService.emails).toHaveLength(1);
```

### 6. Avoid Circular Dependencies

Services that depend on each other through `dependsOn()` cannot be created. Resolving one of them fails with an error that names the cycle, for example `Circular dependency detected: serviceA -> serviceB -> serviceA`. A cycle that passes through `optionalDependsOn()` or through a service with a `fallback()` is not reported as an error; a warning naming it is logged instead.

```typescript
// Bad: Circular dependency
class ServiceA {
  constructor(private serviceB: ServiceB) {}
}

class ServiceB {
  constructor(private serviceA: ServiceA) {}
}

// Good: Use events or refactor
class ServiceA {
  constructor(private eventBus: EventBus) {}

  doSomething() {
    this.eventBus.emit('action', data);
  }
}

class ServiceB {
  constructor(private eventBus: EventBus) {
    this.eventBus.on('action', this.handleAction);
  }

  handleAction(data: any) {
    // Handle the action
  }
}
```

## Complete Example

Here's a complete example showing DI in a real application:

```typescript
import { createApp, defineModule } from '@morojs/moro';

// Services
class ConfigService {
  get(key: string): any {
    return process.env[key];
  }
}

class DatabaseService {
  constructor(private config: ConfigService) {}

  async query(sql: string, params: any[]) {
    const host = this.config.get('DB_HOST');
    // Database logic
    return [];
  }
}

class UserRepository {
  constructor(private db: DatabaseService) {}

  async findById(id: string) {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }

  async create(data: any) {
    return this.db.query('INSERT INTO users SET ?', [data]);
  }
}

class EmailService {
  async send(to: string, subject: string, body: string) {
    console.log(`Sending email to ${to}`);
  }
}

class UserService {
  constructor(
    private userRepo: UserRepository,
    private emailService: EmailService
  ) {}

  async register(email: string, password: string) {
    const user = await this.userRepo.create({ email, password });
    await this.emailService.send(email, 'Welcome!', 'Thanks for registering');
    return user;
  }
}

// Application setup
const app = await createApp();
const container = app.getContainer();
const enhanced = container.getEnhanced();

// Register services
enhanced
  .register('config')
  .factory(() => new ConfigService())
  .singleton()
  .build();

enhanced
  .register('database')
  .factory(deps => new DatabaseService(deps.config))
  .dependsOn('config')
  .singleton()
  .build();

enhanced
  .register('userRepository')
  .factory(deps => new UserRepository(deps.database))
  .dependsOn('database')
  .singleton()
  .build();

enhanced
  .register('emailService')
  .factory(() => new EmailService())
  .singleton()
  .build();

enhanced
  .register('userService')
  .factory(deps => new UserService(deps.userRepository, deps.emailService))
  .dependsOn('userRepository', 'emailService')
  .singleton()
  .build();

// Routes using DI
app.post('/register', async (req, res) => {
  const userService = container.resolve('userService');
  const user = await userService.register(req.body.email, req.body.password);
  res.json(user);
});

await app.listen(3000);
console.log('Server running with DI on port 3000');
```

## API Reference

### Container Methods

- `register<T>(name: string, factory: () => T, lifetime?: boolean | { lifetime?: 'singleton' | 'transient' }): void` - Register a service. It is a singleton (the factory runs once) unless `{ lifetime: 'transient' }` is passed; a boolean, `true` or `false`, registers a singleton. Registering a name again replaces it
- `resolve<T>(name: string): T` - Resolve a service synchronously: the one instance of a singleton, a new instance of a [transient](#2-transient) service
- `has(name: string): boolean` - Check if service exists
- `getEnhanced(): FunctionalContainer` - Get enhanced container

### Enhanced Container Methods

- `register<T>(name: string): ServiceRegistrationBuilder<T>` - Start fluent registration (a singleton unless the chain sets another scope)
- `singleton<T>(name: string, factory): TypedServiceReference<T>` / `transient<T>(name: string, factory): TypedServiceReference<T>` - Register with that scope in one call
- `resolve<T>(name: string, options?): Promise<T>` - Resolve service with options
- `resolveSync<T>(name: string, context?): T` - Synchronous resolution
- `resolveByTag(tag: string): Promise<any[]>` - Resolve all services with tag
- `clearRequestScope(requestId: string): void` - Drop a request's scoped instances (no `onDispose`)
- `healthCheck(): Promise<Record<string, boolean>>` - Run service health checks
- `dispose(): Promise<void>` - Run `onDispose` for singleton services and drop every stored instance

### ServiceRegistrationBuilder Methods

- `.factory(fn)` - Set factory function
- `.dependsOn(...deps)` - Required dependencies
- `.optionalDependsOn(...deps)` - Optional dependencies
- `.singleton()` - Singleton scope (the default)
- `.transient()` - Transient scope
- `.requestScoped()` / `.moduleScoped()` - Request or module scope
- `.tags(...tags)` - Add tags
- `.onInit(fn)` / `.onDispose(fn)` / `.healthCheck(fn)` - Add lifecycle hooks
- `.compose(...fns)` - Wrap the factory, e.g. `withTimeout(ms)`
- `.timeout(ms)` - Record a timeout in the service metadata (nothing is timed; use `withTimeout`)
- `.fallback(fn)` - Value used when creation fails in `await enhanced.resolve()`
- `.interceptor(fn)` - Add interceptor
- `.decorator(fn)` - Add decorator
- `.build()` - Build and register

## See Also

- [Module System Guide](./MODULES_GUIDE.md)
- [Testing Guide](./TESTING_GUIDE.md)
- [Best Practices](./PERFORMANCE_TIPS.md)
