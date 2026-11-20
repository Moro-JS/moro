# Testing Guide for MoroJS

This guide covers comprehensive testing strategies for MoroJS applications, including unit tests, integration tests, and end-to-end tests.

## Table of Contents

- [Testing Philosophy](#testing-philosophy)
- [Setup and Configuration](#setup-and-configuration)
- [Unit Testing](#unit-testing)
- [Integration Testing](#integration-testing)
- [End-to-End Testing](#end-to-end-testing)
- [Testing Modules](#testing-modules)
- [Testing WebSocket](#testing-websocket)
- [Testing Database Integration](#testing-database-integration)
- [Mocking and Stubbing](#mocking-and-stubbing)
- [Testing Best Practices](#testing-best-practices)
- [CI/CD Integration](#cicd-integration)

## Testing Philosophy

MoroJS promotes a comprehensive testing approach:

- **Unit Tests**: Test individual functions and components in isolation
- **Integration Tests**: Test how different parts work together
- **End-to-End Tests**: Test complete user workflows
- **Contract Tests**: Test API contracts and module interfaces

### Testing Pyramid

```
    /\
   /  \     E2E Tests (Few, Slow, High Confidence)
  /____\
 /      \   Integration Tests (Some, Medium Speed)
/________\  Unit Tests (Many, Fast, Low-Level)
```

## Setup and Configuration

### Install Testing Dependencies

```bash
npm install -D jest @types/jest supertest @types/supertest ts-jest
```

### Jest Configuration

Create `jest.config.js`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts', '**/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.test.ts', '!src/**/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 10000,
};
```

### Test Setup File

Create `tests/setup.ts`:

```typescript
// Global test setup
jest.setTimeout(10000);

// Mock console methods for cleaner test output
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

// Test utilities
export const createTestPort = () => 3000 + Math.floor(Math.random() * 1000);
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

### Package.json Scripts

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "test:unit": "jest --testPathPattern=unit",
    "test:integration": "jest --testPathPattern=integration",
    "test:e2e": "jest --testPathPattern=e2e"
  }
}
```

## Unit Testing

Unit tests focus on testing individual components in isolation.

### Testing Validation

```typescript
// tests/unit/validation.test.ts
import { validate, body, query, z } from '../../src/core/validation';

describe('Validation System', () => {
  const mockRequest = (data: any) =>
    ({
      body: data.body || {},
      query: data.query || {},
      params: data.params || {},
      headers: data.headers || {},
    }) as any;

  const mockResponse = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      headersSent: false,
    };
    return res as any;
  };

  describe('body validation', () => {
    it('should validate valid data', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const handler = jest.fn().mockResolvedValue({ success: true });
      const wrappedHandler = validate({ body: schema }, handler);

      const req = mockRequest({
        body: { name: 'John Doe', email: 'john@example.com' },
      });
      const res = mockResponse();

      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { name: 'John Doe', email: 'john@example.com' },
        }),
        res
      );
    });

    it('should reject invalid data', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const handler = jest.fn();
      const wrappedHandler = validate({ body: schema }, handler);

      const req = mockRequest({
        body: { name: 'J', email: 'invalid-email' },
      });
      const res = mockResponse();

      await wrappedHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Validation failed for body',
        })
      );
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('query validation', () => {
    it('should validate and coerce query parameters', async () => {
      const schema = z.object({
        limit: z.coerce.number().min(1).max(100).default(10),
        search: z.string().optional(),
      });

      const handler = jest.fn().mockResolvedValue({ success: true });
      const wrappedHandler = validate({ query: schema }, handler);

      const req = mockRequest({
        query: { limit: '25', search: 'test' },
      });
      const res = mockResponse();

      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: { limit: 25, search: 'test' },
        }),
        res
      );
    });
  });

  describe('convenience functions', () => {
    it('body() should create body validation wrapper', async () => {
      const schema = z.object({ name: z.string() });
      const handler = jest.fn().mockResolvedValue({ success: true });

      const wrappedHandler = body(schema)(handler);

      const req = mockRequest({ body: { name: 'John' } });
      const res = mockResponse();

      await wrappedHandler(req, res);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ body: { name: 'John' } }),
        res
      );
    });
  });
});
```

### Testing Route Builders

```typescript
// tests/unit/routing.test.ts
import { IntelligentRouteBuilder, z } from '../../src';

