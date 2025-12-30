/* eslint-disable no-unused-vars */
import { describe, it, expect, jest } from '@jest/globals';
import { defineModule } from '../../../src/core/modules/modules.js';

describe('Module Middleware Support', () => {
  describe('defineModule with middleware', () => {
    it('should accept module-level middleware as functions', () => {
      const middleware1 = jest.fn((_req, _res, next) => next());
      const middleware2 = jest.fn((_req, _res, next) => next());

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: [middleware1, middleware2],
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware).toEqual([middleware1, middleware2]);
      expect(module.middleware?.length).toBe(2);
    });

    it('should accept module-level middleware as strings', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: ['cors', 'helmet'],
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware).toEqual(['cors', 'helmet']);
      expect(module.middleware?.length).toBe(2);
    });

    it('should accept mixed middleware (functions and strings)', () => {
      const customMiddleware = jest.fn((_req, _res, next) => next());

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: ['cors', customMiddleware, 'helmet'],
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware?.length).toBe(3);
      expect(module.middleware?.[0]).toBe('cors');
      expect(module.middleware?.[1]).toBe(customMiddleware);
      expect(module.middleware?.[2]).toBe('helmet');
    });

    it('should accept route-level middleware as functions', () => {
      const routeMiddleware = jest.fn((_req, _res, next) => next());

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/secure',
            middleware: [routeMiddleware],
            handler: async (_req, _res) => {
              return { message: 'secure' };
            },
          },
        ],
      });

      expect(module.routes?.[0].middleware).toEqual([routeMiddleware]);
    });

    it('should accept route-level middleware as strings', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/secure',
            middleware: ['auth', 'rateLimit'],
            handler: async (_req, _res) => {
              return { message: 'secure' };
            },
          },
        ],
      });

      expect(module.routes?.[0].middleware).toEqual(['auth', 'rateLimit']);
    });

    it('should accept both module and route-level middleware', () => {
      const globalMw = jest.fn((_req, _res, next) => next());
      const routeMw = jest.fn((_req, _res, next) => next());

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: [globalMw, 'cors'],
        routes: [
          {
            method: 'GET',
            path: '/public',
            handler: async (_req, _res) => {
              return { message: 'public' };
            },
          },
          {
            method: 'POST',
            path: '/secure',
            middleware: [routeMw, 'auth'],
            handler: async (_req, _res) => {
              return { message: 'secure' };
            },
          },
        ],
      });

      expect(module.middleware?.length).toBe(2);
      expect(module.routes?.[0].middleware).toBeUndefined();
      expect(module.routes?.[1].middleware?.length).toBe(2);
    });

    it('should preserve all route properties with middleware', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/data',
            middleware: ['auth'],
            validation: { body: {} },
            cache: { ttl: 300 },
            rateLimit: { requests: 100, window: 60000 },
            auth: { roles: ['admin'] },
            handler: async (_req, _res) => {
              return { data: [] };
            },
          },
        ],
      });

      const route = module.routes?.[0];
      expect(route?.middleware).toEqual(['auth']);
      expect(route?.validation).toEqual({ body: {} });
      expect(route?.cache).toEqual({ ttl: 300 });
      expect(route?.rateLimit).toEqual({ requests: 100, window: 60000 });
      expect(route?.auth).toEqual({ roles: ['admin'] });
    });

    it('should handle empty middleware arrays', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: [],
        routes: [
          {
            method: 'GET',
            path: '/test',
            middleware: [],
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware).toEqual([]);
      expect(module.routes?.[0].middleware).toEqual([]);
    });

    it('should work without any middleware', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware).toBeUndefined();
      expect(module.routes?.[0].middleware).toBeUndefined();
    });
  });

  describe('Module middleware execution order', () => {
    it('should maintain middleware order', () => {
      const mw1 = jest.fn((_req, _res, next) => next());
      const mw2 = jest.fn((_req, _res, next) => next());
      const mw3 = jest.fn((_req, _res, next) => next());

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: [mw1, mw2, mw3],
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware?.[0]).toBe(mw1);
      expect(module.middleware?.[1]).toBe(mw2);
      expect(module.middleware?.[2]).toBe(mw3);
    });
  });

  describe('Middleware type checking', () => {
    it('should accept async middleware functions', () => {
      const asyncMiddleware = jest.fn(async (req, res, next) => {
        await Promise.resolve();
        next();
      });

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: [asyncMiddleware],
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware?.[0]).toBe(asyncMiddleware);
    });

    it('should accept middleware with custom names', () => {
      function namedMiddleware(req: any, res: any, next: () => void) {
        next();
      }

      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
        middleware: [namedMiddleware],
        routes: [
          {
            method: 'GET',
            path: '/test',
            handler: async (_req, _res) => {
              return { message: 'test' };
            },
          },
        ],
      });

      expect(module.middleware?.[0]).toBe(namedMiddleware);
      expect((module.middleware?.[0] as any).name).toBe('namedMiddleware');
    });
  });
});
