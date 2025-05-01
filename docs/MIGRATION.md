# Migration Guide

Comprehensive guide for migrating to MoroJS from other frameworks.

## Table of Contents

- [From Express.js](#from-expressjs)
- [From Fastify](#from-fastify)
- [From NestJS](#from-nestjs)
- [From Koa](#from-koa)
- [Common Migration Patterns](#common-migration-patterns)
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
import { createApp, z } from 'moro';
const app = createApp();

app.post('/users')
   .body(z.object({                 // Automatic validation + TypeScript types
     name: z.string().min(2),
     email: z.string().email()
   }))
   .rateLimit({ requests: 10, window: 60000 })  // Order doesn't matter!
   .handler(createUser);            // Framework handles optimal ordering
```

### Migration Steps

1. **Replace Express app creation:**
   ```typescript
   // Before
   const express = require('express');
   const app = express();
   
   // After
   import { createApp } from 'moro';
   const app = createApp();
   ```

2. **Convert middleware to chainable API:**
   ```typescript
   // Before
   app.use(cors());
   app.use(helmet());
   app.use(rateLimit(config));
   app.post('/users', validate(schema), handler);
   
   // After
   app.post('/users')
     .body(schema)
     .rateLimit(config)
     .handler(handler);
   // CORS and helmet are enabled by default
   ```

3. **Replace custom validation with Zod:**
   ```typescript
   // Before
   const { body, validationResult } = require('express-validator');
   
   app.post('/users', [
     body('name').isLength({ min: 2 }),
     body('email').isEmail()
   ], (req, res) => {
     const errors = validationResult(req);
     if (!errors.isEmpty()) {
       return res.status(400).json({ errors: errors.array() });
     }
     // Handle valid request
   });
   
   // After
   app.post('/users')
     .body(z.object({
       name: z.string().min(2),
       email: z.string().email()
     }))
     .handler((req, res) => {
       // req.body is automatically validated and typed!
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
        email: { type: 'string', format: 'email' }
      }
    }
  },
  preHandler: [rateLimit, auth],     // Manual ordering required
  handler: createUser
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
app.post('/users')
   .body(z.object({
     name: z.string().min(2),       // Better TypeScript integration
     email: z.string().email()
   }))
   .rateLimit({ requests: 10, window: 60000 })
   .auth({ roles: ['user'] })      // Automatic optimal ordering
   .handler(createUser);
```

### Migration Steps

1. **Replace Fastify app creation:**
   ```typescript
   // Before
   const fastify = require('fastify')({ logger: true });
   
   // After
   import { createApp } from 'moro';
   const app = createApp({ logging: true });
   ```

2. **Convert JSON Schema to Zod:**
   ```typescript
   // Before
   const userSchema = {
     body: {
       type: 'object',
       required: ['name', 'email'],
       properties: {
         name: { type: 'string', minLength: 2, maxLength: 50 },
         email: { type: 'string', format: 'email' },
         age: { type: 'number', minimum: 18 }
       }
     }
   };
   
   // After
   const userSchema = z.object({
     name: z.string().min(2).max(50),
     email: z.string().email(),
     age: z.number().min(18).optional()
   });
   ```

3. **Convert route definitions:**
   ```typescript
   // Before
   fastify.post('/users', {
     schema: userSchema,
     preHandler: [authenticate, rateLimit],
     handler: async (request, reply) => {
       return { user: request.body };
     }
   });
   
   // After
   app.post('/users')
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
app.post('/users')
   .body(CreateUserSchema)          // Direct Zod schema
   .auth({ roles: ['user'] })       // No guards needed
   .rateLimit({ requests: 10, window: 60000 })  // No interceptors
   .handler(async (req, res) => {   // Pure function
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
   import { createApp } from 'moro';
   
   const app = createApp();
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
   app.get('/users')
     .query(GetUsersSchema)
     .handler(async (req, res) => {
       return { users: await findAllUsers(req.query) };
     });
   
   app.post('/users')
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
     age: z.number().int().min(18).optional()
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
   app.get('/protected')
     .auth({ 
       required: true,
       validator: (req) => validateUser(req.headers.authorization)
     })
     .handler(protectedHandler);
   ```

5. **Convert modules to MoroJS modules:**
   ```typescript
   // Before
   @Module({
     controllers: [UsersController],
     providers: [UsersService],
     exports: [UsersService]
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
         handler: getUsersHandler
       },
       {
         method: 'POST',
         path: '/users',
         validation: { body: CreateUserSchema },
         handler: createUserHandler
       }
     ]
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

router.post('/users', async (ctx) => {
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
app.post('/users')
   .body(z.object({
     name: z.string().min(2),
     email: z.string().email()
   }))
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
   import { createApp } from 'moro';
   const app = createApp();
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
   
   router.get('/users', async (ctx) => {
     ctx.body = { users: await getUsers() };
   });
   
   // After
   app.get('/users', async (req, res) => {
     return { users: await getUsers() };
   });
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
router.get('/users', (ctx) => {
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
app.post('/users')
  .body(z.object({
    name: z.string().min(2),
    email: z.string().email()
  }))
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
const app = createApp({
  cors: true,
  helmet: true,
  rateLimit: config
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
import { MySQLAdapter } from 'moro';
const db = new MySQLAdapter(config);
app.database(db);

app.get('/users', async (req, res) => {
  const users = await req.database.query('SELECT * FROM users');
  return { users };
});
```

---

## Performance Improvements

### Expected Performance Gains

| Migration From | Req/sec Improvement | Latency Improvement | Memory Improvement |
|----------------|-------------------|-------------------|-------------------|
| Express        | **+84%** (28,540 → 52,400) | **-53%** (3.8ms → 1.8ms) | **-47%** (45MB → 24MB) |
| Fastify        | **+37%** (38,120 → 52,400) | **-38%** (2.9ms → 1.8ms) | **-31%** (35MB → 24MB) |
| NestJS         | **+137%** (22,100 → 52,400) | **-60%** (4.5ms → 1.8ms) | **-59%** (58MB → 24MB) |
| Koa            | **+102%** (25,880 → 52,400) | **-57%** (4.2ms → 1.8ms) | **-43%** (42MB → 24MB) |

### Performance Features You Get

1. **Optimized Middleware Execution**
   - Intelligent ordering eliminates unnecessary middleware calls
   - Phase-based execution reduces overhead

2. **Faster Validation**
   - Zod is 2-3x faster than JSON Schema validation
   - Compile-time optimizations

3. **Runtime Optimizations**
   - Runtime-specific adapters for optimal performance
   - Memory-efficient request/response handling

4. **Built-in Performance Features**
   - Circuit breakers for external calls
   - Intelligent caching strategies
   - Connection pooling

### Migration Checklist

- [ ] Replace framework initialization
- [ ] Convert routes to MoroJS syntax
- [ ] Replace validation with Zod schemas
- [ ] Update middleware configuration
- [ ] Convert modules/plugins
- [ ] Update tests
- [ ] Performance testing
- [ ] Deploy and monitor

### Need Help?

- Check the [Examples Repository](https://github.com/MoroJS/examples) for real migration examples
- See [Performance Guide](./PERFORMANCE.md) for optimization tips
- Join our community for migration support 