describe('Intelligent Routing', () => {
  describe('RouteBuilder', () => {
    it('should create a route builder', () => {
      const builder = new IntelligentRouteBuilder('GET', '/test');
      expect(builder).toBeInstanceOf(IntelligentRouteBuilder);
    });

    it('should chain validation methods', () => {
      const bodySchema = z.object({ name: z.string() });
      const querySchema = z.object({ limit: z.number() });

      const builder = new IntelligentRouteBuilder('POST', '/users')
        .body(bodySchema)
        .query(querySchema)
        .rateLimit({ requests: 10, window: 60000 })
        .cache({ ttl: 300 });

      expect(builder).toBeInstanceOf(IntelligentRouteBuilder);
    });

    it('should build a complete route', () => {
      const handler = jest.fn().mockResolvedValue({ success: true });
      const schema = z.object({ name: z.string() });

      const route = new IntelligentRouteBuilder('POST', '/users')
        .body(schema)
        .auth({ roles: ['user'] })
        .rateLimit({ requests: 5, window: 60000 })
        .handler(handler);

      expect(route).toBeDefined();
      expect(route.schema.method).toBe('POST');
      expect(route.schema.path).toBe('/users');
    });
  });
});
```

### Testing Modules

```typescript
// tests/unit/modules.test.ts
import { defineModule, z } from '../../src';

describe('Module System', () => {
  describe('defineModule', () => {
    it('should create a module config', () => {
      const definition = {
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'GET' as const,
            path: '/',
            handler: async () => ({ success: true }),
          },
        ],
      };

      const config = defineModule(definition);

      expect(config.name).toBe('test-module');
      expect(config.version).toBe('1.0.0');
      expect(config.routes).toHaveLength(1);
      expect(config.routeHandlers).toHaveProperty('route_handler_0');
    });

    it('should handle modules with validation', () => {
      const userSchema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const definition = {
        name: 'users',
        version: '1.0.0',
        routes: [
          {
            method: 'POST' as const,
            path: '/users',
            validation: { body: userSchema },
            handler: async (req: any) => ({ success: true, data: req.body }),
          },
        ],
      };

      const config = defineModule(definition);

      expect(config.routes![0].validation).toEqual({ body: userSchema });
    });

    it('should handle modules with sockets', () => {
      const definition = {
        name: 'chat',
        version: '1.0.0',
        sockets: [
          {
            event: 'message',
            handler: async () => ({ success: true }),
          },
        ],
      };

      const config = defineModule(definition);

      expect(config.sockets).toHaveLength(1);
      expect(config.socketHandlers).toHaveProperty('socket_handler_0');
    });
  });
});
```

## Integration Testing

Integration tests verify that different parts of your application work together correctly.

### Testing HTTP Routes

```typescript
// tests/integration/routes.test.ts
import request from 'supertest';
import { createApp, z } from '../../src';
import { createTestPort, delay } from '../setup';

