# MoroJS AI Assistant Guide (v1.0.0)

**For AI assistants helping developers build with MoroJS**

This guide provides the essential knowledge and best practices for rapidly building applications with MoroJS. Focus on these patterns - they represent the **optimal way** to use the framework.

## Core Philosophy

MoroJS eliminates Express.js pain points through:

- **Intelligent routing with automatic middleware ordering**
- **Multi-runtime deployment** (same code everywhere)
- **Universal validation** (any validation library with full TypeScript inference)
- **Chainable API** (the preferred approach)

## Essential Building Blocks

### 1. Application Creation

**Best Practice: Use runtime-specific creators with essential API middleware**

```typescript
// Node.js (traditional server) - Recommended for APIs
import { createApp } from '@morojs/moro';

const app = await createApp({
  // Essential API middleware - always enable these
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  },
  compression: true, // Reduce bandwidth usage
  helmet: true, // Security headers

  // API-specific optimizations
  performance: {
    compression: { enabled: true },
    clustering: { enabled: true, workers: 'auto' },
  },

  logging: {
    level: 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  },
});

// Vercel Edge Functions
import { createAppEdge } from '@morojs/moro';
const app = await createAppEdge({
  cors: { origin: '*', credentials: false }, // Edge-appropriate CORS
  compression: true,
});
export default app.getHandler();

// AWS Lambda
import { createAppLambda } from '@morojs/moro';
const app = await createAppLambda({
  cors: { origin: '*' },
  compression: true,
});
export const handler = app.getHandler();

// Cloudflare Workers
import { createAppWorker } from '@morojs/moro';
const app = await createAppWorker({
  cors: { origin: '*' },
  compression: true,
});
export default { fetch: app.getHandler() };
```

### 2. Route Definition (Chainable API - Preferred)

**This is the BEST way to define routes in MoroJS:**

```typescript
import { z } from '@morojs/moro';

// Simple route
app.get('/health', () => ({ status: 'healthy' }));

// Complex route with full pipeline
app
  .post('/users')
  .body(
    z.object({
      name: z.string().min(2).max(50),
      email: z.string().email(),
      age: z.number().min(18).optional(),
    })
  )
  .auth({ roles: ['admin'] })
  .rateLimit({ requests: 10, window: 60000 })
  .cache({ ttl: 300 })
  .describe('Create a new user')
  .handler(async (req, res) => {
    // req.body is fully typed and validated
    const user = await createUser(req.body);
    return { success: true, data: user };
  });

// All HTTP methods support chaining
app
  .get('/users/:id')
  .params(z.object({ id: z.string().uuid() }))
  .auth({ optional: true })
  .handler(getUserById);

app
  .put('/users/:id')
  .params(z.object({ id: z.string().uuid() }))
  .body(UserUpdateSchema)
  .auth({ roles: ['user'] })
  .handler(updateUser);

app
  .delete('/users/:id')
  .params(z.object({ id: z.string().uuid() }))
  .auth({ roles: ['admin'] })
  .handler(deleteUser);
```

### 3. Validation with Zod

**Always use Zod for API validation - it has native MoroJS support and excellent TypeScript inference:**

```typescript
import { z } from '@morojs/moro';

const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).optional(),
  role: z.enum(['user', 'admin']).default('user'),
});

const UserParamsSchema = z.object({
  id: z.string().uuid(),
});

const UserQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(10),
  offset: z.coerce.number().min(0).default(0),
  search: z.string().optional(),
});

app
  .post('/users')
  .body(UserSchema)
  .handler((req, res) => {
    // req.body is fully typed: { name: string; email: string; age?: number; role: "user" | "admin" }
  });

app
  .get('/users/:id')
  .params(UserParamsSchema)
  .query(UserQuerySchema)
  .handler((req, res) => {
    // req.params.id is string (UUID validated)
    // req.query.limit is number (coerced and validated)
  });
```

### 4. Authentication (Auth.js Integration)

**Setup:**

```typescript
import { auth, providers } from '@morojs/moro';

app.use(
  auth({
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
  })
);
```

**Usage in Routes:**

```typescript
// Require authentication
app
  .get('/profile')
  .auth()
  .handler((req, res) => {
    return { user: req.user };
  });

// Role-based access
app
  .get('/admin')
  .auth({ roles: ['admin'] })
  .handler(adminHandler);

// Permission-based access
app
  .get('/sensitive')
  .auth({ permissions: ['read:sensitive'] })
  .handler(sensitiveHandler);

// Optional authentication
app
  .get('/public')
  .auth({ optional: true })
  .handler((req, res) => {
    const message = req.user ? `Hello ${req.user.name}` : 'Hello guest';
    return { message };
  });
```

### 5. Middleware Chaining

**The framework automatically orders middleware optimally. Just chain what you need:**

```typescript
app
  .post('/api/orders')
  .before(customLoggingMiddleware)
  .body(OrderSchema)
  .auth({ roles: ['user'] })
  .rateLimit({ requests: 5, window: 60000 })
  .cache({ ttl: 60, key: 'user-orders' })
  .after(analyticsMiddleware)
  .handler(createOrder);
```

**Execution order is always optimal:**

1. Security (CORS, Helmet) - framework managed
2. Parsing (body/query) - framework managed
3. Rate limiting
4. Before middleware (your custom middleware)
5. Authentication
6. Validation
7. Transform middleware
8. Caching
9. After middleware (your custom middleware)
10. Handler

### 6. Error Handling

**Automatic validation errors:**

```typescript
app.post('/users').body(UserSchema).handler(handler);
// Invalid requests automatically return 400 with detailed validation errors
```

**Custom error handling:**

