# Getting Started with MoroJS

Welcome to MoroJS! This guide will help you get up and running with the high-performance Node.js framework that features intelligent routing, automatic middleware ordering, and type-safe validation.

## Table of Contents

- [Installation](#installation)
- [Your First Application](#your-first-application)
- [Multi-Runtime Deployment](#multi-runtime-deployment)
- [Core Concepts](#core-concepts)
- [Configuration](#configuration)
- [Building a REST API](#building-a-rest-api)
- [Working with Modules](#working-with-modules)
- [Adding Validation](#adding-validation)
- [Database Integration](#database-integration)
- [WebSocket Support](#websocket-support)
- [Testing Your Application](#testing-your-application)
- [Next Steps](#next-steps)

## Installation

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn package manager

### Create a New Project

```bash
mkdir my-moro-app
cd my-moro-app
npm init -y
```

### Install MoroJS

```bash
npm install @morojs/moro
npm install -D @types/node typescript tsx
```

**Note:** MoroJS has zero core dependencies! All validation libraries (Zod, Joi, Yup, Class Validator) are optional peer dependencies. Install only what you need:

```bash
# Optional: Install validation libraries as needed
npm install zod          # For Zod validation
npm install joi          # For Joi validation
npm install yup          # For Yup validation
npm install class-validator class-transformer  # For Class Validator
```

### Setup TypeScript

Create a `tsconfig.json` file:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Add scripts to your `package.json`:

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  }
}
```

## Your First Application

Create `src/server.ts`:

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

// Simple route
app.get('/', (req, res) => {
  return {
    message: 'Hello from MoroJS!',
    timestamp: new Date().toISOString(),
    framework: 'MoroJS',
  };
});

// Health check endpoint
app.get('/health', (req, res) => {
  return {
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`MoroJS server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
```

## Multi-Runtime Deployment

MoroJS applications can run on multiple environments with the same codebase. Here's how to deploy to different runtimes:

### Node.js (Default)

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

app.get('/', (req, res) => {
  return { message: 'Hello from Node.js!' };
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

### Vercel Edge Functions

Create `api/[...slug].ts`:

```typescript
import { createAppEdge } from '@morojs/moro';

const app = createAppEdge();

app.get('/api/hello', (req, res) => {
  return {
    message: 'Hello from Vercel Edge!',
    region: process.env.VERCEL_REGION,
  };
});

export default app.getHandler();
```

### AWS Lambda

```typescript
import { createAppLambda } from '@morojs/moro';

const app = createAppLambda();

app.get('/api/users/:id', (req, res) => {
  return {
    userId: req.params.id,
    lambda: true,
    region: process.env.AWS_REGION,
  };
});

export const handler = app.getHandler();
```

### Cloudflare Workers

Create `worker.ts`:

```typescript
import { createAppWorker } from '@morojs/moro';

const app = createAppWorker();

app.get('/api/geo', (req, res) => {
  return {
    country: req.headers['cf-ipcountry'],
    ray: req.headers['cf-ray'],
    worker: true,
  };
});

export default {
  async fetch(request: Request, env: any, ctx: any) {
    return app.getHandler()(request, env, ctx);
  },
};
```

### Run Your Application

```bash
npm run dev
```

Visit `http://localhost:3000` to see your application running!

## Core Concepts

### 1. Intelligent Routing

MoroJS features intelligent routing that automatically orders middleware execution:

```typescript
import { createApp, z } from '@morojs/moro';

const app = createApp();

// Chainable API - order doesn't matter!
app
  .post('/users')
  .body(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    })
  )
  .rateLimit({ requests: 10, window: 60000 })
  .cache({ ttl: 300 })
  .handler(async (req, res) => {
    // req.body is fully typed and validated
    return { success: true, user: req.body };
  });
```

### 2. Automatic Middleware Ordering

MoroJS automatically executes middleware in the optimal order:

1. **Security** (CORS, Helmet)
2. **Parsing** (Body, Query)
3. **Rate Limiting**
4. **Authentication**
5. **Validation**
6. **Caching**
7. **Handler**

### 3. Type-Safe Validation

Built-in Zod integration provides runtime validation with TypeScript types:

```typescript
const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
  age: z.number().min(18).optional(),
});

type User = z.infer<typeof UserSchema>; // Automatic TypeScript type!
```

## Configuration

MoroJS supports flexible configuration through config files, environment variables, or both. Let's set up configuration for your application.

### Create a Configuration File

Create a `moro.config.js` file in your project root:

```javascript
// moro.config.js
module.exports = {
  server: {
    port: 3000,
    host: 'localhost',
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
    rateLimit: {
      enabled: true,
      requests: 100,
      window: 60000,
    },
  },
  performance: {
    compression: {
      enabled: true,
    },
    cache: {
      enabled: true,
      adapter: 'memory',
      ttl: 300,
    },
  },
};
```

### Using Environment Variables

Create a `.env` file for environment-specific settings:

```bash
# .env
NODE_ENV=development
PORT=3000
HOST=localhost

# Database
DATABASE_TYPE=sqlite
DATABASE_PATH=./dev.db

# Logging
LOG_LEVEL=debug

# Security
CORS_ORIGIN=http://localhost:3000,http://localhost:5173
```

### Update Your Application

Modify your `src/server.ts` to use the configuration:

```typescript
import { createApp } from '@morojs/moro';

const app = createApp();

// Configuration is automatically loaded from moro.config.js and .env
const config = app.getConfig();

// Simple route that uses configuration
app.get('/', (req, res) => {
  return {
    message: 'Hello from MoroJS!',
    timestamp: new Date().toISOString(),
    framework: 'MoroJS',
    environment: config.server.environment,
    port: config.server.port,
  };
});

// Health check endpoint
app.get('/health', (req, res) => {
  return {
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    config: {
      environment: config.server.environment,
      database: config.database.type,
    },
  };
});

// Use configuration for server startup
const PORT = config.server.port;
const HOST = config.server.host;

app.listen(PORT, HOST, () => {
  console.log(`MoroJS server running on http://${HOST}:${PORT}`);
  console.log(`Environment: ${config.server.environment}`);
  console.log(`Database: ${config.database.type}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
});
```

### Environment-Specific Configuration

For different environments, you can create conditional configurations:

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

const configs = {
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
    },
    logging: {
      level: 'info',
      format: 'json',
    },
  },
};

module.exports = configs[environment];
```

### TypeScript Configuration

For TypeScript projects, you can create a `moro.config.ts` file:

```typescript
// moro.config.ts
import type { AppConfig, DeepPartial } from '@morojs/moro';

const config: DeepPartial<AppConfig> = {
  server: {
    port: 3000,
  },
  database: {
    sqlite: {
      filename: './dev.db',
    },
  },
  logging: {
    level: 'debug',
  },
};

export default config;
```

**Note:** Use `DeepPartial<AppConfig>` for proper nested type support.

### Configuration Priority

MoroJS loads configuration in this priority order:

1. **Environment Variables** (highest priority)
2. **Configuration File** (`moro.config.js` or `moro.config.ts`)
3. **Schema Defaults** (lowest priority)

This means you can set defaults in your config file and override them with environment variables for different deployments.

## Building a REST API

Let's build a complete REST API for managing users:

```typescript
import { createApp, z } from '@morojs/moro';

const app = createApp({
  cors: true,
  compression: true,
  helmet: true,
});

// In-memory storage for demo
let users: any[] = [
  { id: 1, name: 'John Doe', email: 'john@example.com' },
  { id: 2, name: 'Jane Smith', email: 'jane@example.com' },
];
let nextId = 3;

// Validation schemas
const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
});

const UpdateUserSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  email: z.string().email().optional(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().optional(),
});

// GET /users - List users with pagination
app
  .get('/users')
  .query(PaginationSchema)
  .cache({ ttl: 60 })
  .handler(async (req, res) => {
    const { page, limit, search } = req.query;

    let filteredUsers = users;
    if (search) {
      filteredUsers = users.filter(
        user =>
          user.name.toLowerCase().includes(search.toLowerCase()) ||
          user.email.toLowerCase().includes(search.toLowerCase())
      );
    }

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedUsers = filteredUsers.slice(startIndex, endIndex);

    return {
      success: true,
      data: paginatedUsers,
      pagination: {
        page,
        limit,
        total: filteredUsers.length,
        pages: Math.ceil(filteredUsers.length / limit),
      },
    };
  });

// GET /users/:id - Get user by ID
app
  .get('/users/:id')
  .params(z.object({ id: z.coerce.number() }))
  .cache({ ttl: 300 })
  .handler(async (req, res) => {
    const user = users.find(u => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    return { success: true, data: user };
  });

// POST /users - Create new user
app
  .post('/users')
  .body(UserSchema)
  .rateLimit({ requests: 10, window: 60000 })
  .handler(async (req, res) => {
    // Check if email already exists
    const existingUser = users.find(u => u.email === req.body.email);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Email already exists',
      });
    }

    const newUser = {
      id: nextId++,
      ...req.body,
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);

    return {
      success: true,
      data: newUser,
      message: 'User created successfully',
    };
  });

// PUT /users/:id - Update user
app
  .put('/users/:id')
  .params(z.object({ id: z.coerce.number() }))
  .body(UpdateUserSchema)
  .handler(async (req, res) => {
    const userIndex = users.findIndex(u => u.id === req.params.id);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Check if email already exists (if being updated)
    if (req.body.email) {
      const existingUser = users.find(u => u.email === req.body.email && u.id !== req.params.id);
      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: 'Email already exists',
        });
      }
    }

    users[userIndex] = {
      ...users[userIndex],
      ...req.body,
      updatedAt: new Date().toISOString(),
    };

    return {
      success: true,
      data: users[userIndex],
      message: 'User updated successfully',
    };
  });

// DELETE /users/:id - Delete user
app
  .delete('/users/:id')
  .params(z.object({ id: z.coerce.number() }))
  .handler(async (req, res) => {
    const userIndex = users.findIndex(u => u.id === req.params.id);

    if (userIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const deletedUser = users.splice(userIndex, 1)[0];

    return {
      success: true,
      data: deletedUser,
      message: 'User deleted successfully',
    };
  });

app.listen(3000, () => {
  console.log('REST API server running on http://localhost:3000');
  console.log('Try these endpoints:');
  console.log('  GET    http://localhost:3000/users');
  console.log('  GET    http://localhost:3000/users/1');
  console.log('  POST   http://localhost:3000/users');
  console.log('  PUT    http://localhost:3000/users/1');
  console.log('  DELETE http://localhost:3000/users/1');
});
```

### Test Your API

```bash
# Get all users
curl http://localhost:3000/users

# Get user by ID
curl http://localhost:3000/users/1

# Create a new user
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice Johnson", "email": "alice@example.com"}'

# Update a user
curl -X PUT http://localhost:3000/users/1 \
  -H "Content-Type: application/json" \
  -d '{"name": "John Updated"}'

# Delete a user
curl -X DELETE http://localhost:3000/users/1
```

## Working with Modules

Modules provide a way to organize your application into reusable components:

### Create a Users Module

Create `src/modules/users/index.ts`:

```typescript
import { defineModule, z } from '@morojs/moro';

const UserSchema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
});

const PaginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
});

export default defineModule({
  name: 'users',
  version: '1.0.0',
  routes: [
    {
      method: 'GET',
      path: '/users',
      validation: { query: PaginationSchema },
      cache: { ttl: 60 },
      description: 'Get users with pagination',
      tags: ['users', 'list'],
      handler: async (req, res) => {
        // Your user fetching logic here
        return {
          success: true,
          data: [],
          pagination: req.query,
        };
      },
    },
    {
      method: 'POST',
      path: '/users',
      validation: { body: UserSchema },
      rateLimit: { requests: 10, window: 60000 },
      description: 'Create a new user',
      tags: ['users', 'create'],
      handler: async (req, res) => {
        // Your user creation logic here
        return {
          success: true,
          data: req.body,
        };
      },
    },
  ],
  sockets: [
    {
      event: 'user-status',
      validation: z.object({
        userId: z.string(),
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

### Use the Module

Update `src/server.ts`:

```typescript
import { createApp } from '@morojs/moro';
import UsersModule from './modules/users';

const app = createApp();

// Load the users module
await app.loadModule(UsersModule);

app.listen(3000, () => {
  console.log('Server with modules running on http://localhost:3000');
  console.log('Module routes available at /api/v1.0.0/users/');
});
```

## Adding Validation

MoroJS uses Zod for powerful validation:

### Basic Validation

```typescript
import { z } from '@morojs/moro';

// Simple validation
const userSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email format'),
  age: z.number().min(18, 'Must be 18 or older').optional(),
});

app
  .post('/users')
  .body(userSchema)
  .handler(async (req, res) => {
    // req.body is typed and validated
    return { user: req.body };
  });
```

### Advanced Validation

```typescript
// Complex validation with custom rules
const registrationSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(20, 'Username must be less than 20 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),

    email: z.string().email('Invalid email format'),

    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
        'Password must contain at least one lowercase letter, one uppercase letter, and one number'
      ),

    confirmPassword: z.string(),

    profile: z.object({
      firstName: z.string().min(1, 'First name is required'),
      lastName: z.string().min(1, 'Last name is required'),
      bio: z.string().max(500, 'Bio must be less than 500 characters').optional(),
      tags: z.array(z.string()).max(5, 'Maximum 5 tags allowed').default([]),
    }),

    preferences: z.object({
      newsletter: z.boolean().default(false),
      notifications: z.boolean().default(true),
      theme: z.enum(['light', 'dark']).default('light'),
    }),
  })
  .refine(data => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

app
  .post('/register')
  .body(registrationSchema)
  .handler(async (req, res) => {
    // All validation passed, req.body is fully typed
    const { confirmPassword, ...userData } = req.body;
    return { success: true, user: userData };
  });
```

### Query Parameter Validation

```typescript
const searchSchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  category: z.enum(['users', 'posts', 'comments']).optional(),
  sort: z.enum(['relevance', 'date', 'popularity']).default('relevance'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  includeInactive: z.coerce.boolean().default(false),
});

app
  .get('/search')
  .query(searchSchema)
  .handler(async (req, res) => {
    const { q, category, sort, page, limit, includeInactive } = req.query;
    // All parameters are validated and typed
    return {
      results: [],
      query: { q, category, sort, page, limit, includeInactive },
    };
  });
```

## Database Integration

### MySQL Example

```bash
npm install mysql2
```

```typescript
import { createApp, MySQLAdapter } from '@morojs/moro';

const app = createApp();

// Setup database
const db = new MySQLAdapter({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'myapp',
});

app.database(db);

// Use database in routes
app.get('/users').handler(async (req, res) => {
  const users = await req.database.query('SELECT * FROM users');
  return { success: true, data: users };
});

app
  .post('/users')
  .body(UserSchema)
  .handler(async (req, res) => {
    const result = await req.database.query('INSERT INTO users (name, email) VALUES (?, ?)', [
      req.body.name,
      req.body.email,
    ]);

    return {
      success: true,
      data: { id: result.insertId, ...req.body },
    };
  });
```

### With Transactions

```typescript
app
  .post('/transfer')
  .body(TransferSchema)
  .handler(async (req, res) => {
    const transaction = await req.database.beginTransaction();

    try {
      // Debit from source account
      await transaction.query('UPDATE accounts SET balance = balance - ? WHERE id = ?', [
        req.body.amount,
        req.body.fromAccount,
      ]);

      // Credit to destination account
      await transaction.query('UPDATE accounts SET balance = balance + ? WHERE id = ?', [
        req.body.amount,
        req.body.toAccount,
      ]);

      // Record transaction
      await transaction.query(
        'INSERT INTO transactions (from_account, to_account, amount) VALUES (?, ?, ?)',
        [req.body.fromAccount, req.body.toAccount, req.body.amount]
      );

      await transaction.commit();
      return { success: true, message: 'Transfer completed' };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
```

## WebSocket Support

Add real-time functionality to your application:

```typescript
import { createApp, z } from '@morojs/moro';

const app = createApp();

// WebSocket with validation
app.websocket('/chat', {
  // Connection event
  connection: socket => {
    console.log(`User connected: ${socket.id}`);
    socket.emit('welcome', { message: 'Welcome to the chat!' });
  },

  // Join room event
  'join-room': {
    validation: z.object({
      room: z.string().min(1),
      username: z.string().min(2),
    }),
    handler: (socket, data) => {
      socket.join(data.room);
      socket.username = data.username;
      socket.currentRoom = data.room;

      socket.to(data.room).emit('user-joined', {
        username: data.username,
        message: `${data.username} joined the room`,
        timestamp: new Date(),
      });

      return { success: true, room: data.room };
    },
  },

  // Send message event
  'send-message': {
    validation: z.object({
      message: z.string().min(1).max(500),
      room: z.string(),
    }),
    rateLimit: { requests: 10, window: 60000 },
    handler: (socket, data) => {
      socket.to(data.room).emit('new-message', {
        username: socket.username,
        message: data.message,
        room: data.room,
        timestamp: new Date(),
      });

      return { success: true };
    },
  },

  // Disconnect event
  disconnect: socket => {
    if (socket.currentRoom && socket.username) {
      socket.to(socket.currentRoom).emit('user-left', {
        username: socket.username,
        message: `${socket.username} left the room`,
        timestamp: new Date(),
      });
    }
    console.log(`User disconnected: ${socket.id}`);
  },
});

app.listen(3000, () => {
  console.log('Server with WebSocket running on http://localhost:3000');
  console.log('🔌 WebSocket available at ws://localhost:3000/chat');
});
```

### Client-Side WebSocket Usage

```html
<!DOCTYPE html>
<html>
  <head>
    <title>MoroJS Chat</title>
    <script src="/socket.io/socket.io.js"></script>
  </head>
  <body>
    <div id="messages"></div>
    <input type="text" id="messageInput" placeholder="Type a message..." />
    <button onclick="sendMessage()">Send</button>

    <script>
      const socket = io('/chat');

      // Join a room
      socket.emit('join-room', {
        room: 'general',
        username: 'User' + Math.floor(Math.random() * 1000),
      });

      // Listen for messages
      socket.on('new-message', data => {
        const messages = document.getElementById('messages');
        messages.innerHTML += `<div><strong>${data.username}:</strong> ${data.message}</div>`;
      });

      // Send message
      function sendMessage() {
        const input = document.getElementById('messageInput');
        socket.emit('send-message', {
          message: input.value,
          room: 'general',
        });
        input.value = '';
      }
    </script>
  </body>
</html>
```

## Testing Your Application

### Setup Testing

```bash
npm install -D jest @types/jest supertest @types/supertest ts-jest
```

Create `jest.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
```

### Write Tests

Create `tests/app.test.ts`:

```typescript
import request from 'supertest';
import { createApp, z } from '@morojs/moro';

describe('MoroJS Application', () => {
  let app: any;
  let server: any;

  beforeAll(() => {
    app = createApp();

    app.get('/test', () => ({ message: 'Hello Test!' }));

    app
      .post('/users')
      .body(
        z.object({
          name: z.string().min(2),
          email: z.string().email(),
        })
      )
      .handler(async (req: any) => {
        return { success: true, user: req.body };
      });

    server = app.core.listen(0); // Use random port
  });

  afterAll(() => {
    server.close();
  });

  it('should respond to GET /test', async () => {
    const response = await request(server).get('/test').expect(200);

    expect(response.body).toEqual({ message: 'Hello Test!' });
  });

  it('should validate POST /users', async () => {
    const validUser = { name: 'John Doe', email: 'john@example.com' };

    const response = await request(server).post('/users').send(validUser).expect(200);

    expect(response.body).toEqual({
      success: true,
      user: validUser,
    });
  });

  it('should reject invalid user data', async () => {
    const invalidUser = { name: 'J', email: 'invalid-email' };

    await request(server).post('/users').send(invalidUser).expect(400);
  });
});
```

### Run Tests

```bash
npm test
```

## Next Steps

Congratulations! You've learned the basics of MoroJS. Here are some next steps:

### 1. Explore Advanced Features

- [API Documentation](../API.md) - Complete API reference
- [Module System](./MODULES.md) - Advanced module patterns
- [Database Adapters](./DATABASE.md) - Working with different databases
- [Authentication](./AUTHENTICATION.md) - User authentication and authorization
- [Caching Strategies](./CACHING.md) - Performance optimization
- [Deployment](./DEPLOYMENT.md) - Production deployment guide

### 2. Example Applications

Check out the [examples repository](https://github.com/Moro-JS/examples) for:

- Enterprise applications
- Microservices architecture
- Real-time chat applications
- E-commerce APIs
- Authentication systems

### 3. Community and Support

- [GitHub Repository](https://github.com/Moro-JS/moro)
- [Discord Community](https://morojs.com/discord)
- [Stack Overflow](https://stackoverflow.com/questions/tagged/morojs)
- [Documentation](https://morojs.com)

### 4. Contributing

MoroJS is open source! Contributions are welcome:

- [Contributing Guide](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Development Setup](../DEVELOPMENT.md)

Happy coding with MoroJS!