describe('HTTP Routes Integration', () => {
  let app: any;
  let port: number;

  beforeEach(async () => {
    app = await createApp();
    port = createTestPort();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Basic Routes', () => {
    it('should handle GET requests', async () => {
      app.get('/test', () => ({ message: 'Hello World' }));

      app.listen(port);
      await delay(100);

      const response = await request(`http://localhost:${port}`).get('/test').expect(200);

      expect(response.body).toEqual({ message: 'Hello World' });
    });

    it('should handle POST requests with body', async () => {
      app.post('/users', (req: any) => ({
        success: true,
        data: req.body,
      }));

      app.listen(port);
      await delay(100);

      const userData = { name: 'John Doe', email: 'john@example.com' };
      const response = await request(`http://localhost:${port}`)
        .post('/users')
        .send(userData)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        data: userData,
      });
    });
  });

  describe('Intelligent Routing', () => {
    it('should validate request data', async () => {
      const userSchema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      app
        .post('/api/users')
        .body(userSchema)
        .handler((req: any) => ({
          success: true,
          user: req.body,
        }));

      app.listen(port);
      await delay(100);

      // Valid data
      const validUser = { name: 'John Doe', email: 'john@example.com' };
      await request(`http://localhost:${port}`).post('/api/users').send(validUser).expect(200);

      // Invalid data
      const invalidUser = { name: 'J', email: 'invalid' };
      await request(`http://localhost:${port}`).post('/api/users').send(invalidUser).expect(400);
    });

    it('should handle query parameter validation', async () => {
      const querySchema = z.object({
        limit: z.coerce.number().min(1).max(100).default(10),
        search: z.string().optional(),
      });

      app
        .get('/api/search')
        .query(querySchema)
        .handler((req: any) => ({
          success: true,
          query: req.query,
        }));

      app.listen(port);
      await delay(100);

      const response = await request(`http://localhost:${port}`)
        .get('/api/search?limit=25&search=test')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        query: { limit: 25, search: 'test' },
      });
    });

    it('should apply rate limiting', async () => {
      app
        .post('/limited')
        .rateLimit({ requests: 2, window: 60000 })
        .handler(() => ({ success: true }));

      app.listen(port);
      await delay(100);

      const baseUrl = `http://localhost:${port}`;

      // First two requests should succeed
      await request(baseUrl).post('/limited').expect(200);
      await request(baseUrl).post('/limited').expect(200);

      // Third request should be rate limited
      await request(baseUrl).post('/limited').expect(429);
    });
  });

  describe('Error Handling', () => {
    it('should handle handler errors', async () => {
      app.get('/error', () => {
        throw new Error('Test error');
      });

      app.listen(port);
      await delay(100);

      const response = await request(`http://localhost:${port}`).get('/error').expect(500);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
    });

    it('should handle 404 for non-existent routes', async () => {
      app.listen(port);
      await delay(100);

      await request(`http://localhost:${port}`).get('/non-existent').expect(404);
    });
  });

  describe('Middleware Integration', () => {
    it('should apply global middleware', async () => {
      let middlewareCalled = false;

      app.use((req: any, res: any, next: () => void) => {
        middlewareCalled = true;
        req.middlewareApplied = true;
        next();
      });

      app.get('/middleware-test', (req: any) => ({
        middlewareApplied: req.middlewareApplied,
        middlewareCalled,
      }));

      app.listen(port);
      await delay(100);

      const response = await request(`http://localhost:${port}`)
        .get('/middleware-test')
        .expect(200);

      expect(response.body.middlewareApplied).toBe(true);
      expect(middlewareCalled).toBe(true);
    });
  });
});
```

### Several Apps in One Test

Every `createApp()` returns an app of its own: its routes, the rate-limit counters and cached responses of those routes, its modules, its documentation and its configuration belong to it alone. A test can therefore run the app under test next to a stand-in for a service it calls, and the apps of one test are not visible to the next.

```typescript
// tests/integration/orders.test.ts
import { createApp } from '../../src';

