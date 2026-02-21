# MoroJS API Reference

Complete API documentation for the MoroJS framework.

## Table of Contents

- [Core API](#core-api)
- [Runtime System](#runtime-system)
- [Application Class](#application-class)
- [Intelligent Routing](#intelligent-routing)
- [Module System](#module-system)
- [Validation System](#validation-system)
- [Middleware](#middleware)
- [Database Integration](#database-integration)
- [Message Queues](#message-queues)
- [gRPC Support](#grpc-support)
- [WebSocket Support](#websocket-support)
- [Configuration](#configuration)
- [Events](#events)
- [Worker Threads](#worker-threads)
- [Performance](#performance)
- [Error Handling](#error-handling)

---

## Core API

### createApp(options?)

Creates a new MoroJS application instance.

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  cors: true,
  compression: true,
  helmet: true,
  autoDiscover: true,
  modulesPath: './modules',
});
```

**Options:**

- `cors` (boolean | object): Enable CORS middleware
- `compression` (boolean | object): Enable compression middleware
- `helmet` (boolean | object): Enable security headers
- `autoDiscover` (boolean): Auto-discover modules in modulesPath
- `modulesPath` (string): Path to modules directory
- `runtime` (RuntimeConfig): Runtime configuration for multi-environment deployment

**Returns:** `Moro` - Application instance

---

## Runtime System

MoroJS supports multiple runtime environments with the same API. Choose the appropriate function for your deployment target.

### createApp(options?)

Creates a Node.js application (default runtime).

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp();
app.listen(3000); // Traditional HTTP server
```

### createAppEdge(options?)

Creates a Vercel Edge Functions application.

```typescript
import { createAppEdge } from '@morojs/moro';

const app = await createAppEdge();

app.get('/api/hello', (req, res) => {
  return { message: 'Hello from the Edge!' };
});

export default app.getHandler(); // Export for Vercel
```

### createAppLambda(options?)

Creates an AWS Lambda application.

```typescript
import { createAppLambda } from '@morojs/moro';

const app = await createAppLambda();

app.get('/api/users/:id', (req, res) => {
  return { userId: req.params.id, lambda: true };
});

export const handler = app.getHandler(); // Export for Lambda
```

### createAppWorker(options?)

Creates a Cloudflare Workers application.

```typescript
import { createAppWorker } from '@morojs/moro';

const app = await createAppWorker();

app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['cf-ipcountry'],
    ray: req.headers['cf-ray'],
  };
});

export default {
  async fetch(request, env, ctx) {
    return app.getHandler()(request, env, ctx);
  },
};
```

### Runtime Configuration

You can also specify runtime configuration explicitly:

```typescript
import { createApp } from '@morojs/moro';

const app = await createApp({
  runtime: {
    type: 'vercel-edge', // 'node' | 'vercel-edge' | 'aws-lambda' | 'cloudflare-workers'
    options: {
      // Runtime-specific options
    },
  },
});
```

### Runtime Methods

#### app.getRuntimeType()

Returns the current runtime type.

```typescript
const app = await createAppEdge();
console.log(app.getRuntimeType()); // 'vercel-edge'
```

#### app.getRuntime()

Returns the runtime adapter instance.

```typescript
const app = await createAppLambda();
const adapter = app.getRuntime();
console.log(adapter.type); // 'aws-lambda'
```

#### app.getHandler()

Returns a runtime-specific handler function. Only available for non-Node.js runtimes.

```typescript
const app = await createAppEdge();
const handler = app.getHandler(); // Function for Vercel Edge

const nodeApp = await createApp();
// nodeApp.getHandler() // Available but use listen() instead
```

#### app.listen(port, [host], [callback])

Starts the HTTP server. Only available for Node.js runtime.

```typescript
const app = await createApp();
app.listen(3000, () => {
  console.log('Server running on port 3000');
});

const edgeApp = await createAppEdge();
// edgeApp.listen(3000); // Throws error - use getHandler() instead
```

### Runtime-Specific Features

#### Node.js Runtime

- Full HTTP server capabilities
- WebSocket support
- File system access
- Process management
- Traditional `listen()` method

#### Vercel Edge Runtime

- Web API Request/Response objects
- Global edge deployment
- Fast cold starts
- Streaming responses
- Geographic routing

#### AWS Lambda Runtime

- Event/Context handling
- Auto-scaling
- Pay-per-request pricing
- VPC integration
- Event-driven architecture

#### Cloudflare Workers Runtime

- Global edge network
- KV storage integration
- Durable Objects support
- Environment variables access
- Instant deployment

---

## Application Class

### HTTP Methods

#### app.get(path, handler?, options?)

Register a GET route.

```typescript
// Chainable API (Recommended)
app
  .get('/users')
  .query(z.object({ limit: z.coerce.number().default(10) }))
  .cache({ ttl: 60 })
  .handler(async (req, res) => {
    return { users: await getUsers(req.query) };
  });

// Direct API
app.get(
  '/users',
  async (req, res) => {
    return { users: await getUsers() };
  },
  { cache: { ttl: 60 } }
);
```

#### app.post(path, handler?, options?)

#### app.put(path, handler?, options?)

#### app.delete(path, handler?, options?)

#### app.patch(path, handler?, options?)

Same pattern as `get()` but for different HTTP methods.

### Schema-First Routes

#### app.route(schema)

Define a route using a schema-first approach.

```typescript
app.route({
  method: 'POST',
  path: '/users',
  validation: {
    body: z.object({
      name: z.string().min(2).max(50),
      email: z.string().email(),
    }),
    query: z.object({
      notify: z.coerce.boolean().default(true),
    }),
  },
  rateLimit: { requests: 10, window: 60000 },
  cache: { ttl: 300 },
  description: 'Create a new user',
  tags: ['users', 'create'],
  handler: async (req, res) => {
    const user = await createUser(req.body);
    return { success: true, data: user };
  },
});
```

**Schema Properties:**

- `method` (HttpMethod): HTTP method
- `path` (string): Route path
- `validation` (ValidationConfig): Request validation
- `rateLimit` (RateLimitConfig): Rate limiting config
- `cache` (CacheConfig): Caching config
- `auth` (AuthConfig): Authentication config
- `middleware` (Middleware[]): Custom middleware
- `description` (string): Route description for docs
- `tags` (string[]): Tags for documentation
- `handler` (RouteHandler): Route handler function

### Module Management

#### app.loadModule(module)

Load a module into the application.

```typescript
import UsersModule from './modules/users';

await app.loadModule(UsersModule);

// Or load from path
await app.loadModule('./modules/users');
```

### Database Integration

#### app.database(adapter)

Register a database adapter.

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

### WebSocket Support

#### app.websocket(namespace, handlers)

Register WebSocket handlers.

```typescript
app.websocket('/chat', {
  message: (socket, data) => {
    socket.broadcast.emit('message', data);
    return { success: true };
  },
  join: {
    validation: z.object({ room: z.string() }),
    handler: (socket, data) => {
      socket.join(data.room);
      return { joined: data.room };
    },
  },
});
```

### Middleware

#### app.use(middleware, config?)

Add global middleware.

```typescript
// Standard middleware
app.use((req, res, next) => {
  req.timestamp = Date.now();
  next();
});

// Async middleware
app.use(async (req, res, next) => {
  req.user = await authenticateUser(req);
  next();
});

// Function-style middleware
app.use(async app => {
  app.addGlobalValidator(customValidator);
});
```

### Server

#### app.listen(port, callback?)

#### app.listen(port, host, callback?)

Start the HTTP server.

```typescript
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server running on all interfaces');
});
```

### Documentation

#### app.enableDocs(config)

Enable automatic API documentation.

```typescript
app.enableDocs({
  basePath: '/docs',
  title: 'My API',
  version: '1.0.0',
  description: 'API documentation',
  contact: {
    name: 'API Support',
    email: 'support@example.com',
  },
});
```

#### app.getOpenAPISpec()

Get the OpenAPI specification.

```typescript
const spec = app.getOpenAPISpec();
```

#### app.getDocsJSON()

Get documentation as JSON string.

#### app.getDocsYAML()

Get documentation as YAML string.

---

## Intelligent Routing

### RouteBuilder

The RouteBuilder provides a chainable API for defining routes with automatic middleware ordering.

#### Execution Phases

MoroJS automatically orders middleware execution in these phases:

1. **SECURITY** - CORS, Helmet, CSRF protection
2. **PARSING** - Body parsing, query parsing
3. **RATE_LIMITING** - Request rate limiting
4. **AUTHENTICATION** - User authentication and authorization
5. **VALIDATION** - Request validation with Zod
6. **CACHING** - Response caching logic
7. **HANDLER** - Route handler execution

#### Validation Methods

```typescript
app
  .post('/users')
  // Body validation
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  // Query parameter validation
  .query(
    z.object({
      notify: z.coerce.boolean().default(true),
    })
  )
  // Path parameter validation
  .params(
    z.object({
      id: z.string().uuid(),
    })
  )
  // Header validation
  .headers(
    z.object({
      'x-api-key': z.string(),
    })
  )
  // Combined validation
  .validate({
    body: UserSchema,
    query: QuerySchema,
    params: ParamsSchema,
  });
```

#### Security Methods

```typescript
app
  .get('/admin')
  // Authentication
  .auth({
    required: true,
    roles: ['admin'],
    permissions: ['users:read'],
  })
  // Rate limiting
  .rateLimit({
    requests: 100,
    window: 60000, // 1 minute
    skipSuccessfulRequests: false,
    skipFailedRequests: true,
  });
```

#### Caching

```typescript
app.get('/data').cache({
  ttl: 300, // 5 minutes
  strategy: 'memory', // 'memory' | 'redis' | 'file'
  key: req => `data:${req.query.id}`,
  tags: ['data', 'public'],
});
```

#### Custom Middleware

```typescript
app
  .get('/custom')
  // Before handler middleware
  .before(logRequest, validateApiKey, enrichRequest)
  // After handler middleware
  .after(logResponse, cleanupResources);
```

#### Handler

```typescript
app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    // req.body is fully typed and validated
    const user = await createUser(req.body);
    return { success: true, data: user };
  });
```

### Intelligent Routing Examples

#### Complex Route with Full Middleware Chain

```typescript
app
  .post('/api/orders')
  .body(
    z.object({
      userId: z.string().uuid(),
      items: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().min(1),
            price: z.number().positive(),
          })
        )
        .min(1),
      shippingAddress: z.object({
        street: z.string().min(1),
        city: z.string().min(1),
        zipCode: z.string().regex(/^\d{5}$/),
      }),
    })
  )
  .auth({
    required: true,
    roles: ['customer'],
    permissions: ['orders:create'],
  })
  .rateLimit({
    requests: 5,
    window: 60000,
    keyGenerator: req => `orders:${req.user.id}`,
  })
  .cache({
    ttl: 0, // No caching for orders
    strategy: 'none',
  })
  .before(validateInventory, calculateTotals, checkPaymentMethod)
  .after(sendOrderConfirmation, updateInventory, triggerFulfillment)
  .describe('Create a new order with full validation and processing')
  .tag('orders', 'create', 'ecommerce')
  .handler(async (req, res) => {
    const order = await createOrder({
      ...req.body,
      userId: req.user.id,
      status: 'pending',
      createdAt: new Date(),
    });

    req.events.emit('order:created', {
      order,
      user: req.user,
      timestamp: new Date(),
    });

    return {
      success: true,
      data: order,
      message: 'Order created successfully',
    };
  });
```

#### Schema-First Approach

```typescript
app.route({
  method: 'GET',
  path: '/api/users/:id/orders',
  validation: {
    params: z.object({
      id: z.string().uuid('Invalid user ID format'),
    }),
    query: z.object({
      status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']).optional(),
      limit: z.coerce.number().min(1).max(100).default(20),
      offset: z.coerce.number().min(0).default(0),
      sortBy: z.enum(['createdAt', 'total', 'status']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    }),
  },
  auth: {
    required: true,
    validator: req => {
      // Users can only see their own orders, admins can see any
      return req.user.id === req.params.id || req.user.roles.includes('admin');
    },
  },
  cache: {
    ttl: 60, // 1 minute cache
    key: req => `user-orders:${req.params.id}:${JSON.stringify(req.query)}`,
    tags: ['user-data', 'orders'],
  },
  rateLimit: {
    requests: 100,
    window: 60000,
  },
  description: 'Get paginated orders for a specific user',
  tags: ['users', 'orders', 'pagination'],
  handler: async (req, res) => {
    const orders = await getUserOrders(req.params.id, {
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
    });

    const total = await getUserOrdersCount(req.params.id, {
      status: req.query.status,
    });

    return {
      success: true,
      data: orders,
      pagination: {
        limit: req.query.limit,
        offset: req.query.offset,
        total,
        hasMore: req.query.offset + req.query.limit < total,
      },
    };
  },
});
```

---

## Module System

### defineModule(definition)

Create a module definition.

```typescript
import { defineModule, z } from '@morojs/moro';

export default defineModule({
  name: 'users',
  version: '1.0.0',
  dependencies: ['auth@1.0.0'],
  config: {
    database: { table: 'users' },
    features: { pagination: true },
  },
  routes: [
    {
      method: 'GET',
      path: '/users',
      validation: {
        query: z.object({
          limit: z.coerce.number().min(1).max(100).default(10),
          search: z.string().optional(),
        }),
      },
      cache: { ttl: 60 },
      description: 'Get users with pagination',
      tags: ['users', 'list'],
      handler: async (req, res) => {
        return { users: await getUsers(req.query) };
      },
    },
  ],
  sockets: [
    {
      event: 'user-status',
      validation: z.object({
        userId: z.string().uuid(),
        status: z.enum(['online', 'offline']),
      }),
      handler: async (socket, data) => {
        socket.broadcast.emit('user-status-changed', data);
        return { success: true };
      },
    },
  ],
});
```

**Module Definition Properties:**

- `name` (string): Module name
- `version` (string): Module version
- `dependencies` (string[]): Module dependencies
- `config` (object): Module configuration
- `routes` (ModuleRoute[]): HTTP routes
- `sockets` (ModuleSocket[]): WebSocket handlers

### ModuleRoute

```typescript
interface ModuleRoute {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  validation?: ValidationConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  auth?: AuthConfig;
  middleware?: Middleware[];
  description?: string;
  tags?: string[];
}
```

### ModuleSocket

```typescript
interface ModuleSocket {
  event: string;
  handler: SocketHandler;
  validation?: ZodSchema;
  rateLimit?: RateLimitConfig;
  rooms?: string[];
  broadcast?: boolean;
}
```

### Enterprise Module Example

```typescript
// modules/orders/index.ts
import { defineModule, z } from '@morojs/moro';
import {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  cancelOrder,
} from './services/OrderService';

const OrderSchema = z.object({
  userId: z.string().uuid(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().min(1),
        price: z.number().positive(),
      })
    )
    .min(1),
  shippingAddress: z.object({
    street: z.string().min(1),
    city: z.string().min(1),
    zipCode: z.string().regex(/^\d{5}$/),
  }),
  paymentMethodId: z.string().uuid(),
});

const OrderUpdateSchema = z.object({
  status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']),
  trackingNumber: z.string().optional(),
  estimatedDelivery: z.string().datetime().optional(),
});

export default defineModule({
  name: 'orders',
  version: '2.1.0',
  dependencies: ['users@1.0.0', 'payments@1.5.0', 'inventory@2.0.0'],
  config: {
    database: {
      table: 'orders',
      indexes: ['userId', 'status', 'createdAt'],
    },
    features: {
      realTimeTracking: true,
      automaticInventoryUpdate: true,
      emailNotifications: true,
    },
    limits: {
      maxItemsPerOrder: 50,
      maxOrdersPerUser: 10,
    },
  },
  routes: [
    // Create Order
    {
      method: 'POST',
      path: '/orders',
      validation: { body: OrderSchema },
      auth: {
        required: true,
        roles: ['customer'],
      },
      rateLimit: {
        requests: 5,
        window: 60000,
        keyGenerator: req => `orders:create:${req.user.id}`,
      },
      description: 'Create a new order',
      tags: ['orders', 'create'],
      handler: async (req, res) => {
        const order = await createOrder({
          ...req.body,
          userId: req.user.id,
        });

        // Emit module-scoped event
        req.events.emit('order:created', {
          order,
          user: req.user,
        });

        return {
          success: true,
          data: order,
          message: 'Order created successfully',
        };
      },
    },

    // Get Orders
    {
      method: 'GET',
      path: '/orders',
      validation: {
        query: z.object({
          status: z.enum(['pending', 'processing', 'shipped', 'delivered', 'cancelled']).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          sortBy: z.enum(['createdAt', 'total', 'status']).default('createdAt'),
          sortOrder: z.enum(['asc', 'desc']).default('desc'),
        }),
      },
      auth: { required: true },
      cache: {
        ttl: 60,
        key: req => `orders:list:${req.user.id}:${JSON.stringify(req.query)}`,
      },
      description: 'Get user orders with pagination',
      tags: ['orders', 'list'],
      handler: async (req, res) => {
        const orders = await getOrders(req.user.id, req.query);
        return { success: true, data: orders };
      },
    },

    // Get Order by ID
    {
      method: 'GET',
      path: '/orders/:id',
      validation: {
        params: z.object({
          id: z.string().uuid(),
        }),
      },
      auth: {
        required: true,
        validator: async req => {
          const order = await getOrderById(req.params.id);
          return order?.userId === req.user.id || req.user.roles.includes('admin');
        },
      },
      cache: {
        ttl: 300,
        key: req => `order:${req.params.id}`,
      },
      description: 'Get order by ID',
      tags: ['orders', 'detail'],
      handler: async (req, res) => {
        const order = await getOrderById(req.params.id);

        if (!order) {
          return res.status(404).json({
            success: false,
            error: 'Order not found',
          });
        }

        return { success: true, data: order };
      },
    },

    // Update Order Status (Admin only)
    {
      method: 'PUT',
      path: '/orders/:id/status',
      validation: {
        params: z.object({ id: z.string().uuid() }),
        body: OrderUpdateSchema,
      },
      auth: {
        required: true,
        roles: ['admin', 'fulfillment'],
      },
      rateLimit: { requests: 100, window: 60000 },
      description: 'Update order status',
      tags: ['orders', 'admin', 'status'],
      handler: async (req, res) => {
        const order = await updateOrderStatus(req.params.id, req.body);

        req.events.emit('order:status_updated', {
          order,
          updatedBy: req.user,
          previousStatus: order.previousStatus,
          newStatus: req.body.status,
        });

        return { success: true, data: order };
      },
    },

    // Cancel Order
    {
      method: 'DELETE',
      path: '/orders/:id',
      validation: {
        params: z.object({ id: z.string().uuid() }),
      },
      auth: {
        required: true,
        validator: async req => {
          const order = await getOrderById(req.params.id);
          return (
            (order?.userId === req.user.id && order?.status === 'pending') ||
            req.user.roles.includes('admin')
          );
        },
      },
      rateLimit: { requests: 10, window: 60000 },
      description: 'Cancel an order',
      tags: ['orders', 'cancel'],
      handler: async (req, res) => {
        const order = await cancelOrder(req.params.id, req.user.id);

        req.events.emit('order:cancelled', {
          order,
          cancelledBy: req.user,
          reason: 'user_cancelled',
        });

        return {
          success: true,
          message: 'Order cancelled successfully',
        };
      },
    },
  ],

  // WebSocket handlers for real-time order tracking
  sockets: [
    {
      event: 'track-order',
      validation: z.object({
        orderId: z.string().uuid(),
      }),
      rateLimit: { requests: 20, window: 60000 },
      handler: async (socket, data) => {
        const order = await getOrderById(data.orderId);

        if (!order) {
          return { success: false, error: 'Order not found' };
        }

        // Join order-specific room for updates
        socket.join(`order-${data.orderId}`);

        return {
          success: true,
          data: order,
          message: 'Now tracking order updates',
        };
      },
    },

    {
      event: 'stop-tracking',
      validation: z.object({
        orderId: z.string().uuid(),
      }),
      handler: async (socket, data) => {
        socket.leave(`order-${data.orderId}`);
        return { success: true, message: 'Stopped tracking order' };
      },
    },
  ],
});
```

---

## Validation System

MoroJS uses Zod for runtime validation with full TypeScript integration.

### ValidationConfig

```typescript
interface ValidationConfig {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
}
```

### Validation Functions

#### validate(config, handler)

Create a validation wrapper for handlers.

```typescript
import { validate, z } from '@morojs/moro';

const validateUser = validate(
  {
    body: z.object({
      name: z.string().min(2),
      email: z.string().email(),
    }),
  },
  async (req, res) => {
    // req.body is validated and typed
    return { user: req.body };
  }
);
```

#### Convenience Functions

```typescript
import { body, query, params } from '@morojs/moro';

// Body validation
const bodyValidator = body(UserSchema);

// Query validation
const queryValidator = query(QuerySchema);

// Params validation
const paramsValidator = params(ParamsSchema);
```

### Common Validation Patterns

#### User Input

```typescript
const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).max(120).optional(),
  tags: z.array(z.string()).max(10).default([]),
});
```

#### Query Parameters

```typescript
const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  sort: z.enum(['name', 'date', 'priority']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
```

#### Path Parameters

```typescript
const ParamsSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(['users', 'posts', 'comments']),
});
```

#### Custom Validation

```typescript
const PasswordSchema = z
  .object({
    password: z.string().min(8),
    confirmPassword: z.string(),
  })
  .refine(data => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
```

#### Advanced Validation Examples

```typescript
// Complex nested validation
const OrderSchema = z
  .object({
    customer: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      phone: z
        .string()
        .regex(/^\+?[\d\s-()]+$/)
        .optional(),
    }),
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: z.number().min(1).max(99),
          price: z.number().positive(),
          options: z.record(z.string(), z.unknown()).optional(),
        })
      )
      .min(1)
      .max(50),
    shipping: z.object({
      method: z.enum(['standard', 'express', 'overnight']),
      address: z.object({
        line1: z.string().min(1),
        line2: z.string().optional(),
        city: z.string().min(1),
        state: z.string().length(2),
        zipCode: z.string().regex(/^\d{5}(-\d{4})?$/),
        country: z.string().length(2).default('US'),
      }),
      instructions: z.string().max(500).optional(),
    }),
    payment: z.object({
      method: z.enum(['card', 'paypal', 'bank_transfer']),
      token: z.string().min(1),
    }),
  })
  .refine(
    data => {
      // Business rule: overnight shipping only for orders under $500
      const total = data.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      return data.shipping.method !== 'overnight' || total <= 500;
    },
    {
      message: 'Overnight shipping not available for orders over $500',
      path: ['shipping', 'method'],
    }
  );

// Conditional validation based on environment
const ConfigSchema = z.object({
  database: z.object({
    url:
      process.env.NODE_ENV === 'production'
        ? z.string().url().startsWith('postgres://')
        : z.string().min(1),
    ssl: z.boolean().default(process.env.NODE_ENV === 'production'),
    poolSize: z.number().min(1).max(50).default(10),
  }),
  redis: z
    .object({
      url: z.string().url().optional(),
      enabled: z.boolean().default(true),
    })
    .optional(),
  auth: z.object({
    jwtSecret: z.string().min(32),
    expiresIn: z.string().default('7d'),
    issuer: z.string().default('moro-app'),
  }),
});

// Transform and preprocess data
const UserRegistrationSchema = z.object({
  email: z
    .string()
    .email()
    .transform(email => email.toLowerCase()),
  name: z
    .string()
    .min(2)
    .transform(name => name.trim()),
  birthDate: z
    .string()
    .datetime()
    .transform(date => new Date(date)),
  preferences: z
    .object({
      newsletter: z.boolean().default(false),
      notifications: z.boolean().default(true),
      theme: z.enum(['light', 'dark']).default('light'),
    })
    .default({}),
});
```

---

## Middleware

### Built-in Middleware

MoroJS includes 18+ built-in middleware options. For complete documentation, see the [Middleware Guide](./MIDDLEWARE_GUIDE.md).

#### Security Middleware

**CORS** - Cross-origin resource sharing

MoroJS automatically handles OPTIONS preflight requests.

```typescript
// Static origins
app.use(
  middleware.cors({
    origin: ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    maxAge: 86400, // Cache preflight for 24 hours
  })
);

// Dynamic origin validation
app.use(
  middleware.cors({
    origin: async (requestOrigin, req) => {
      // Database lookup or custom logic
      const isAllowed = await checkOrigin(requestOrigin);
      return isAllowed ? requestOrigin : false;
    },
    credentials: true,
  })
);

// Disable automatic preflight handling
app.use(
  middleware.cors({
    origin: 'https://example.com',
    preflightContinue: true, // Handle OPTIONS manually
  })
);
```

**Helmet** - Security headers

```typescript
app.use(
  middleware.helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  })
);
```

**CSRF** - CSRF protection

```typescript
app.use(
  middleware.csrf({
    cookie: { httpOnly: true, secure: true },
  })
);
```

**CSP** - Content Security Policy

```typescript
app.use(
  middleware.csp({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'nonce-{NONCE}'"],
    },
  })
);
```

#### Performance Middleware

**Compression** - Response compression

```typescript
app.use(
  middleware.compression({
    level: 6,
    threshold: 1024,
    brotli: true,
  })
);
```

**Cache** - Response caching

```typescript
app.use(
  middleware.cache({
    ttl: 300,
    strategy: 'memory', // 'memory' | 'redis' | 'file'
  })
);
```

**Rate Limiting** - Request rate limiting

```typescript
app.use(
  middleware.rateLimit({
    requests: 100,
    window: 60000,
    keyGenerator: req => req.ip,
  })
);
```

#### HTTP Features

**Body Size Limiting**

```typescript
app.use(
  middleware.bodySize({
    limit: '10mb',
  })
);
```

**Cookie Parser**

```typescript
app.use(
  middleware.cookie({
    secret: 'your-secret-key',
    signed: true,
  })
);
```

**Static Files** - Static file serving with caching

```typescript
app.use(
  middleware.staticFiles({
    root: './public',
    maxAge: 3600000,
    etag: true,
  })
);
```

**File Upload** - Multipart file uploads

```typescript
app
  .post('/upload')
  .upload({
    dest: './uploads',
    maxFileSize: 10 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png'],
  })
  .handler((req, res) => {
    return { files: req.files };
  });
```

**Template Rendering** - Template engine support

```typescript
app.use(
  middleware.template({
    views: './views',
    engine: 'moro', // 'moro' | 'handlebars' | 'ejs'
    cache: true,
  })
);

app.get('/page', (req, res) => {
  res.render('index', { title: 'Welcome' });
});
```

**HTTP Range Requests** - Partial content for streaming

```typescript
app.get('/video/:id', async (req, res) => {
  const videoPath = `./videos/${req.params.id}.mp4`;
  const stats = await fs.stat(videoPath);
  res.sendRange(videoPath, stats);
});
```

**HTTP/2 Server Push** - Optimize with HTTP/2 push

```typescript
app.use(
  middleware.http2({
    autoDetect: true,
    resources: [{ path: '/styles/main.css', as: 'style', priority: 200 }],
  })
);
```

See [HTTP/2 Guide](./HTTP2_GUIDE.md) for detailed documentation.

#### Authentication & Sessions

**Authentication** - Auth.js integration with RBAC

```typescript
app.use(
  middleware.auth({
    providers: [
      {
        type: 'oauth',
        provider: 'google',
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      },
    ],
  })
);

app
  .get('/api/profile')
  .auth({ required: true, roles: ['admin'] })
  .handler((req, res) => {
    return { user: req.user };
  });
```

See [Authentication Guide](./AUTH_GUIDE.md) for complete documentation.

**Session Management**

```typescript
app.use(
  middleware.session({
    secret: 'your-secret-key',
    store: 'redis',
    cookie: { maxAge: 24 * 60 * 60 * 1000 },
  })
);
```

#### Real-time & Advanced

**Server-Sent Events (SSE)**

```typescript
app.get('/events', (req, res) => {
  res.sse();
  const interval = setInterval(() => {
    res.sse.send({ event: 'update', data: { time: Date.now() } });
  }, 1000);

  req.on('close', () => clearInterval(interval));
});
```

**CDN Integration**

```typescript
app.use(
  middleware.cdn({
    provider: 'cloudfront',
    config: { distributionId: 'E1234567890ABC' },
  })
);
```

**GraphQL**

```typescript
app.use(
  '/graphql',
  middleware.graphql({
    schema,
    rootValue,
    graphiql: true,
  })
);
```

See [GraphQL Guide](./GRAPHQL_GUIDE.md) for detailed documentation.

#### Monitoring

**Request Logger**

```typescript
app.use(
  middleware.requestLogger({
    format: 'json',
    fields: ['method', 'url', 'status', 'responseTime'],
  })
);
```

**Performance Monitor**

```typescript
app.use(
  middleware.performanceMonitor({
    threshold: 1000,
    onSlow: (req, duration) => {
      console.warn(`Slow: ${req.path} - ${duration}ms`);
    },
  })
);
```

**Error Tracker**

```typescript
app.use(
  middleware.errorTracker({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
  })
);
```

### Middleware Reference

For complete middleware documentation including all options and examples, see:

- **[Middleware Guide](./MIDDLEWARE_GUIDE.md)** - Comprehensive reference for all built-in middleware

### Custom Middleware

#### Standard Middleware

```typescript
const loggerMiddleware = (req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
};

app.use(loggerMiddleware);
```

#### Async Middleware

```typescript
const authMiddleware = async (req, res, next) => {
  try {
    req.user = await authenticateUser(req.headers.authorization);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

app.use(authMiddleware);
```

#### Error Handling Middleware

```typescript
const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
};

app.use(errorHandler);
```

---

## Database Integration

### Database Adapters

#### MySQL Adapter

```typescript
import { MySQLAdapter } from '@morojs/moro';

const db = new MySQLAdapter({
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'password',
  database: 'myapp',
  connectionLimit: 10,
});

app.database(db);
```

#### PostgreSQL Adapter

```typescript
import { PostgreSQLAdapter } from '@morojs/moro';

const db = new PostgreSQLAdapter({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'password',
  database: 'myapp',
});

app.database(db);
```

#### SQLite Adapter

```typescript
import { SQLiteAdapter } from '@morojs/moro';

const db = new SQLiteAdapter({
  filename: './database.sqlite',
});

app.database(db);
```

#### MongoDB Adapter

```typescript
import { MongoDBAdapter } from '@morojs/moro';

const db = new MongoDBAdapter({
  url: 'mongodb://localhost:27017/myapp',
});

app.database(db);
```

#### Redis Adapter

```typescript
import { RedisAdapter } from '@morojs/moro';

const redis = new RedisAdapter({
  host: 'localhost',
  port: 6379,
  password: 'password',
});

app.database(redis);
```

### Database Usage in Handlers

```typescript
app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    // Database is available on request object
    const user = await req.database.insert('users', req.body);
    return { success: true, data: user };
  });
```

### Transaction Support

```typescript
app
  .post('/transfer')
  .body(TransferSchema)
  .handler(async (req, res) => {
    const transaction = await req.database.beginTransaction();

    try {
      await transaction.update(
        'accounts',
        { id: req.body.fromAccount },
        { balance: { decrement: req.body.amount } }
      );

      await transaction.update(
        'accounts',
        { id: req.body.toAccount },
        { balance: { increment: req.body.amount } }
      );

      await transaction.commit();
      return { success: true };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
```

---

## Message Queues

MoroJS includes a production-ready message queue system with multiple backend adapters. For complete documentation, see the [Queue Guide](./QUEUE_GUIDE.md).

### Overview

The queue system supports:

- Multiple adapters (Memory, Bull, RabbitMQ, AWS SQS, Kafka)
- Job scheduling and delays
- Retry logic with configurable backoff
- Dead letter queues
- Priority queues
- Bulk operations
- Monitoring and metrics

### Quick Start

```typescript
import { QueueManager } from '@morojs/moro';

const queueManager = new QueueManager();

// Register a queue
await queueManager.registerQueue('emails', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  concurrency: 10,
});

// Add a job
await queueManager.addToQueue('emails', {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Welcome to our platform!',
});

// Process jobs
await queueManager.process('emails', async job => {
  await sendEmail(job.data);
  return { sent: true };
});
```

### Queue Adapters

#### Memory Adapter

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'memory',
  concurrency: 5,
});
```

#### Bull Adapter (Redis)

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'bull',
  connection: {
    host: 'localhost',
    port: 6379,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});
```

#### RabbitMQ Adapter

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'rabbitmq',
  connection: {
    host: 'localhost',
    port: 5672,
    username: 'guest',
    password: 'guest',
  },
});
```

#### AWS SQS Adapter

```typescript
await queueManager.registerQueue('tasks', {
  adapter: 'sqs',
  connection: {
    region: 'us-east-1',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
  },
});
```

#### Kafka Adapter

```typescript
await queueManager.registerQueue('events', {
  adapter: 'kafka',
  connection: {
    brokers: ['localhost:9092'],
    groupId: 'my-consumer-group',
  },
});
```

### Job Options

```typescript
await queueManager.addToQueue(
  'reports',
  { reportId: 123, format: 'pdf' },
  {
    priority: 10,
    delay: 60000, // 1 minute delay
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    timeout: 30000,
  }
);
```

### Job Processing

```typescript
// Basic processor
await queueManager.process('emails', async job => {
  await sendEmail(job.data);
  return { sent: true };
});

// With progress tracking
await queueManager.process('video-encoding', async job => {
  await job.updateProgress(0);
  const video = await loadVideo(job.data.videoId);

  await job.updateProgress(50);
  const encoded = await encodeVideo(video);

  await job.updateProgress(100);
  return { encoded: true };
});
```

### Queue Monitoring

```typescript
// Get metrics
const metrics = await queueManager.getMetrics('emails');
console.log(`Waiting: ${metrics.waiting}`);
console.log(`Active: ${metrics.active}`);
console.log(`Completed: ${metrics.completed}`);

// Listen to events
queueManager.on('queue:job:completed', event => {
  console.log(`Job ${event.jobId} completed`);
});

queueManager.on('queue:job:failed', event => {
  console.error(`Job ${event.jobId} failed:`, event.error);
});
```

See [Queue Guide](./QUEUE_GUIDE.md) for complete documentation.

---

## gRPC Support

MoroJS includes native gRPC support for building high-performance microservices. For complete documentation, see the [gRPC Guide](./GRPC_GUIDE.md).

### Overview

Features:

- Proto-based service definitions
- All call types (unary, streaming, bidirectional)
- Middleware (auth, validation, logging)
- Health checks
- Server reflection
- TLS/SSL support

### Quick Start

```typescript
import { GrpcManager } from '@morojs/moro';

const grpcManager = new GrpcManager({
  port: 50051,
  host: '0.0.0.0',
});

await grpcManager.initialize();

// Register service
await grpcManager.registerService('./protos/user.proto', 'UserService', {
  GetUser: async (call, callback) => {
    const user = await db.users.findById(call.request.id);
    callback(null, user);
  },
});

await grpcManager.start();
```

### Service Implementation

#### Unary RPC

```typescript
{
  GetUser: async (call, callback) => {
    try {
      const user = await db.users.findOne({ id: call.request.id });

      if (!user) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: 'User not found',
        });
      }

      callback(null, user);
    } catch (error) {
      callback({
        code: grpc.status.INTERNAL,
        message: error.message,
      });
    }
  };
}
```

#### Server Streaming

```typescript
{
  ListUsers: async call => {
    const users = await db.users.find().limit(100);

    for (const user of users) {
      call.write(user);
    }

    call.end();
  };
}
```

#### Client Streaming

```typescript
{
  CreateUsers: async (call, callback) => {
    const users = [];

    call.on('data', userData => {
      users.push(userData);
    });

    call.on('end', async () => {
      const result = await db.users.insertMany(users);
      callback(null, {
        created: result.length,
        ids: result.map(u => u.id),
      });
    });
  };
}
```

#### Bidirectional Streaming

```typescript
{
  Chat: async call => {
    call.on('data', message => {
      // Broadcast message
      broadcastToRoom(message);

      // Echo confirmation
      call.write({
        user_id: 'system',
        message: 'Received',
        timestamp: Date.now(),
      });
    });

    call.on('end', () => {
      call.end();
    });
  };
}
```

### gRPC Middleware

```typescript
import { grpcAuth, grpcRequireRole, grpcValidate } from '@morojs/moro';

await grpcManager.registerService('./protos/user.proto', 'UserService', {
  GetUser: grpcAuth()(async (call, callback) => {
    // Authenticated user available in call.user
    const user = await db.users.findOne({ id: call.request.id });
    callback(null, user);
  }),

  DeleteUser: grpcRequireRole('admin')(async (call, callback) => {
    await db.users.deleteOne({ id: call.request.id });
    callback(null, { success: true });
  }),
});
```

### gRPC Client

```typescript
const client = await grpcManager.createClient(
  './protos/user.proto',
  'UserService',
  'localhost:50051'
);

// Make call
const response = await new Promise((resolve, reject) => {
  client.GetUser({ id: '123' }, (error, response) => {
    if (error) return reject(error);
    resolve(response);
  });
});
```

See [gRPC Guide](./GRPC_GUIDE.md) for complete documentation.

---

## WebSocket Support

### Basic WebSocket Setup

```typescript
app.websocket('/chat', {
  connection: socket => {
    console.log('User connected:', socket.id);
  },

  disconnect: socket => {
    console.log('User disconnected:', socket.id);
  },

  message: (socket, data) => {
    socket.broadcast.emit('message', {
      id: socket.id,
      message: data.message,
      timestamp: new Date(),
    });
    return { success: true };
  },
});
```

### WebSocket with Validation

```typescript
app.websocket('/chat', {
  join: {
    validation: z.object({
      room: z.string().min(1),
      username: z.string().min(2),
    }),
    handler: (socket, data) => {
      socket.join(data.room);
      socket.username = data.username;

      socket.to(data.room).emit('user-joined', {
        username: data.username,
        timestamp: new Date(),
      });

      return { success: true, room: data.room };
    },
  },

  message: {
    validation: z.object({
      room: z.string(),
      content: z.string().min(1).max(500),
    }),
    rateLimit: { requests: 10, window: 60000 },
    handler: (socket, data) => {
      socket.to(data.room).emit('message', {
        username: socket.username,
        content: data.content,
        timestamp: new Date(),
      });

      return { success: true };
    },
  },
});
```

### WebSocket in Modules

```typescript
export default defineModule({
  name: 'chat',
  version: '1.0.0',
  sockets: [
    {
      event: 'join-room',
      validation: z.object({
        room: z.string(),
        username: z.string(),
      }),
      handler: async (socket, data) => {
        socket.join(data.room);
        return { joined: data.room };
      },
    },
    {
      event: 'send-message',
      validation: z.object({
        room: z.string(),
        message: z.string().max(500),
      }),
      rateLimit: { requests: 5, window: 60000 },
      handler: async (socket, data) => {
        socket.to(data.room).emit('new-message', {
          username: socket.username,
          message: data.message,
          timestamp: new Date(),
        });
        return { success: true };
      },
    },
  ],
});
```

---

## Configuration

MoroJS provides a flexible configuration system that supports multiple methods for defining your application settings.

### Configuration Methods

MoroJS supports configuration through:

1. **Configuration Files** (`moro.config.js` or `moro.config.ts`) - **Recommended**
2. **Environment Variables** - For deployment and sensitive data
3. **Schema Defaults** - Fallback values

**Configuration Priority (highest to lowest):**

- Environment Variables
- Configuration File
- Schema Defaults

### Configuration Files

#### moro.config.js (Recommended)

Create a `moro.config.js` file in your project root:

```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
    host: '0.0.0.0',
    environment: 'development',
  },
  database: {
    type: 'postgresql',
    host: 'localhost',
    port: 5432,
    username: 'myapp',
    password: 'development-password',
    database: 'myapp_dev',
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000', 'http://localhost:3001'],
    },
    helmet: {
      enabled: true,
    },
    rateLimit: {
      enabled: true,
      requests: 100,
      window: 60000,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 6,
    },
    cache: {
      enabled: true,
      adapter: 'memory',
      ttl: 300,
    },
  },
  logging: {
    level: 'info',
    format: 'json',
  },
};
```

#### moro.config.ts (TypeScript)

For TypeScript projects, you can use a `.ts` config file:

```typescript
// moro.config.ts
import type { AppConfig, DeepPartial } from '@morojs/moro';

const config: DeepPartial<AppConfig> = {
  server: {
    port: 3000,
  },
  database: {
    postgresql: {
      host: 'localhost',
      port: 5432,
      database: 'myapp_dev',
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000'],
    },
  },
};

export default config;
```

**Note:** Use `DeepPartial<AppConfig>` instead of `Partial<AppConfig>` for proper nested type support.

### Environment Variables

Environment variables take precedence over config files, making them perfect for deployment and sensitive data:

```bash
# .env
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Database
DATABASE_TYPE=postgresql
DATABASE_HOST=db.example.com
DATABASE_PORT=5432
DATABASE_USERNAME=myapp
DATABASE_PASSWORD=secure-production-password
DATABASE_NAME=myapp_prod

# Security
JWT_SECRET=your-secret-key
CORS_ORIGIN=https://myapp.com,https://api.myapp.com

# Performance
CACHE_ADAPTER=redis
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=warn
LOG_FORMAT=json
```

### Configuration Examples

#### Development Environment

```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
    environment: 'development',
  },
  database: {
    type: 'sqlite',
    database: './dev.db',
  },
  logging: {
    level: 'debug',
  },
  security: {
    cors: {
      enabled: true,
      origin: ['http://localhost:3000', 'http://localhost:5173'],
    },
  },
};
```

#### Production Environment

```javascript
// moro.config.js
module.exports = {
  server: {
    port: process.env.PORT || 3000,
    host: '0.0.0.0',
    environment: 'production',
  },
  database: {
    type: 'postgresql',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: true,
  },
  security: {
    cors: {
      enabled: true,
      origin: process.env.CORS_ORIGIN?.split(',') || [],
    },
    helmet: {
      enabled: true,
    },
    rateLimit: {
      enabled: true,
      requests: 1000,
      window: 60000,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 9,
    },
    cache: {
      enabled: true,
      adapter: 'redis',
      redis: {
        url: process.env.REDIS_URL,
      },
      ttl: 3600,
    },
  },
  logging: {
    level: 'info',
    format: 'json',
  },
};
```

#### Multi-Environment Config

```javascript
// moro.config.js
const environment = process.env.NODE_ENV || 'development';

const baseConfig = {
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || 'localhost',
  },
  security: {
    cors: {
      enabled: true,
    },
  },
};

const environmentConfigs = {
  development: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'development',
    },
    database: {
      type: 'sqlite',
      database: './dev.db',
    },
    logging: {
      level: 'debug',
    },
  },

  test: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'test',
    },
    database: {
      type: 'sqlite',
      database: ':memory:',
    },
    logging: {
      level: 'error',
    },
  },

  production: {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      environment: 'production',
    },
    database: {
      type: 'postgresql',
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      username: process.env.DATABASE_USERNAME,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      ssl: true,
    },
    logging: {
      level: 'info',
      format: 'json',
    },
  },
};

