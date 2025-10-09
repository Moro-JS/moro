// Integration Tests - Module Auto-Discovery End-to-End
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, rm } from 'fs/promises';
import request from 'supertest';

describe.skip('Module Auto-Discovery Integration Tests', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), 'moro-e2e-test-'));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    // Always restore working directory first
    if (originalCwd) {
      process.chdir(originalCwd);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('End-to-End Module Loading', () => {
    it('should auto-discover and load modules with working routes', async () => {
      // Create a complete users module
      await createCompleteModule('users', {
        name: 'users',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/users',
            handler: async () => ({
              success: true,
              users: [
                { id: 1, name: 'John Doe', email: 'john@example.com' },
                { id: 2, name: 'Jane Smith', email: 'jane@example.com' },
              ],
            }),
          },
          {
            method: 'POST',
            path: '/users',
            handler: async (req: any) => ({
              success: true,
              user: { id: 3, ...req.body },
              message: 'User created successfully',
            }),
          },
          {
            method: 'GET',
            path: '/users/:id',
            handler: async (req: any) => ({
              success: true,
              user: { id: parseInt(req.params.id), name: 'User ' + req.params.id },
            }),
          },
        ],
      });

      // Create orders module with dependency
      await createCompleteModule('orders', {
        name: 'orders',
        version: '1.0.0',
        dependencies: ['users@1.0.0'],
        routes: [
          {
            method: 'GET',
            path: '/orders',
            handler: async () => ({
              success: true,
              orders: [
                { id: 1, userId: 1, total: 99.99, status: 'completed' },
                { id: 2, userId: 2, total: 149.99, status: 'pending' },
              ],
            }),
          },
        ],
      });

      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'eager',
          loadOrder: 'dependency',
        },
      });

      // Wait for auto-discovery to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Get the underlying Node.js server for supertest
      const handler = app.getHandler();
      const server = (handler as any).getServer(); // MoroHttpServer.getServer()

      try {
        // Test users routes
        const usersResponse = await request(server).get('/api/v1.0.0/users/users').expect(200);

        expect(usersResponse.body.success).toBe(true);
        expect(usersResponse.body.users).toHaveLength(2);

        // Test user creation
        const createUserResponse = await request(server)
          .post('/api/v1.0.0/users/users')
          .send({ name: 'New User', email: 'new@example.com' })
          .expect(200);

        expect(createUserResponse.body.success).toBe(true);
        expect(createUserResponse.body.user.name).toBe('New User');

        // Test orders routes (should load after users due to dependency)
        const ordersResponse = await request(server).get('/api/v1.0.0/orders/orders').expect(200);

        expect(ordersResponse.body.success).toBe(true);
        expect(ordersResponse.body.orders).toHaveLength(2);
      } finally {
        await app.close();
      }
    });

    it('should handle modules with validation and middleware', async () => {
      await createCompleteModule('validated', {
        name: 'validated',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/validate',
            validation: {
              body: {
                type: 'object',
                properties: {
                  name: { type: 'string', minLength: 2 },
                  email: { type: 'string', format: 'email' },
                },
                required: ['name', 'email'],
              },
            },
            handler: async (req: any) => ({
              success: true,
              validated: req.body,
            }),
          },
        ],
      });

      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
        },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Test valid request
        const validResponse = await request(app.getHandler())
          .post('/api/v1.0.0/validated/validate')
          .send({ name: 'John Doe', email: 'john@example.com' })
          .expect(200);

        expect(validResponse.body.success).toBe(true);

        // Test invalid request (should be handled by validation middleware)
        await request(app.getHandler())
          .post('/api/v1.0.0/validated/validate')
          .send({ name: 'J' }) // Too short name, missing email
          .expect(400);
      } finally {
        await app.close();
      }
    });

    it('should handle conditional loading based on environment', async () => {
      // Create development-only module
      await createCompleteModule('dev-tools', {
        name: 'dev-tools',
        version: '1.0.0',
        config: {
          conditions: {
            environment: ['development', 'test'],
          },
        },
        routes: [
          {
            method: 'GET',
            path: '/debug',
            handler: async () => ({
              success: true,
              debug: true,
              environment: process.env.NODE_ENV,
            }),
          },
        ],
      });

      // Create production module
      await createCompleteModule('analytics', {
        name: 'analytics',
        version: '1.0.0',
        config: {
          conditions: {
            environment: ['production'],
          },
        },
        routes: [
          {
            method: 'POST',
            path: '/track',
            handler: async (req: any) => ({
              success: true,
              tracked: req.body,
            }),
          },
        ],
      });

      // Test in development environment
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const devApp = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'conditional',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Dev tools should be available
        await request(devApp.getHandler()).get('/api/v1.0.0/dev-tools/debug').expect(200);

        // Analytics should not be available
        await request(devApp.getHandler())
          .post('/api/v1.0.0/analytics/track')
          .send({ event: 'test' })
          .expect(404);
      } finally {
        await devApp.close();
      }

      // Test in production environment
      process.env.NODE_ENV = 'production';

      const prodApp = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'conditional',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Analytics should be available
        await request(prodApp.getHandler())
          .post('/api/v1.0.0/analytics/track')
          .send({ event: 'test' })
          .expect(200);

        // Dev tools should not be available
        await request(prodApp.getHandler()).get('/api/v1.0.0/dev-tools/debug').expect(404);
      } finally {
        await prodApp.close();
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('should handle feature flag conditions', async () => {
      await createCompleteModule('beta-features', {
        name: 'beta-features',
        version: '1.0.0',
        config: {
          conditions: {
            features: ['BETA_API', 'EXPERIMENTAL'],
          },
        },
        routes: [
          {
            method: 'GET',
            path: '/beta',
            handler: async () => ({
              success: true,
              beta: true,
              features: ['BETA_API', 'EXPERIMENTAL'],
            }),
          },
        ],
      });

      // Test without feature flags
      const app1 = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'conditional',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Beta features should not be available
        await request(app1.getHandler()).get('/api/v1.0.0/beta-features/beta').expect(404);
      } finally {
        await app1.close();
      }

      // Test with feature flags enabled
      process.env.FEATURE_BETA_API = 'true';
      process.env.FEATURE_EXPERIMENTAL = 'true';

      const app2 = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'conditional',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Beta features should now be available
        const response = await request(app2.getHandler())
          .get('/api/v1.0.0/beta-features/beta')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.beta).toBe(true);
      } finally {
        await app2.close();
        delete process.env.FEATURE_BETA_API;
        delete process.env.FEATURE_EXPERIMENTAL;
      }
    });

    it('should handle complex dependency chains', async () => {
      // Create a complex dependency chain: auth -> users -> orders -> reports
      await createCompleteModule('auth', {
        name: 'auth',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/login',
            handler: async () => ({ success: true, token: 'mock-token' }),
          },
        ],
      });

      await createCompleteModule('users', {
        name: 'users',
        version: '1.0.0',
        dependencies: ['auth@1.0.0'],
        routes: [
          {
            method: 'GET',
            path: '/users',
            handler: async () => ({ success: true, users: [] }),
          },
        ],
      });

      await createCompleteModule('orders', {
        name: 'orders',
        version: '1.0.0',
        dependencies: ['users@1.0.0'],
        routes: [
          {
            method: 'GET',
            path: '/orders',
            handler: async () => ({ success: true, orders: [] }),
          },
        ],
      });

      await createCompleteModule('reports', {
        name: 'reports',
        version: '1.0.0',
        dependencies: ['orders@1.0.0', 'users@1.0.0'],
        routes: [
          {
            method: 'GET',
            path: '/reports',
            handler: async () => ({ success: true, reports: [] }),
          },
        ],
      });

      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          loadingStrategy: 'eager',
          loadOrder: 'dependency',
        },
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      try {
        // All modules should be loaded and accessible
        await request(app.getHandler()).post('/api/v1.0.0/auth/login').expect(200);

        await request(app.getHandler()).get('/api/v1.0.0/users/users').expect(200);

        await request(app.getHandler()).get('/api/v1.0.0/orders/orders').expect(200);

        await request(app.getHandler()).get('/api/v1.0.0/reports/reports').expect(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should continue loading other modules when one fails', async () => {
      // Create a working module
      await createCompleteModule('working', {
        name: 'working',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/working',
            handler: async () => ({ success: true, working: true }),
          },
        ],
      });

      // Create a broken module
      await createBrokenModule('broken');

      const app = createApp({
        autoDiscover: {
          enabled: true,
          paths: ['./modules'],
          failOnError: false,
        },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      try {
        // Working module should still be accessible
        const response = await request(app.getHandler())
          .get('/api/v1.0.0/working/working')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.working).toBe(true);

        // Broken module should not be accessible
        await request(app.getHandler()).get('/api/v1.0.0/broken/test').expect(404);
      } finally {
        await app.close();
      }
    });
  });
});

// Helper functions
async function createCompleteModule(moduleName: string, moduleConfig: any): Promise<void> {
  const modulePath = join('./modules', moduleName);
  await fs.mkdir(modulePath, { recursive: true });

  const moduleContent = `
export default ${JSON.stringify(moduleConfig, null, 2)};
`;

  await fs.writeFile(join(modulePath, 'index.ts'), moduleContent);
}

async function createBrokenModule(moduleName: string): Promise<void> {
  const modulePath = join('./modules', moduleName);
  await fs.mkdir(modulePath, { recursive: true });

  const brokenContent = `
throw new Error("This module is intentionally broken");
`;

  await fs.writeFile(join(modulePath, 'index.ts'), brokenContent);
}
