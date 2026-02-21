# Migration Guide

Comprehensive guide for migrating to MoroJS from other frameworks.

## Table of Contents

- [From Express.js](#from-expressjs)
- [From Fastify](#from-fastify)
- [From NestJS](#from-nestjs)
- [From Koa](#from-koa)
- [From Next.js API Routes](#from-nextjs-api-routes)
- [From SvelteKit](#from-sveltekit)
- [Common Migration Patterns](#common-migration-patterns)
- [Advanced Features](#advanced-features)
- [Performance Improvements](#performance-improvements)

---

## From Express.js

### The Problem with Express

Express.js requires careful middleware ordering and manual validation setup:

```typescript
// ❌ Express - Order matters, easy to break
const express = require('express');
const app = express();

app.use(cors());                    // Must be first
app.use(helmet());                  // Must be early
app.use(express.json());            // Must be before validation
app.use(rateLimit({ ... }));        // Must be before routes
app.use('/users', validateUser);    // Manual validation middleware
app.post('/users', createUser);     // Must be last
```

**Problems:**

- Middleware order dependencies cause bugs
- Manual validation setup for each route
- No TypeScript inference from validation
- Error-prone middleware configuration
- Difficult to maintain as app grows

### MoroJS Solution

```typescript
// ✅ Moro - Order independent, automatic validation
import { createApp, z } from '@morojs/moro';
const app = await createApp();

app
  .post('/users')
  .body(
    z.object({
      // Automatic validation + TypeScript types
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .rateLimit({ requests: 10, window: 60000 }) // Order doesn't matter!
  .handler(createUser); // Framework handles optimal ordering
```

### Migration Steps

1. **Replace Express app creation:**

   ```typescript
   // Before
   const express = require('express');
   const app = express();

   // After
   import { createApp } from '@morojs/moro';
   const app = await createApp();
   ```

2. **Convert middleware to chainable API:**

   ```typescript
   // Before
   app.use(cors());
   app.use(helmet());
   app.use(rateLimit(config));
   app.post('/users', validate(schema), handler);

   // After
   app.post('/users').body(schema).rateLimit(config).handler(handler);
   // CORS and helmet are enabled by default
   ```

3. **Replace custom validation with MoroJS validation (Zod is optional):**

   ```typescript
   // Before
   const { body, validationResult } = require('express-validator');

   app.post('/users', [body('name').isLength({ min: 2 }), body('email').isEmail()], (req, res) => {
     const errors = validationResult(req);
     if (!errors.isEmpty()) {
       return res.status(400).json({ errors: errors.array() });
     }
     // Handle valid request
   });

   // After (with Zod - install as peer dependency)
   import { z } from '@morojs/moro'; // Zod is optional peer dependency
   app
     .post('/users')
     .body(
       z.object({
         name: z.string().min(2),
         email: z.string().email(),
       })
     )
     .handler((req, res) => {
       // req.body is automatically validated and typed!
       return { success: true, data: req.body };
     });

   // Or without any validation library
   app.post('/users').handler((req, res) => {
     // Manual validation or no validation
     return { success: true, data: req.body };
   });
   ```

4. **Convert error handling:**

   ```typescript
   // Before
   app.use((err, req, res, next) => {
     res.status(500).json({ error: err.message });
   });

   // After - Global error handling works the same
   app.use((err, req, res, next) => {
     res.status(500).json({ error: err.message });
   });
   ```

---

## From Fastify

### The Problem with Fastify

Fastify uses JSON Schema which is verbose and lacks TypeScript integration:

```typescript
// ❌ Fastify - Verbose JSON Schema
fastify.post('/users', {
  schema: {
    body: {
      type: 'object',
      required: ['name', 'email'],
      properties: {
        name: { type: 'string', minLength: 2 },
        email: { type: 'string', format: 'email' },
      },
    },
  },
  preHandler: [rateLimit, auth], // Manual ordering required
  handler: createUser,
});
```

**Problems:**

- JSON Schema is verbose and hard to maintain
- Poor TypeScript integration
- Manual middleware ordering still required
- Separate type definitions needed for TypeScript

### MoroJS Solution

```typescript
// ✅ Moro - Concise Zod schema with full TypeScript
app
  .post('/users')
  .body(
    z.object({
      name: z.string().min(2), // Better TypeScript integration
      email: z.string().email(),
    })
  )
  .rateLimit({ requests: 10, window: 60000 })
  .auth({ roles: ['user'] }) // Automatic optimal ordering
  .handler(createUser);
```

### Migration Steps

1. **Replace Fastify app creation:**

   ```typescript
   // Before
   const fastify = require('fastify')({ logger: true });

   // After
   import { createApp } from '@morojs/moro';
   const app = await createApp({ logging: true });
   ```

2. **Convert JSON Schema to MoroJS validation (Zod is optional):**

   ```typescript
   // Before
   const userSchema = {
     body: {
       type: 'object',
       required: ['name', 'email'],
       properties: {
         name: { type: 'string', minLength: 2, maxLength: 50 },
         email: { type: 'string', format: 'email' },
         age: { type: 'number', minimum: 18 },
       },
     },
   };

   // After (with Zod - install as peer dependency)
   import { z } from '@morojs/moro'; // Zod is optional peer dependency
   const userSchema = z.object({
     name: z.string().min(2).max(50),
     email: z.string().email(),
     age: z.number().min(18).optional(),
   });

   // Or use other validation libraries (Joi, Yup, Class Validator)
   import { joi, yup, classValidator } from '@morojs/moro';
   // All validation libraries are optional peer dependencies
   ```

3. **Convert route definitions:**

   ```typescript
   // Before
   fastify.post('/users', {
     schema: userSchema,
     preHandler: [authenticate, rateLimit],
     handler: async (request, reply) => {
       return { user: request.body };
     },
   });

   // After
   app
     .post('/users')
     .body(userSchema)
     .auth({ required: true })
     .rateLimit({ requests: 10, window: 60000 })
     .handler(async (req, res) => {
       return { user: req.body }; // Fully typed!
     });
   ```

4. **Convert plugins to modules:**

   ```typescript
   // Before
   await fastify.register(require('./plugins/database'));
   await fastify.register(require('./plugins/auth'));

   // After
   await app.loadModule('./modules/database');
   await app.loadModule('./modules/auth');
   ```

---

## From NestJS

### The Problem with NestJS

NestJS is decorator-heavy and class-based, which can be complex:

```typescript
// ❌ NestJS - Decorator-heavy, class-based
@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  @Post()
  @UseInterceptors(RateLimitInterceptor)
  @UsePipes(new ValidationPipe())
  async create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }
}
```

**Problems:**

- Heavy use of decorators reduces readability
- Class-based architecture adds complexity
- Requires understanding of dependency injection
- More boilerplate code
- Harder to test individual functions

### MoroJS Solution

```typescript
// ✅ Moro - Functional, clean, no decorators
app
  .post('/users')
  .body(CreateUserSchema) // Direct Zod schema
  .auth({ roles: ['user'] }) // No guards needed
  .rateLimit({ requests: 10, window: 60000 }) // No interceptors
  .handler(async (req, res) => {
    // Pure function
    return { success: true, data: await createUser(req.body) };
  });
```

### Migration Steps

1. **Replace NestJS app with MoroJS:**

   ```typescript
   // Before
   import { NestFactory } from '@nestjs/core';
   import { AppModule } from './app.module';

   async function bootstrap() {
     const app = await NestFactory.create(AppModule);
     await app.listen(3000);
   }

   // After
   import { createApp } from '@morojs/moro';

   const app = await createApp();
   app.listen(3000);
   ```

2. **Convert controllers to route handlers:**

   ```typescript
   // Before
   @Controller('users')
   export class UsersController {
     @Get()
     async findAll(@Query() query: GetUsersDto) {
       return this.usersService.findAll(query);
     }

     @Post()
     @UsePipes(ValidationPipe)
     async create(@Body() createUserDto: CreateUserDto) {
       return this.usersService.create(createUserDto);
     }
   }

   // After
   app
     .get('/users')
     .query(GetUsersSchema)
     .handler(async (req, res) => {
       return { users: await findAllUsers(req.query) };
     });

   app
     .post('/users')
     .body(CreateUserSchema)
     .handler(async (req, res) => {
       return { user: await createUser(req.body) };
     });
   ```

3. **Convert DTOs to Zod schemas:**

   ```typescript
   // Before
   export class CreateUserDto {
     @IsString()
     @MinLength(2)
     @MaxLength(50)
     name: string;

     @IsEmail()
     email: string;

     @IsOptional()
     @IsInt()
     @Min(18)
     age?: number;
   }

   // After
   const CreateUserSchema = z.object({
     name: z.string().min(2).max(50),
     email: z.string().email(),
     age: z.number().int().min(18).optional(),
   });
   ```

4. **Convert guards to auth middleware:**

   ```typescript
   // Before
   @Injectable()
   export class AuthGuard implements CanActivate {
     canActivate(context: ExecutionContext): boolean {
       const request = context.switchToHttp().getRequest();
       return validateUser(request.headers.authorization);
     }
   }

   // After - Built into route definition
   app
     .get('/protected')
     .auth({
       required: true,
       validator: req => validateUser(req.headers.authorization),
     })
     .handler(protectedHandler);
   ```

5. **Convert modules to MoroJS modules:**

   ```typescript
   // Before
   @Module({
     controllers: [UsersController],
     providers: [UsersService],
     exports: [UsersService],
   })
   export class UsersModule {}

   // After
   export default defineModule({
     name: 'users',
     version: '1.0.0',
     routes: [
       {
         method: 'GET',
         path: '/users',
         handler: getUsersHandler,
       },
       {
         method: 'POST',
         path: '/users',
         validation: { body: CreateUserSchema },
         handler: createUserHandler,
       },
     ],
   });
   ```

---

## From Koa

### The Problem with Koa

Koa requires manual middleware setup and has no built-in validation:

```typescript
// ❌ Koa - Manual middleware setup
const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');

const app = new Koa();
const router = new Router();

app.use(bodyParser());
app.use(router.routes());

router.post('/users', async ctx => {
  // Manual validation required
  if (!ctx.request.body.name || ctx.request.body.name.length < 2) {
    ctx.status = 400;
    ctx.body = { error: 'Name is required and must be at least 2 characters' };
    return;
  }
  // Handle request
});
```

### MoroJS Solution

```typescript
// ✅ Moro - Built-in validation and routing
app
  .post('/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .handler(async (req, res) => {
    // Automatic validation, fully typed
    return { success: true, data: req.body };
  });
```

### Migration Steps

1. **Replace Koa app:**

   ```typescript
   // Before
   const Koa = require('koa');
   const app = new Koa();

   // After
   import { createApp } from '@morojs/moro';
   const app = await createApp();
   ```

2. **Convert middleware:**

   ```typescript
   // Before
   app.use(async (ctx, next) => {
     console.log(`${ctx.method} ${ctx.url}`);
     await next();
   });

   // After
   app.use(async (req, res, next) => {
     console.log(`${req.method} ${req.url}`);
     await next();
   });
   ```

3. **Convert routes:**

   ```typescript
   // Before
   const Router = require('koa-router');
   const router = new Router();

   router.get('/users', async ctx => {
     ctx.body = { users: await getUsers() };
   });

   // After
   app.get('/users', async (req, res) => {
     return { users: await getUsers() };
   });
   ```

---

## From Next.js API Routes

### The Problem with Next.js API Routes

Next.js API routes are tightly coupled to the Next.js framework and have limitations:

```typescript
// ❌ Next.js API Routes - Framework coupling
// pages/api/users.ts
import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    // Manual validation
    if (!req.body.name || req.body.name.length < 2) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    // Handle request
  }
}

// pages/api/auth/[...nextauth].ts
import NextAuth from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';

export default NextAuth({
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
});
```

**Problems:**

- Tightly coupled to Next.js framework
- Manual validation and error handling
- Limited middleware options
- No built-in authentication
- Difficult to test in isolation
- No multi-runtime support

### MoroJS Solution

```typescript
// ✅ MoroJS - Framework agnostic, built-in features
import { createApp, z } from '@morojs/moro';
import { createAuthMiddleware } from '@auth/morojs';
import Google from '@auth/core/providers/google';

const app = await createApp();

// Built-in authentication
app.use(
  createAuthMiddleware({
    providers: [
      Google({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    ],
    secret: process.env.AUTH_SECRET,
  })
);

// Automatic validation and TypeScript inference
app
  .post('/api/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .auth({ required: true })
  .handler(async (req, res) => {
    return { success: true, user: req.body };
  });
```

### Migration Steps

1. **Replace Next.js API routes:**

   ```typescript
   // Before (Next.js)
   // pages/api/users.ts
   export default function handler(req, res) {
     // API logic
   }

   // After (MoroJS)
   // src/routes/users.ts
   app.post('/api/users').body(userSchema).handler(createUser);
   ```

2. **Convert authentication:**

   ```typescript
   // Before (NextAuth.js)
   import NextAuth from 'next-auth';
   import GoogleProvider from 'next-auth/providers/google';

   export default NextAuth({
     providers: [GoogleProvider({ ... })],
   });

   // After (MoroJS + Auth.js)
   import { createAuthMiddleware } from '@auth/morojs';
   import Google from '@auth/core/providers/google';

   app.use(createAuthMiddleware({
     providers: [Google({ ... })],
   }));
   ```

3. **Deploy to multiple runtimes:**

   ```typescript
   // Node.js
   app.listen(3000);

   // Vercel Edge
   export default app.getHandler();

   // AWS Lambda
   export const handler = app.getLambdaHandler();

   // Cloudflare Workers
   export default app.getWorkerHandler();
   ```

---

## From SvelteKit

### The Problem with SvelteKit

SvelteKit API routes are limited and tightly coupled to the SvelteKit framework:

```typescript
// ❌ SvelteKit - Limited API capabilities
// src/routes/api/users/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();

  // Manual validation
  if (!body.name || body.name.length < 2) {
    return json({ error: 'Invalid name' }, { status: 400 });
  }

  return json({ success: true, user: body });
};
```

**Problems:**

- Limited to SvelteKit ecosystem
- Manual validation and error handling
- No built-in authentication
- No middleware system
- Limited deployment options

### MoroJS Solution

```typescript
// ✅ MoroJS - Full-featured API framework
import { createApp, z } from '@morojs/moro';

const app = await createApp();

app
  .post('/api/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .handler(async (req, res) => {
    return { success: true, user: req.body };
  });
```

### Migration Steps

1. **Extract API logic to MoroJS:**

   ```typescript
   // Before (SvelteKit)
   // src/routes/api/users/+server.ts
   export const POST: RequestHandler = async ({ request }) => {
     // API logic
   };

   // After (MoroJS)
   // src/api/users.ts
   app.post('/api/users').body(userSchema).handler(createUser);
   ```

2. **Keep SvelteKit for frontend, MoroJS for API:**

   ```typescript
   // SvelteKit frontend
   // src/routes/+page.svelte
   <script>
     async function createUser(userData) {
       const response = await fetch('/api/users', {
         method: 'POST',
         body: JSON.stringify(userData)
       });
       return response.json();
     }
   </script>

   // MoroJS API
   // src/api/users.ts
   app.post('/api/users')
     .body(userSchema)
     .handler(createUser);
   ```

---

## Common Migration Patterns

### 1. Request/Response Objects

**Express/Koa style → MoroJS:**

```typescript
// Before (Express)
app.get('/users', (req, res) => {
  res.json({ users: [] });
});

// Before (Koa)
router.get('/users', ctx => {
  ctx.body = { users: [] };
});

// After (MoroJS)
app.get('/users', (req, res) => {
  return { users: [] }; // Automatic JSON response
});
```

### 2. Validation

**Manual validation → Zod validation:**

```typescript
// Before
app.post('/users', (req, res) => {
  if (!req.body.name || req.body.name.length < 2) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  if (!isEmail(req.body.email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  // Handle valid request
});

// After
app
  .post('/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .handler((req, res) => {
    // req.body is automatically validated and typed
    return { success: true, data: req.body };
  });
```

### 3. Middleware

**Global middleware:**

```typescript
// Before (Express)
app.use(cors());
app.use(helmet());
app.use(rateLimit(config));

// After (MoroJS) - Built in with configuration
const app = await createApp({
  cors: true,
  helmet: true,
  rateLimit: config,
});

// Or use middleware explicitly
app.use(middleware.cors());
app.use(middleware.helmet());
app.use(middleware.rateLimit(config));
```

### 4. Error Handling

**Error handling patterns:**

```typescript
// Before
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// After (same pattern works)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
```

### 5. Database Integration

**Database usage:**

```typescript
// Before
const mysql = require('mysql2');
const db = mysql.createConnection(config);

app.get('/users', async (req, res) => {
  const users = await db.query('SELECT * FROM users');
  res.json({ users });
});

// After
import { MySQLAdapter } from '@morojs/moro';
const db = new MySQLAdapter(config);
app.database(db);

app.get('/users', async (req, res) => {
  const users = await req.database.query('SELECT * FROM users');
  return { users };
});
```

---

## Advanced Features

MoroJS includes many advanced features that aren't available in traditional frameworks:

### 1. Universal Validation System

Support for multiple validation libraries with a unified interface. All validation libraries are optional peer dependencies:

```typescript
import { createApp, z, joi, yup, classValidator } from '@morojs/moro';

const app = await createApp();

// Use any validation library (all are optional)
app
  .post('/users')
  .body(z.object({ name: z.string() })) // Zod (optional)
  .query(joi.object({ page: joi.number() })) // Joi (optional)
  .params(yup.object({ id: yup.string() })) // Yup (optional)
  .handler(createUser);

// Or use class-validator (optional)
class CreateUserDto {
  @IsString()
  @MinLength(2)
  name: string;
}

app.post('/users').body(classValidator(CreateUserDto)).handler(createUser);

// Or use no validation at all - framework works without any validation libraries!
app.post('/users').handler(createUser);
```

### 2. Enterprise Authentication

Complete Auth.js integration with native MoroJS adapter:

```typescript
import { createApp } from '@morojs/moro';
import { createAuthMiddleware } from '@auth/morojs';
import { providers } from '@auth/core';

const app = await createApp();

app.use(
  createAuthMiddleware({
    providers: [
      providers.GitHub({
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      }),
      providers.Google({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    ],
    secret: process.env.AUTH_SECRET,
  })
);

// Automatic authentication
app
  .get('/protected')
  .auth({ required: true })
  .handler((req, res) => {
    return { user: req.auth.user };
  });
```

### 3. Multi-Runtime Support

Deploy the same code to multiple environments:

```typescript
import { createApp, createAppEdge, createAppLambda, createAppWorker } from '@morojs/moro';

// Node.js
const nodeApp = await createApp();
nodeApp.listen(3000);

// Vercel Edge Functions
const edgeApp = await createAppEdge();
export default edgeApp.getHandler();

// AWS Lambda
const lambdaApp = await createAppLambda();
export const handler = lambdaApp.getLambdaHandler();

// Cloudflare Workers
const workerApp = await createAppWorker();
export default workerApp.getWorkerHandler();
```

### 4. WebSocket Support

Built-in WebSocket support with multiple adapters:

```typescript
import { createApp, SocketIOAdapter, WSAdapter } from '@morojs/moro';

const app = await createApp();

// Socket.IO adapter
app.websocket(
  '/socket.io',
  new SocketIOAdapter({
    cors: { origin: '*' },
  })
);

// Native WebSocket adapter
app.websocket('/ws', new WSAdapter());

// WebSocket routes
app
  .websocket('/chat')
  .auth({ required: true })
  .handler((socket, req) => {
    socket.on('message', data => {
      socket.broadcast.emit('message', data);
    });
  });
```

### 5. Database Integration

Multiple database adapters with unified interface:

```typescript
import { createApp, MySQLAdapter, PostgreSQLAdapter, MongoDBAdapter } from '@morojs/moro';

const app = await createApp();

// MySQL
app.database(
  new MySQLAdapter({
    host: 'localhost',
    user: 'root',
    password: 'password',
    database: 'myapp',
  })
);

// PostgreSQL
app.database(
  new PostgreSQLAdapter({
    connectionString: 'postgresql://user:password@localhost:5432/myapp',
  })
);

// MongoDB
app.database(
  new MongoDBAdapter({
    uri: 'mongodb://localhost:27017/myapp',
  })
);

// Use in routes
app.get('/users').handler(async (req, res) => {
  const users = await req.database.query('SELECT * FROM users');
  return { users };
});
```

### 6. Intelligent Routing

Automatic middleware ordering and optimization:

```typescript
app
  .post('/users')
  .body(userSchema) // Validation middleware
  .auth({ required: true }) // Authentication middleware
  .rateLimit({ requests: 10, window: 60000 }) // Rate limiting
  .cache({ ttl: 300 }) // Caching
  .handler(createUser); // Handler

// Framework automatically orders middleware optimally
// No need to worry about middleware order!
```

### 7. Module System

Functional module architecture for better organization:

```typescript
import { defineModule } from '@morojs/moro';

export default defineModule({
  name: 'users',
  version: '1.0.0',
  routes: [
    {
      method: 'GET',
      path: '/users',
      handler: getUsers,
    },
    {
      method: 'POST',
      path: '/users',
      validation: { body: userSchema },
      handler: createUser,
    },
  ],
  sockets: [
    {
      path: '/users',
      handler: userSocketHandler,
    },
  ],
});

// Auto-discover modules
app.autoDiscover('./modules');
```

### 8. Event System

Enterprise-grade event bus for microservices:

```typescript
import { createApp, MoroEventBus } from '@morojs/moro';

const app = await createApp();

// Global event bus
app.eventBus.on('user.created', event => {
  console.log('User created:', event.payload);
});

// Emit events
app.post('/users').handler(async (req, res) => {
  const user = await createUser(req.body);

  // Emit event
  app.eventBus.emit('user.created', {
    userId: user.id,
    timestamp: new Date(),
  });

  return { user };
});
```

### 9. Configuration System

Flexible configuration with multiple sources:

```typescript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
    host: 'localhost',
  },
  database: {
    type: 'postgresql',
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
  },
  auth: {
    providers: ['github', 'google'],
    secret: process.env.AUTH_SECRET,
  },
};

// Environment variables override config file
// CLUSTERING_ENABLED=true
// CLUSTER_WORKERS=4
```

### 10. Performance Optimizations

Built-in performance features:

```typescript
const app = await createApp({
  performance: {
    clustering: {
      enabled: true,
      workers: 'auto',
    },
    compression: {
      enabled: true,
      threshold: 1024,
    },
    circuitBreaker: {
      enabled: true,
      timeout: 5000,
    },
  },
});
```

---

## Performance Improvements

### Expected Performance Gains

| Migration From | Req/sec Improvement         | Latency Improvement      | Memory Improvement     |
| -------------- | --------------------------- | ------------------------ | ---------------------- |
| Express        | **+84%** (28,540 → 52,400)  | **-53%** (3.8ms → 1.8ms) | **-47%** (45MB → 24MB) |
| Fastify        | **+37%** (38,120 → 52,400)  | **-38%** (2.9ms → 1.8ms) | **-31%** (35MB → 24MB) |
| NestJS         | **+137%** (22,100 → 52,400) | **-60%** (4.5ms → 1.8ms) | **-59%** (58MB → 24MB) |
| Koa            | **+102%** (25,880 → 52,400) | **-57%** (4.2ms → 1.8ms) | **-43%** (42MB → 24MB) |
| Next.js API    | **+156%** (20,400 → 52,400) | **-65%** (5.1ms → 1.8ms) | **-62%** (63MB → 24MB) |
| SvelteKit      | **+128%** (23,000 → 52,400) | **-61%** (4.6ms → 1.8ms) | **-58%** (57MB → 24MB) |

### Performance Features You Get

1. **Optimized Middleware Execution**
   - Intelligent ordering eliminates unnecessary middleware calls
   - Phase-based execution reduces overhead
   - Object pooling for LogEntry objects
   - String builder pattern for efficient concatenation
   - Buffered output with micro-batching (1ms intervals)

2. **Universal Validation System**
   - Support for Zod, Joi, Yup, and Class Validator (all optional)
   - Zero-dependency core framework
   - Dynamic validation loading - only loads libraries when available
   - 2-3x faster than JSON Schema validation
   - Framework works without any validation libraries installed

3. **Runtime Optimizations**
   - Runtime-specific adapters for optimal performance
   - Memory-efficient request/response handling
   - ES2022 optimizations and memory leak fixes
   - Clustering configuration with automatic worker management

4. **Built-in Performance Features**
   - Circuit breakers for external calls
   - Intelligent caching strategies
   - Connection pooling
   - Compression with configurable thresholds
   - Rate limiting with multiple strategies

5. **Logger Performance**
   - 55% faster simple logs, 107% faster complex logs
   - Aggressive level checking with numeric comparisons
   - Static pre-allocated strings for levels and ANSI codes
   - Improved timestamp caching (100ms vs 1000ms)

6. **Memory Management**
   - Object pooling for common objects
   - Buffer pooling system for responses
   - String interning for HTTP methods and headers
   - Pre-compiled response templates

### Migration Checklist

#### Pre-Migration

- [ ] **Audit current application** - Document all routes, middleware, and dependencies
- [ ] **Choose validation library** - Select from Zod, Joi, Yup, or Class Validator
- [ ] **Plan authentication strategy** - Decide on Auth.js providers and configuration
- [ ] **Select deployment target** - Choose from Node.js, Vercel Edge, AWS Lambda, or Cloudflare Workers

#### Core Migration

- [ ] **Replace framework initialization** - Update app creation and configuration
- [ ] **Convert routes to MoroJS syntax** - Use chainable API with automatic ordering
- [ ] **Replace validation with chosen library** - Convert existing validation to MoroJS format
- [ ] **Update middleware configuration** - Use built-in middleware or convert custom middleware
- [ ] **Convert modules/plugins** - Use MoroJS module system or convert existing plugins

#### Advanced Features

- [ ] **Set up authentication** - Configure Auth.js with chosen providers
- [ ] **Configure database integration** - Set up database adapters if needed
- [ ] **Set up WebSocket support** - Configure WebSocket adapters if needed
- [ ] **Configure event system** - Set up event bus for microservices if needed
- [ ] **Set up configuration system** - Create moro.config.js file

#### Testing and Deployment

- [ ] **Update tests** - Convert tests to work with MoroJS patterns
- [ ] **Performance testing** - Benchmark against previous implementation
- [ ] **Deploy to target runtime** - Deploy using appropriate MoroJS runtime adapter
- [ ] **Monitor and optimize** - Use built-in performance features and monitoring

#### Post-Migration

- [ ] **Verify all functionality** - Ensure all features work as expected
- [ ] **Update documentation** - Update API documentation and team guides
- [ ] **Train team** - Ensure team understands MoroJS patterns and best practices
- [ ] **Plan future enhancements** - Leverage MoroJS advanced features for new functionality

### Current Version: 1.5.3

This migration guide is updated for MoroJS v1.5.3, which includes:

- **Universal Validation System** - Support for Zod, Joi, Yup, and Class Validator (all optional peer dependencies)
- **Enterprise Authentication** - Complete Auth.js integration with native adapter
- **Multi-Runtime Support** - Deploy to Node.js, Vercel Edge, AWS Lambda, Cloudflare Workers
- **Performance Optimizations** - 55% faster logging, object pooling, buffer management
- **WebSocket Support** - Socket.IO and native WebSocket adapters
- **Database Integration** - MySQL, PostgreSQL, MongoDB, Redis adapters
- **Module System** - Functional module architecture with auto-discovery
- **Event System** - Enterprise-grade event bus for microservices
- **Configuration System** - Flexible configuration with multiple sources
- **Intelligent Routing** - Automatic middleware ordering and optimization

### Recent Improvements (v1.5.x)

- **v1.5.3** - Major logger performance optimizations and Jest cleanup
- **v1.5.2** - Fixed clustering configuration isolation issues
- **v1.5.1** - Memory leak fixes and ES2022 optimizations
- **v1.5.0** - Universal validation system with zero dependencies

### Need Help?

- Check the [Examples Repository](https://github.com/Moro-JS/examples) for real migration examples
- See [Performance Guide](./PERFORMANCE.md) for optimization tips
- Join our [Discord Community](https://morojs.com/discord) for migration support
- Read the [API Reference](./API.md) for detailed technical documentation