describe('orders API with a stand-in for the payments service', () => {
  const apps: any[] = [];

  // Listens on a port the operating system picks and returns the app's URL
  const start = async (app: any): Promise<string> => {
    apps.push(app);
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${app.address().port}`;
  };

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it('charges through the payments service', async () => {
    const payments = await createApp({ autoDiscover: false, routing: false });
    payments.post('/charges', () => ({ id: 'ch_1', status: 'succeeded' }));
    const paymentsUrl = await start(payments);

    const api = await createApp({ server: { bodySizeLimit: '100kb' } });
    api.post('/orders', async () => {
      const charge = await fetch(`${paymentsUrl}/charges`, { method: 'POST' });
      return { order: 1, charge: await charge.json() };
    });
    const apiUrl = await start(api);

    const response = await fetch(`${apiUrl}/orders`, { method: 'POST' });
    expect(await response.json()).toEqual({
      order: 1,
      charge: { id: 'ch_1', status: 'succeeded' },
    });

    // Each app answers its own routes only
    expect((await fetch(`${apiUrl}/charges`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${paymentsUrl}/orders`, { method: 'POST' })).status).toBe(404);
  });
});
```

- Close every app a test creates. An app that is left listening keeps its port and goes on answering its own routes.
- The options of a `createApp()` call apply to that app only, and each call reads the environment again, so a test can create apps with different settings one after another without resetting anything in between.
- Register routes on the app (`app.get()`, `app.route()`). `getApp()` and the standalone builders `createRoute()` and `defineRoute()` act on the current app, which with several apps is the one created last that is still open (see [Several apps in one process](./API.md#several-apps-in-one-process)).
- Every app loads the route files under `./src/routes` and discovers modules unless told otherwise, and a route file is evaluated once per process. Give a stand-in `routing: false` and `autoDiscover: false`, as above.
- `app.listen(0)` with `app.address()` avoids choosing ports by hand.

### Testing Module Integration

```typescript
// tests/integration/modules.test.ts
import request from 'supertest';
import { createApp, defineModule, z } from '../../src';
import { createTestPort, delay } from '../setup';

describe('Module Integration', () => {
  let app: any;
  let port: number;

  beforeEach(async () => {
    app = await createApp();
    port = createTestPort();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should load and use modules', async () => {
    const TestModule = defineModule({
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: async () => ({
            success: true,
            module: 'test-module',
          }),
        },
        {
          method: 'POST',
          path: '/validate',
          validation: {
            body: z.object({
              name: z.string().min(2),
              value: z.number(),
            }),
          },
          handler: async (req: any) => ({
            success: true,
            data: req.body,
          }),
        },
      ],
    });

    await app.loadModule(TestModule);
    app.listen(port);
    await delay(100);

    // Test module route
    const response = await request(`http://localhost:${port}`)
      .get('/api/v1.0.0/test-module/test')
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      module: 'test-module',
    });

    // Test module validation
    const validData = { name: 'test', value: 42 };
    const validateResponse = await request(`http://localhost:${port}`)
      .post('/api/v1.0.0/test-module/validate')
      .send(validData)
      .expect(200);

    expect(validateResponse.body).toEqual({
      success: true,
      data: validData,
    });
  });
});
```

## End-to-End Testing

E2E tests verify complete user workflows and application behavior.

### Complete Application Flow

```typescript
// tests/e2e/application.test.ts
import request from 'supertest';
import { createApp, defineModule, z } from '../../src';
import { createTestPort, delay } from '../setup';

