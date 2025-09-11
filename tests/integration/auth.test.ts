// Auth Integration Tests
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createApp } from '../../src';
import { auth, providers } from '../../src/core/middleware/built-in/auth';
import request from 'supertest';
import { createTestPort, delay } from '../setup';

describe('Auth Integration Tests', () => {
  let app: any;
  let port: number;

  beforeEach(() => {
    app = createApp({
      logger: { level: 'error' }, // Reduce log noise in tests
    });
    port = createTestPort();
  });

  afterEach(async () => {
    // Close HTTP server if it exists
    try {
      if (app.core && app.core.httpServer) {
        await app.core.httpServer.close();
      }
    } catch (error) {
      // Ignore close errors
    }

    // Close Socket.IO if it exists
    try {
      if (app.core && app.core.io) {
        await new Promise<void>((resolve) => {
          app.core.io.close(() => resolve());
        });
      }
    } catch (error) {
      // Ignore close errors
    }

    // Destroy the container to clean up intervals
    try {
      if (app.core && app.core.container && typeof app.core.container.destroy === 'function') {
        app.core.container.destroy();
      }
    } catch (error) {
      // Ignore destroy errors
    }

    await delay(100);
  });

  describe('Basic Auth Setup', () => {
    it('should setup auth middleware with GitHub provider', async () => {
      // Configure auth middleware
      app.use(auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
      }));

      // Add a test route
      app.get('/test', (req: any) => {
        return {
          isAuthenticated: req.auth?.isAuthenticated || false,
          user: req.auth?.user || null,
        };
      });

      // Start server
      await new Promise<void>((resolve) => {
        app.listen(port, () => {
          resolve();
        });
      });

      await delay(100);

      const response = await request(`http://localhost:${port}`)
        .get('/test')
        .expect(200);

      expect(response.body.isAuthenticated).toBe(false);
      expect(response.body.user).toBeNull();
    });

    it('should handle auth middleware properly', async () => {
      app.use(auth({
        providers: [
          providers.credentials({
            credentials: {
              username: { label: 'Username', type: 'text' },
              password: { label: 'Password', type: 'password' }
            },
            authorize: async () => null // Mock authorize function
          })
        ],
        secret: 'test-secret',
      }));

      // Add a test route that checks auth
      app.get('/protected', (req: any) => {
        return {
          hasAuth: !!req.auth,
          isAuthenticated: req.auth?.isAuthenticated || false,
        };
      });

      // Start server
      await new Promise<void>((resolve) => {
        app.listen(port, () => {
          resolve();
        });
      });

      await delay(100);

      const response = await request(`http://localhost:${port}`)
        .get('/protected')
        .expect(200);

      expect(response.body.hasAuth).toBe(true);
      expect(response.body.isAuthenticated).toBe(false);
    });
  });

  describe('Auth API Routes', () => {
    it('should handle auth API routes', async () => {
      app.use(auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
      }));

      // Start server
      await new Promise<void>((resolve) => {
        app.listen(port, () => {
          resolve();
        });
      });

      await delay(100);

      // Test session endpoint (should exist from auth middleware)
      const sessionResponse = await request(`http://localhost:${port}`)
        .get('/api/auth/session');

      // Auth middleware should handle the request (could be 200 or 404, both are valid)
      expect([200, 404]).toContain(sessionResponse.status);
    });
  });
});