module.exports = environmentConfigs[environment];
```

### Module Configuration

MoroJS also supports module-specific configuration using `createModuleConfig`:

```typescript
import { createModuleConfig, z } from '@morojs/moro';

// Define module schema
const EmailModuleSchema = z.object({
  apiKey: z.string(),
  timeout: z.number().default(5000),
  retries: z.number().default(3),
  enabled: z.boolean().default(true),
});

// Create module config with environment override support
const emailConfig = createModuleConfig(
  EmailModuleSchema,
  {
    apiKey: 'default-key',
    timeout: 3000,
  },
  'EMAIL_' // Environment prefix
);

// Now emailConfig will merge:
// 1. Environment variables (EMAIL_API_KEY, EMAIL_TIMEOUT, etc.)
// 2. Global app config
// 3. Default values passed above
// 4. Schema defaults
```

### Configuration Usage

```typescript
const app = await createApp();

// Access configuration
const config = app.getConfig();
console.log('Server port:', config.server.port);
console.log('Database host:', config.database.host);
console.log('Environment:', config.server.environment);

// Configuration is fully typed!
// TypeScript will provide intellisense and type checking
if (config.server.environment === 'development') {
  console.log('Development mode enabled');
}

// Environment-specific config
if (config.server.environment === 'production') {
  app.enableDocs({ basePath: '/internal/docs' });
} else {
  app.enableDocs({ basePath: '/docs' });
}
```

---

## Events

### Application Events

MoroJS provides an event system for application lifecycle and custom events.

```typescript
// Listen to framework events
app.events.on('framework:initialized', ({ options, config }) => {
  console.log('Framework initialized with options:', options);
});

