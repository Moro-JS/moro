// Unit Tests - Module System
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { defineModule, z } from '../../../src/index.js';
import type { ModuleDefinition } from '../../../src/index.js';

describe('Module System', () => {
  describe('defineModule', () => {
    it('should create a basic module', () => {
      const module = defineModule({
        name: 'test-module',
        version: '1.0.0',
      });

      expect(module.name).toBe('test-module');
      expect(module.version).toBe('1.0.0');
    });

    it('should create a module with routes', () => {
      const module = defineModule({
        name: 'users',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/users',
            handler: async () => ({ success: true }),
          },
          {
            method: 'POST',
            path: '/users',
            handler: async (req: any) => ({ success: true, data: req.body }),
          },
        ],
      });

      expect(module.name).toBe('users');
      expect(module.routes).toHaveLength(2);
      expect(module.routeHandlers).toBeDefined();
      expect(module.routeHandlers).toHaveProperty('route_handler_0');
      expect(module.routeHandlers).toHaveProperty('route_handler_1');
    });

    it('should create a module with validation', () => {
      const userSchema = z.object({
        name: z.string(),
        email: z.string().email(),
      });

      const module = defineModule({
        name: 'validated-module',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/users',
            validation: { body: userSchema },
            handler: async (req: any) => ({ user: req.body }),
          },
        ],
      });

      expect(module.routes![0]).toHaveProperty('validation');
      expect(module.routes![0].validation).toEqual({ body: userSchema });
    });

    it('should create a module with rate limiting', () => {
      const module = defineModule({
        name: 'rate-limited-module',
        version: '1.0.0',
        routes: [
          {
            method: 'POST',
            path: '/api',
            rateLimit: { requests: 10, window: 60000 },
            handler: async () => ({ success: true }),
          },
        ],
      });

      expect(module.routes![0]).toHaveProperty('rateLimit');
      expect(module.routes![0].rateLimit).toEqual({ requests: 10, window: 60000 });
    });

    it('should create a module with caching', () => {
      const module = defineModule({
        name: 'cached-module',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/data',
            cache: { ttl: 300 },
            handler: async () => ({ data: 'cached' }),
          },
        ],
      });

      expect(module.routes![0]).toHaveProperty('cache');
      expect(module.routes![0].cache).toEqual({ ttl: 300 });
    });

    it('should create a module with WebSocket handlers', () => {
      const module = defineModule({
        name: 'websocket-module',
        version: '1.0.0',
        sockets: [
          {
            event: 'message',
            handler: async () => ({ success: true }),
          },
          {
            event: 'join',
            validation: z.object({ room: z.string() }),
            handler: async (socket: any, data: any) => {
              socket.join(data.room);
              return { joined: data.room };
            },
          },
        ],
      });

      expect(module.sockets).toHaveLength(2);
      expect(module.socketHandlers).toBeDefined();
      expect(module.socketHandlers).toHaveProperty('socket_handler_0');
      expect(module.socketHandlers).toHaveProperty('socket_handler_1');
    });

    it('should create a module with dependencies', () => {
      const module = defineModule({
        name: 'dependent-module',
        version: '1.0.0',
        dependencies: ['auth@1.0.0', 'users@2.0.0'],
      });

      expect(module.dependencies).toEqual(['auth@1.0.0', 'users@2.0.0']);
    });

    it('should create a module with custom config', () => {
      const module = defineModule({
        name: 'configurable-module',
        version: '1.0.0',
        config: {
          apiKey: 'secret-key',
          timeout: 5000,
          retries: 3,
        },
      });

      expect(module.config).toEqual({
        apiKey: 'secret-key',
        timeout: 5000,
        retries: 3,
      });
    });

    it('should create a complex enterprise module', () => {
      const userSchema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
      });

      const module = defineModule({
        name: 'enterprise-users',
        version: '2.1.0',
        dependencies: ['auth@1.0.0'],
        config: {
          features: { pagination: true, search: true },
        },
        routes: [
          {
            method: 'GET',
            path: '/users',
            validation: {
              query: z.object({
                limit: z.coerce.number().default(10),
                search: z.string().optional(),
              }),
            },
            cache: { ttl: 60 },
            rateLimit: { requests: 100, window: 60000 },
            handler: async (req: any) => ({
              success: true,
              data: [],
              query: req.query,
            }),
          },
          {
            method: 'POST',
            path: '/users',
            validation: { body: userSchema },
            rateLimit: { requests: 5, window: 60000 },
            handler: async (req: any) => ({
              success: true,
              user: req.body,
            }),
          },
        ],
        sockets: [
          {
            event: 'user-status',
            validation: z.object({
              userId: z.string().uuid(),
              status: z.enum(['online', 'offline']),
            }),
            handler: async (socket: any, data: any) => {
              socket.broadcast.emit('status-changed', data);
              return { success: true };
            },
          },
        ],
      });

      expect(module.name).toBe('enterprise-users');
      expect(module.version).toBe('2.1.0');
      expect(module.dependencies).toEqual(['auth@1.0.0']);
      expect(module.routes).toHaveLength(2);
      expect(module.sockets).toHaveLength(1);
      expect(module.config).toEqual({
        features: { pagination: true, search: true },
      });
    });
  });
});