describe('End-to-End Application Tests', () => {
  let app: any;
  let port: number;

  beforeEach(async () => {
    app = await createApp();
    port = createTestPort();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should handle complete user workflow', async () => {
    // Mock data store
    const users: any[] = [];
    let nextId = 1;

    // Create users module
    const UsersModule = defineModule({
      name: 'users',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/users',
          validation: {
            query: z.object({
              limit: z.coerce.number().min(1).max(100).default(10),
            }),
          },
          handler: async (req: any) => ({
            success: true,
            data: users.slice(0, req.query.limit),
            total: users.length,
          }),
        },
        {
          method: 'POST',
          path: '/users',
          validation: {
            body: z.object({
              name: z.string().min(2).max(50),
              email: z.string().email(),
            }),
          },
          handler: async (req: any) => {
            const user = {
              id: nextId++,
              ...req.body,
              createdAt: new Date().toISOString(),
            };
            users.push(user);
            return { success: true, data: user };
          },
        },
        {
          method: 'GET',
          path: '/users/:id',
          validation: {
            params: z.object({ id: z.coerce.number() }),
          },
          handler: async (req: any) => {
            const user = users.find(u => u.id === req.params.id);
            if (!user) {
              return { success: false, error: 'User not found' };
            }
            return { success: true, data: user };
          },
        },
      ],
    });

    await app.loadModule(UsersModule);

    // Add health check
    app.get('/health', () => ({ status: 'ok' }));

    app.listen(port);
    await delay(200);

    const baseUrl = `http://localhost:${port}`;

    // 1. Check health
    await request(baseUrl).get('/health').expect(200, { status: 'ok' });

    // 2. Get empty users list
    await request(baseUrl)
      .get('/api/v1.0.0/users/users')
      .expect(200)
      .expect(res => {
        expect(res.body).toEqual({
          success: true,
          data: [],
          total: 0,
        });
      });

    // 3. Create first user
    const user1 = { name: 'John Doe', email: 'john@example.com' };
    const createResponse1 = await request(baseUrl)
      .post('/api/v1.0.0/users/users')
      .send(user1)
      .expect(200);

    expect(createResponse1.body.success).toBe(true);
    expect(createResponse1.body.data).toMatchObject(user1);
    expect(createResponse1.body.data).toHaveProperty('id', 1);

    // 4. Create second user
    const user2 = { name: 'Jane Smith', email: 'jane@example.com' };
    const createResponse2 = await request(baseUrl)
      .post('/api/v1.0.0/users/users')
      .send(user2)
      .expect(200);

    expect(createResponse2.body.data).toHaveProperty('id', 2);

    // 5. Get users list (should have 2 users)
    await request(baseUrl)
      .get('/api/v1.0.0/users/users')
      .expect(200)
      .expect(res => {
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.total).toBe(2);
      });

    // 6. Get specific user
    await request(baseUrl)
      .get('/api/v1.0.0/users/users/1')
      .expect(200)
      .expect(res => {
        expect(res.body.success).toBe(true);
        expect(res.body.data).toMatchObject(user1);
      });

    // 7. Get non-existent user
    await request(baseUrl)
      .get('/api/v1.0.0/users/users/999')
      .expect(200)
      .expect(res => {
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('User not found');
      });

    // 8. Test validation errors
    const invalidUser = { name: 'J', email: 'invalid-email' };
    await request(baseUrl)
      .post('/api/v1.0.0/users/users')
      .send(invalidUser)
      .expect(400)
      .expect(res => {
        expect(res.body.success).toBe(false);
        expect(res.body).toHaveProperty('error');
        expect(res.body).toHaveProperty('details');
      });
  });
});
```

## Testing WebSocket

```typescript
// tests/integration/websocket.test.ts
import { createApp, SocketIOAdapter, z } from '../../src';
import { createTestPort, delay } from '../setup';
import { io, Socket } from 'socket.io-client';