```typescript
app.post('/users').handler(async (req, res) => {
  try {
    const user = await createUser(req.body);
    return { success: true, data: user };
  } catch (error) {
    // Framework automatically handles uncaught errors
    throw error; // Returns 500 with error details
  }
});
```

### 7. Response Patterns

**Automatic JSON responses:**

```typescript
app.get('/users', () => {
  return { users: getAllUsers() }; // Automatically JSON response
});

// Async handlers
app.get('/users/:id', async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user) {
    res.status(404);
    return { error: 'User not found' };
  }
  return { user };
});

// Manual response control
app.get('/download', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(fileBuffer);
  // Don't return anything when manually controlling response
});
```

### 8. Configuration

**Best Practice: Use moro.config.ts for API-optimized defaults**

```typescript
// moro.config.ts - Production-ready API configuration
export default {
  server: {
    port: process.env.PORT || 3000,
    host: '0.0.0.0', // Accept external connections
    maxConnections: 1000,
    timeout: 30000,
    bodySizeLimit: '10mb',
  },

  // Essential API security
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      credentials: true,
    },
    helmet: { enabled: true },
    rateLimit: {
      global: {
        enabled: true,
        requests: 1000, // 1000 requests per minute globally
        window: 60000,
      },
    },
  },

  // API performance optimizations
  performance: {
    compression: { enabled: true, level: 6 },
    clustering: { enabled: true, workers: 'auto' },
    circuitBreaker: { enabled: true },
  },

  // Structured logging for APIs
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
    enableTimestamp: true,
    enableContext: true,
  },

  database: {
    url: process.env.DATABASE_URL,
  },
};
```

**Minimal createApp setup (config file handles the rest):**

```typescript
const app = await createApp(); // Uses moro.config.ts defaults
```

### 9. Database Integration

**Connection:**

```typescript
import { MySQLAdapter } from '@morojs/moro';

const db = new MySQLAdapter({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'myapp',
});

app.database(db);
```

**Usage in handlers:**

```typescript
app.get('/users').handler(async (req, res) => {
  const users = await req.database.query('SELECT * FROM users');
  return { users };
});
```

### 10. WebSocket Support

**Setup:**

```typescript
const app = await createApp({
  websocket: { enabled: true }, // Auto-detects Socket.IO or ws
});

app.websocket('/chat', {
  connect: socket => {
    console.log(`Client connected: ${socket.id}`);
    socket.join('general');
  },

  message: (socket, data) => {
    socket.to('general').emit('message', {
      user: socket.user,
      text: data.text,
      timestamp: new Date(),
    });
  },

  disconnect: socket => {
    console.log(`Client disconnected: ${socket.id}`);
  },
});
```

### 11. Module System

**Best Practice: Functional modules**

```typescript
// modules/users/index.ts
import { defineModule, z } from '@morojs/moro';

export default defineModule({
  name: 'users',
  version: '1',
  routes: [
    {
      method: 'GET',
      path: '/',
      validation: {
        query: z.object({
          limit: z.coerce.number().default(10),
        }),
      },
      handler: async (req, res) => {
        const users = await getUsers(req.query);
        return { users };
      },
    },
  ],
});

// Load module
await app.loadModule('./modules/users');
// Creates routes at /api/v1/users/
```

### 12. Documentation

**Automatic API docs:**

```typescript
app.enableDocs({
  title: 'My API',
  version: '1.0.0',
  description: 'API for my application',
  basePath: '/docs',
});

// Now chainable routes automatically generate OpenAPI docs
app.get('/users').describe('Get all users').tag('Users').handler(getUsers);
```

## Development Patterns

### Project Structure

```
src/
├── app.ts              # Main application
├── config/
│   └── index.ts        # Configuration
├── modules/            # Feature modules
│   ├── users/
│   ├── orders/
│   └── auth/
├── middleware/         # Custom middleware
├── schemas/           # Validation schemas
└── types/             # TypeScript types
```

### Handler Patterns

```typescript
// Simple handler
const getUser = (req, res) => ({ user: findUser(req.params.id) });

// Async handler
const createUser = async (req, res) => {
  const user = await saveUser(req.body);
  return { user };
};

// Error handling
const updateUser = async (req, res) => {
  const user = await findUser(req.params.id);
  if (!user) {
    res.status(404);
    return { error: 'User not found' };
  }

  const updated = await updateUser(user.id, req.body);
  return { user: updated };
};
```

### Schema Organization

```typescript
// schemas/user.ts
import { z } from '@morojs/moro';

export const CreateUserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).optional(),
});

export const UpdateUserSchema = CreateUserSchema.partial();

export const UserParamsSchema = z.object({
  id: z.string().uuid(),
});
```

## Key Principles for AI Assistants

1. **Always use chainable API** - it's the best way to build routes
2. **Always use Zod** - for validation with perfect TypeScript inference
3. **Always enable CORS, compression, and helmet** - essential for APIs
4. **Order doesn't matter** - the framework optimizes middleware execution
5. **Return data directly** - the framework handles JSON serialization
6. **Runtime-agnostic** - same code works everywhere
7. **Config-driven setup** - use moro.config.ts for production-ready defaults
8. **Type safety everywhere** - leverage TypeScript inference
9. **Rate limiting by default** - protect APIs from abuse
10. **Structured logging** - use JSON format in production

## Performance Best Practices

1. **Enable clustering** for Node.js production
2. **Use caching** for expensive operations
3. **Implement rate limiting** for public APIs
4. **Enable compression** for better bandwidth usage
5. **Use fast-path routes** (no middleware) when possible

## Security Best Practices

1. **Always validate input** using schemas
2. **Use Auth.js** for authentication
3. **Implement RBAC** for authorization
4. **Enable CORS** appropriately
5. **Use CSRF protection** for web apps
6. **Set security headers** with Helmet

This guide provides everything needed to build production-ready applications with MoroJS efficiently.
