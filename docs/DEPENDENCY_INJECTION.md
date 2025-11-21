# Dependency Injection Guide

Comprehensive guide to MoroJS's built-in dependency injection container and service management system.

## Overview

MoroJS includes a sophisticated dependency injection (DI) system for managing services, dependencies, and application architecture. The DI container supports multiple scopes, lifecycle hooks, interceptors, and advanced features like service decorators and fallback mechanisms.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Service Scopes](#service-scopes)
- [Service Registration](#service-registration)
- [Dependency Resolution](#dependency-resolution)
- [Module Services](#module-services)
- [Advanced Features](#advanced-features)
- [Best Practices](#best-practices)

## Basic Usage

### Simple Service Registration

```typescript
import { createApp } from 'moro';

const app = createApp();

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
); // true = singleton

// Resolve and use the service
const logger = container.resolve('logger');
logger.log('Hello from DI!');
```

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

New instance created every time it's requested.

```typescript
container
  .getEnhanced()
  .register('requestId')
  .factory(() => crypto.randomUUID())
  .transient()
  .build();
```

**Use case:** Request-specific data, unique identifiers, temporary objects.

### 3. Request Scope

One instance per HTTP request.

```typescript
container
  .getEnhanced()
  .register('requestContext')
  .factory((deps, context) => ({
    userId: context?.userId,
    timestamp: Date.now(),
  }))
  .scoped('request')
  .build();
```

**Use case:** Request-scoped services, user context, per-request state.

### 4. Module Scope

One instance per module.

```typescript
container
  .getEnhanced()
  .register('moduleCache')
  .factory(() => new Map())
  .scoped('module')
  .build();
```

**Use case:** Module-specific services, isolated state per module.

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
  .dependencies(['mailer'])
  .singleton()
  .tags(['email', 'messaging'])
  .build();
```

### With Lifecycle Hooks

```typescript
enhanced
  .register('databaseConnection')
  .factory(() => {
    return {
      connection: null,
      async connect() {
        // Connect to database
      },
      async disconnect() {
        // Close connection
      },
    };
  })
  .lifecycle({
    init: async () => {
      const db = container.resolve('databaseConnection');
      await db.connect();
    },
    dispose: async () => {
      const db = container.resolve('databaseConnection');
      await db.disconnect();
    },
    healthCheck: async () => {
      const db = container.resolve('databaseConnection');
      return db.connection !== null;
    },
  })
  .singleton()
  .build();
```

### With Timeout

```typescript
enhanced
  .register('externalApi')
  .factory(async () => {
    // Potentially slow initialization
    const response = await fetch('https://api.example.com/config');
    return await response.json();
  })
  .timeout(5000) // 5 second timeout
  .fallback(() => ({ default: 'config' })) // Fallback if timeout
  .singleton()
  .build();
```

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
  .dependencies(['configService'])
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
  .dependencies(['emailService'])
  .optional(['smsService'])
  .singleton()
  .build();
```

## Module Services

Services can be registered within modules for better organization:

```typescript
import { defineModule } from 'moro';

class UserService {
  constructor(private db: any) {}

  async findById(id: string) {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }

  async create(data: any) {
    return this.db.query('INSERT INTO users SET ?', [data]);
  }
}

export const userModule = defineModule({
  name: 'user',
  version: '1.0.0',

  // Module services with DI
  services: [
    {
      name: 'userService',
      implementation: UserService,
      dependencies: ['database'],
      singleton: true,
    },
  ],

  routes: [
    {
      method: 'GET',
      path: '/users/:id',
      handler: async (req, res) => {
        // Access container through req
        const userService = req.app.getContainer().resolve('userService');
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

Intercept service creation and add cross-cutting concerns:

```typescript
enhanced
  .register('userService')
  .factory(() => new UserService())
  .interceptor((name, factory, deps, context) => {
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
  .tags(['plugin', 'database'])
  .singleton()
  .build();

enhanced
  .register('redisPlugin')
  .factory(() => new RedisPlugin())
  .tags(['plugin', 'cache'])
  .singleton()
  .build();

// Resolve all services with specific tag
const plugins = enhanced.resolveByTag('plugin');
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
  .dependencies(['config'])
  .singleton()
  .build();

// Resolve with async support
const db = await enhanced.resolve('database');
```

### Request Context

Pass context through the DI system:

```typescript
// Middleware to provide request context
app.use(async (req, res, next) => {
  req.context = {
    requestId: crypto.randomUUID(),
    userId: req.user?.id,
    startTime: Date.now(),
  };
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
  .scoped('request')
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
// Good: Singleton for database connection
container.register('database', () => createConnection(), true);

// Bad: Transient for database (creates many connections)
container.register('database', () => createConnection(), false);
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
enhanced
  .register('queueConnection')
  .factory(() => new QueueConnection())
  .lifecycle({
    init: async () => {
      const queue = container.resolve('queueConnection');
      await queue.connect();
    },
    dispose: async () => {
      const queue = container.resolve('queueConnection');
      await queue.disconnect();
    },
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

// In tests
const container = app.getContainer();
container.register('emailService', () => new MockEmailService(), true);

// Test your code
const emailService = container.resolve('emailService');
await sendWelcomeEmail('user@example.com');
expect(emailService.emails).toHaveLength(1);
```

### 6. Avoid Circular Dependencies

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
import { createApp, defineModule } from 'moro';

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
const app = createApp();
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
  .dependencies(['config'])
  .singleton()
  .build();

enhanced
  .register('userRepository')
  .factory(deps => new UserRepository(deps.database))
  .dependencies(['database'])
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
  .dependencies(['userRepository', 'emailService'])
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

- `register<T>(name: string, factory: () => T, singleton?: boolean): void` - Register a service
- `resolve<T>(name: string): T` - Resolve a service
- `has(name: string): boolean` - Check if service exists
- `getEnhanced(): FunctionalContainer` - Get enhanced container

### Enhanced Container Methods

- `register<T>(name: string): ServiceRegistrationBuilder<T>` - Start fluent registration
- `resolve<T>(name: string, options?): Promise<T>` - Resolve service with options
- `resolveSync<T>(name: string, context?): T` - Synchronous resolution
- `resolveByTag(tag: string): any[]` - Resolve all services with tag
- `dispose(): Promise<void>` - Dispose all services

### ServiceRegistrationBuilder Methods

- `.factory(fn)` - Set factory function
- `.dependencies(deps[])` - Required dependencies
- `.optional(deps[])` - Optional dependencies
- `.singleton()` - Singleton scope
- `.transient()` - Transient scope
- `.scoped(scope)` - Custom scope
- `.tags(tags[])` - Add tags
- `.lifecycle(hooks)` - Add lifecycle hooks
- `.timeout(ms)` - Set timeout
- `.fallback(fn)` - Set fallback
- `.interceptor(fn)` - Add interceptor
- `.decorator(fn)` - Add decorator
- `.build()` - Build and register

## See Also

- [Module System Guide](./MODULES_GUIDE.md)
- [Testing Guide](./TESTING_GUIDE.md)
- [Best Practices](./PERFORMANCE_TIPS.md)