describe('WebSocket Integration', () => {
  let app: any;
  let port: number;
  let clientSocket: Socket;

  beforeEach(async () => {
    // WebSockets are opt-in. This test drives the server with socket.io-client,
    // so it selects the Socket.IO adapter (socket.io must be installed).
    app = await createApp({ websocket: { adapter: new SocketIOAdapter() } });
    port = createTestPort();
  });

  afterEach(async () => {
    if (clientSocket) {
      clientSocket.close();
    }
    await app.close();
  });

  it('should handle WebSocket connections and events', async () => {
    const messages: any[] = [];

    app.websocket('/chat', {
      connection: (socket: any) => {
        socket.emit('welcome', { message: 'Welcome!' });
      },

      // Handlers are plain functions; validate the payload inside them
      'join-room': (socket: any, payload: any) => {
        const data = z
          .object({
            room: z.string().min(1),
            username: z.string().min(2),
          })
          .parse(payload);
        socket.join(data.room);
        socket.username = data.username;
        return { success: true, room: data.room };
      },

      'send-message': (socket: any, payload: any) => {
        const data = z
          .object({
            room: z.string(),
            message: z.string().min(1).max(500),
          })
          .parse(payload);
        messages.push({
          username: socket.username,
          message: data.message,
          room: data.room,
        });
        socket.to(data.room).emit('new-message', {
          username: socket.username,
          message: data.message,
        });
        return { success: true };
      },
    });

    app.listen(port);
    await delay(100);

    // Connect client
    clientSocket = io(`http://localhost:${port}/chat`);

    // Wait for connection
    await new Promise<void>(resolve => {
      clientSocket.on('connect', () => resolve());
    });

    // Test welcome message
    const welcomeMessage = await new Promise(resolve => {
      clientSocket.on('welcome', resolve);
    });
    expect(welcomeMessage).toEqual({ message: 'Welcome!' });

    // Test join room
    const joinResponse = await new Promise(resolve => {
      clientSocket.emit(
        'join-room',
        {
          room: 'test-room',
          username: 'TestUser',
        },
        resolve
      );
    });
    expect(joinResponse).toEqual({ success: true, room: 'test-room' });

    // Test send message
    const messageResponse = await new Promise(resolve => {
      clientSocket.emit(
        'send-message',
        {
          room: 'test-room',
          message: 'Hello World!',
        },
        resolve
      );
    });
    expect(messageResponse).toEqual({ success: true });

    // Check message was stored
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      username: 'TestUser',
      message: 'Hello World!',
      room: 'test-room',
    });
  });

  it('should validate WebSocket data', async () => {
    app.websocket('/chat', {
      // A thrown validation error is sent back as { success: false, error }
      // (its message here; 'Internal server error' when NODE_ENV is 'production')
      'test-event': (socket: any, payload: any) => {
        const data = z
          .object({
            name: z.string().min(2),
            value: z.number(),
          })
          .parse(payload);
        return { success: true, data };
      },
    });

    app.listen(port);
    await delay(100);

    clientSocket = io(`http://localhost:${port}/chat`);

    await new Promise<void>(resolve => {
      clientSocket.on('connect', () => resolve());
    });

    // Test valid data
    const validResponse = await new Promise(resolve => {
      clientSocket.emit(
        'test-event',
        {
          name: 'test',
          value: 42,
        },
        resolve
      );
    });
    expect(validResponse).toEqual({
      success: true,
      data: { name: 'test', value: 42 },
    });

    // Test invalid data
    const invalidResponse = await new Promise(resolve => {
      clientSocket.emit(
        'test-event',
        {
          name: 'x', // Too short
          value: 'not-a-number', // Wrong type
        },
        resolve
      );
    });
    expect(invalidResponse).toHaveProperty('success', false);
  });
});
```

## Testing Database Integration

```typescript
// tests/integration/database.test.ts
import { createApp, z } from '../../src';
import { createTestPort, delay } from '../setup';

// Mock database adapter
class MockDatabaseAdapter {
  private data: Map<string, any[]> = new Map();

  async query(sql: string, params: any[] = []) {
    // Simple mock implementation
    if (sql.includes('SELECT')) {
      return this.data.get('users') || [];
    }
    if (sql.includes('INSERT')) {
      const users = this.data.get('users') || [];
      const newUser = { id: users.length + 1, ...params };
      users.push(newUser);
      this.data.set('users', users);
      return { insertId: newUser.id };
    }
    return { affectedRows: 1 };
  }

  async beginTransaction() {
    return {
      query: this.query.bind(this),
      commit: async () => {},
      rollback: async () => {},
    };
  }
}