app.events.on('server:started', ({ port }) => {
  console.log(`Server started on port ${port}`);
});

app.events.on('module:loaded', ({ moduleId, version }) => {
  console.log(`Module ${moduleId}@${version} loaded`);
});

app.events.on('database:connected', ({ adapter }) => {
  console.log(`Database connected using ${adapter}`);
});
```

### Custom Events in Handlers

```typescript
app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    const user = await createUser(req.body);

    // Emit custom event
    req.events.emit('user:created', {
      user,
      timestamp: new Date(),
      ip: req.ip,
    });

    return { success: true, data: user };
  });

// Listen to custom events
app.events.on('user:created', ({ user, timestamp, ip }) => {
  console.log(`New user ${user.name} created from ${ip} at ${timestamp}`);

  // Send welcome email, update analytics, etc.
  sendWelcomeEmail(user);
  updateAnalytics('user_created', { userId: user.id });
});
```

### Module Events

Events are scoped to modules for better isolation:

```typescript
export default defineModule({
  name: 'orders',
  version: '1.0.0',
  routes: [
    {
      method: 'POST',
      path: '/orders',
      handler: async (req, res) => {
        const order = await createOrder(req.body);

        // Module-scoped event
        req.events.emit('order:created', { order });

        return { success: true, data: order };
      },
    },
  ],
});