describe('Database Integration', () => {
  let app: any;
  let port: number;
  let mockDb: MockDatabaseAdapter;

  beforeEach(async () => {
    app = await createApp();
    port = createTestPort();
    mockDb = new MockDatabaseAdapter();
    app.database(mockDb);
  });

  afterEach(async () => {
    await app.close();
  });

  it('should integrate with database in routes', async () => {
    app.get('/users').handler(async (req: any) => {
      const users = await mockDb.query('SELECT * FROM users');
      return { success: true, data: users };
    });

    app
      .post('/users')
      .body(
        z.object({
          name: z.string(),
          email: z.string().email(),
        })
      )
      .handler(async (req: any) => {
        const result = await mockDb.query('INSERT INTO users (name, email) VALUES (?, ?)', [
          req.body.name,
          req.body.email,
        ]);
        return {
          success: true,
          data: { id: result.insertId, ...req.body },
        };
      });

    app.listen(port);
    await delay(100);

    // Test database integration
    const userData = { name: 'John Doe', email: 'john@example.com' };
    await request(`http://localhost:${port}`)
      .post('/users')
      .send(userData)
      .expect(200)
      .expect(res => {
        expect(res.body.success).toBe(true);
        expect(res.body.data).toMatchObject(userData);
        expect(res.body.data).toHaveProperty('id');
      });

    await request(`http://localhost:${port}`)
      .get('/users')
      .expect(200)
      .expect(res => {
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toMatchObject(userData);
      });
  });
});
```

## Mocking and Stubbing

### Mocking External Services

```typescript
// tests/unit/services.test.ts
import { EmailService } from '../../src/services/email';

// Mock external email service
jest.mock('nodemailer', () => ({
  createTransporter: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  })),
}));

describe('EmailService', () => {
  let emailService: EmailService;

  beforeEach(() => {
    emailService = new EmailService({
      host: 'smtp.test.com',
      port: 587,
      auth: { user: 'test', pass: 'test' },
    });
  });

  it('should send email', async () => {
    const result = await emailService.sendEmail({
      to: 'test@example.com',
      subject: 'Test',
      text: 'Test message',
    });

    expect(result).toHaveProperty('messageId', 'test-id');
  });
});
```

### Stubbing Database Calls

```typescript
// tests/integration/users.test.ts
import request from 'supertest';
import { createApp } from '../../src';
import { createTestPort, delay } from '../setup';

describe('Users API with Database Stubs', () => {
  let app: any;
  let port: number;
  let dbStub: any;

  beforeEach(async () => {
    app = await createApp();
    port = createTestPort();

    // Create database stub
    dbStub = {
      query: jest.fn(),
      beginTransaction: jest.fn(),
    };

    app.database(dbStub);
  });

  afterEach(async () => {
    await app.close();
  });

  it('should handle database errors gracefully', async () => {
    // Stub database to throw error
    dbStub.query.mockRejectedValue(new Error('Database connection failed'));

    app.get('/users', async (req: any) => {
      const users = await dbStub.query('SELECT * FROM users');
      return { success: true, data: users };
    });

    app.listen(port);
    await delay(100);

    await request(`http://localhost:${port}`).get('/users').expect(500);

    expect(dbStub.query).toHaveBeenCalledWith('SELECT * FROM users');
  });

  it('should use database transaction', async () => {
    const transactionMock = {
      query: jest.fn().mockResolvedValue({ affectedRows: 1 }),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
    };

    dbStub.beginTransaction.mockResolvedValue(transactionMock);

    app.post('/transfer', async (req: any) => {
      const transaction = await dbStub.beginTransaction();
      try {
        await transaction.query('UPDATE accounts SET balance = balance - ? WHERE id = ?', [100, 1]);
        await transaction.query('UPDATE accounts SET balance = balance + ? WHERE id = ?', [100, 2]);
        await transaction.commit();
        return { success: true };
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    });

    app.listen(port);
    await delay(100);

    await request(`http://localhost:${port}`).post('/transfer').expect(200);

    expect(dbStub.beginTransaction).toHaveBeenCalled();
    expect(transactionMock.query).toHaveBeenCalledTimes(2);
    expect(transactionMock.commit).toHaveBeenCalled();
  });
});
```

## Testing Best Practices

### 1. Test Structure (AAA Pattern)

```typescript
describe('User Service', () => {
  it('should create a new user', async () => {
    // Arrange
    const userData = { name: 'John Doe', email: 'john@example.com' };
    const mockDb = { insert: jest.fn().mockResolvedValue({ id: 1 }) };
    const userService = new UserService(mockDb);

    // Act
    const result = await userService.createUser(userData);

    // Assert
    expect(result).toEqual({ id: 1, ...userData });
    expect(mockDb.insert).toHaveBeenCalledWith('users', userData);
  });
});
```

### 2. Test Data Factories

```typescript
// tests/factories/user.factory.ts
export const createUserData = (overrides: Partial<any> = {}) => ({
  name: 'John Doe',
  email: 'john@example.com',
  age: 25,
  role: 'user',
  ...overrides,
});

export const createUser = (overrides: Partial<any> = {}) => ({
  id: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...createUserData(overrides),
});

// Usage in tests
it('should create admin user', async () => {
  const adminData = createUserData({ role: 'admin' });
  const result = await userService.createUser(adminData);
  expect(result.role).toBe('admin');
});
```

### 3. Custom Matchers

```typescript
// tests/matchers.ts
expect.extend({
  toBeValidUser(received) {
    const pass =
      received &&
      typeof received.id === 'number' &&
      typeof received.name === 'string' &&
      typeof received.email === 'string' &&
      received.email.includes('@');

    return {
      pass,
      message: () => `Expected ${received} to be a valid user object`,
    };
  },
});

// Usage
expect(user).toBeValidUser();
```

### 4. Test Utilities

```typescript
// tests/utils/test-helpers.ts
export const waitFor = (condition: () => boolean, timeout = 5000) => {
  return new Promise<void>((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error('Timeout waiting for condition'));
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
};

export const createTestApp = async (options: any = {}) => {
  const app = await createApp(options);
  const cleanup = async () => {
    await app.close();
  };
  return { app, cleanup };
};
```

### 5. Test Coverage Goals

- **Unit Tests**: Aim for 90%+ coverage of business logic
- **Integration Tests**: Cover all API endpoints and module interactions
- **E2E Tests**: Cover critical user journeys

### 6. Performance Testing

```typescript
// tests/performance/load.test.ts
describe('Performance Tests', () => {
  it('should handle concurrent requests', async () => {
    const app = await createApp();
    app.get('/test', () => ({ success: true }));

    const port = createTestPort();
    app.listen(port);
    await delay(100);

    const startTime = Date.now();
    const promises = Array.from({ length: 100 }, () =>
      request(`http://localhost:${port}`).get('/test')
    );

    const results = await Promise.all(promises);
    const endTime = Date.now();

    expect(results.every(r => r.status === 200)).toBe(true);
    expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds

    await app.close();
  });
});
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20]

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        run: npm run test:unit

      - name: Run integration tests
        run: npm run test:integration

      - name: Run e2e tests
        run: npm run test:e2e

      - name: Generate coverage
        run: npm run test:coverage

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage/lcov.info
```

### Test Scripts

```json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest --testPathPattern=unit --coverage",
    "test:integration": "jest --testPathPattern=integration",
    "test:e2e": "jest --testPathPattern=e2e --runInBand",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage --watchAll=false",
    "test:ci": "jest --coverage --watchAll=false --ci"
  }
}
```

This comprehensive testing guide provides you with everything needed to thoroughly test your MoroJS applications. Remember to maintain good test coverage and follow testing best practices for reliable, maintainable code.