// Listen to module events
app.events.on('orders:order:created', ({ order }) => {
  console.log('New order created:', order.id);
});
```

### Event Types

```typescript
interface FrameworkEvents {
  'framework:initialized': { options: MoroOptions; config: AppConfig };
  'server:started': { port: number };
  'server:stopping': {};
  'module:loading': { moduleId: string };
  'module:loaded': { moduleId: string; version: string };
  'database:connected': { adapter: string };
  'websocket:connection': { namespace: string; socket: Socket };
  'websocket:disconnect': { namespace: string; socket: Socket };
}
```

---

## Worker Threads

MoroJS includes built-in Worker Threads support for offloading CPU-intensive operations. For complete documentation, see the [Workers Guide](./WORKERS_GUIDE.md).

### Overview

Worker threads execute CPU-intensive operations in separate threads, preventing main thread blocking.

**Suitable for:**

- JWT signing/verification
- Password hashing
- Data encryption/decryption
- Image/video processing
- Large data transformations
- Complex calculations

**Not suitable for:**

- Database queries (already async)
- HTTP requests (already async)
- File I/O (already async)

### Quick Start

```typescript
import { getWorkerManager, workerTasks } from '@morojs/moro';

const workers = getWorkerManager();

// Verify JWT on worker thread
app.post('/api/auth/verify', async (req, res) => {
  const result = await workerTasks.verifyJWT(req.body.token, process.env.JWT_SECRET);

  if (result.valid) {
    return { user: result.payload };
  } else {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Hash password on worker thread
app.post('/api/register', async (req, res) => {
  const hash = await workerTasks.hashData(req.body.password, 'sha256');

  const user = await createUser({
    email: req.body.email,
    password: hash,
  });

  return user;
});
```

### Built-in Worker Tasks

#### JWT Operations

```typescript
import { workerTasks } from '@morojs/moro';

// Sign JWT
const token = await workerTasks.signJWT(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

// Verify JWT
const result = await workerTasks.verifyJWT(token, process.env.JWT_SECRET);
```

#### Cryptographic Operations

```typescript
// Hash data
const hash = await workerTasks.hashData(data, 'sha256');

// Encrypt data
const encrypted = await workerTasks.encryptData(sensitiveData, process.env.ENCRYPTION_KEY);

// Decrypt data
const decrypted = await workerTasks.decryptData(encryptedData, process.env.ENCRYPTION_KEY);
```

#### Data Compression

```typescript
// Compress data
const compressed = await workerTasks.compressData(JSON.stringify(largeData));

// Decompress data
const decompressed = await workerTasks.decompressData(compressedData);
```

#### Heavy Computation

```typescript
// Process complex calculation
const result = await workerTasks.heavyComputation(operation, params);

// Transform large JSON
const transformed = await workerTasks.transformJSON(data, item => ({
  ...item,
  computed: expensiveTransform(item),
}));
```

### Configuration

```typescript
import { WorkerManager } from '@morojs/moro';

// Configure worker pool
const workers = new WorkerManager({
  workerCount: 4, // Number of worker threads
  maxQueueSize: 1000, // Maximum queued tasks
});

// Or use with createApp
const app = await createApp({
  workers: {
    count: 4,
    maxQueueSize: 1000,
  },
});
```

### Task Priority

```typescript
import { getWorkerManager } from '@morojs/moro';

const workers = getWorkerManager();

// High priority task
await workers.executeTask({
  id: 'critical-task',
  type: 'crypto:hash',
  data: { input: 'critical-data' },
  priority: 'high', // 'high' | 'normal' | 'low'
  timeout: 10000, // Optional timeout
});
```

### Execution Model

Worker threads use message passing:

1. Task is serialized and sent to worker thread
2. Worker executes task in separate V8 isolate
3. Result is serialized and returned to main thread
4. Promise resolves with result

**Overhead considerations:**

- Data serialization cost
- Thread communication overhead
- Task complexity vs overhead tradeoff

### Worker Stats

```typescript
const workers = getWorkerManager();
const stats = workers.getStats();

console.log(stats);
// {
//   workers: 4,
//   queueSize: 23,
//   activeTasks: 4
// }
```

For complete documentation, examples, and best practices, see the [Workers Guide](./WORKERS_GUIDE.md).

---

## Performance

### Caching Strategies

```typescript
// Memory caching
app
  .get('/popular-posts')
  .cache({
    ttl: 300, // 5 minutes
    strategy: 'memory',
  })
  .handler(getPopularPosts);

// Redis caching
app
  .get('/user-profile/:id')
  .cache({
    ttl: 600, // 10 minutes
    strategy: 'redis',
    key: req => `profile:${req.params.id}`,
  })
  .handler(getUserProfile);

// Custom cache key generation
app
  .get('/search')
  .cache({
    ttl: 120,
    key: req => `search:${JSON.stringify(req.query)}`,
  })
  .handler(searchContent);
```

### Rate Limiting

```typescript
// Global rate limiting
app.use(
  middleware.rateLimit({
    requests: 1000,
    window: 60000, // 1 minute
    skipSuccessfulRequests: false,
  })
);

// Route-specific rate limiting
app
  .post('/api/upload')
  .rateLimit({
    requests: 5,
    window: 60000,
    skipSuccessfulRequests: true,
  })
  .handler(handleUpload);

// User-specific rate limiting
app
  .post('/api/send-email')
  .rateLimit({
    requests: 10,
    window: 3600000, // 1 hour
    keyGenerator: req => `user:${req.user.id}`,
  })
  .handler(sendEmail);
```

### Circuit Breaker

```typescript
// Automatic circuit breaker protection
app.get('/external-api').handler(async (req, res) => {
  // Automatically protected by circuit breaker
  const data = await callExternalAPI();
  return { success: true, data };
});
```

### Performance Benchmarks

| Framework | Req/sec    | Latency   | Memory   |
| --------- | ---------- | --------- | -------- |
| **Moro**  | **52,400** | **1.8ms** | **24MB** |
| Express   | 28,540     | 3.8ms     | 45MB     |
| Fastify   | 38,120     | 2.9ms     | 35MB     |
| NestJS    | 22,100     | 4.5ms     | 58MB     |
| Koa       | 25,880     | 4.2ms     | 42MB     |

_Benchmark: 50,000 requests, 100 concurrent connections, Node.js 20.x_

---

## Error Handling

### Global Error Handling

```typescript
// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    requestId: req.requestId,
  });
});
```

### Route-Specific Error Handling

```typescript
app
  .get('/users/:id')
  .params(z.object({ id: z.string().uuid() }))
  .handler(async (req, res) => {
    try {
      const user = await getUserById(req.params.id);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found',
        });
      }

      return { success: true, data: user };
    } catch (error) {
      console.error('Error fetching user:', error);
      throw error; // Will be caught by global error handler
    }
  });
```

### Custom Error Classes

```typescript
class ValidationError extends Error {
  constructor(
    message: string,
    public field: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

class NotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
  }
}

// Use in handlers
app.get('/users/:id').handler(async (req, res) => {
  const user = await getUserById(req.params.id);

  if (!user) {
    throw new NotFoundError('User');
  }

  return { success: true, data: user };
});
```

---

This API reference covers the core functionality of MoroJS. For more examples and advanced usage patterns, see the [examples repository](https://github.com/Moro-JS/examples) and other documentation in this `/docs` folder.
