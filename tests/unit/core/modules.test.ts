// Unit Tests - Module System
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { defineModule, defineRoute, z } from '../../../src/index.js';
import type { ModuleDefinition } from '../../../src/index.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import { WebSocketManager } from '../../../src/core/networking/websocket-manager.js';

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

    describe('keys it does not read', () => {
      // warn() is an instance property (a noop when the level disables it), so
      // the calls are read from the shared log(level, message, context) sink.
      function captureWarnings() {
        globalLogger.setLevel('warn');
        const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
        return () => logSpy.mock.calls.filter(c => c[0] === 'warn').map(c => String(c[1]));
      }

      afterEach(() => {
        jest.restoreAllMocks();
        globalLogger.setLevel('fatal');
      });

      it('names services and unknown keys once, and leaves them out', () => {
        const warnings = captureWarnings();
        class UserService {}
        const definition = {
          name: 'ignored-keys',
          version: '1.0.0',
          services: [{ name: 'userService', implementation: UserService }],
          description: 'not a module key',
          routes: [{ method: 'GET', path: '/', handler: () => ({}) }],
        } as unknown as ModuleDefinition;

        const module = defineModule(definition);
        expect(module.services).toBeUndefined();
        expect((module as any).description).toBeUndefined();
        expect(module.routes).toHaveLength(1);

        const mine = () => warnings().filter(m => m.includes("defineModule('ignored-keys')"));
        expect(mine()).toHaveLength(1);
        expect(mine()[0]).toContain("'services', 'description' are not read");
        expect(mine()[0]).toContain('app.getContainer().register');

        // The same definition again (a module imported twice) does not repeat it
        defineModule(definition);
        expect(mine()).toHaveLength(1);
      });

      it('says nothing for a definition that only uses the keys it reads', () => {
        const warnings = captureWarnings();
        defineModule({
          name: 'all-read',
          version: '1.0.0',
          config: { cache: { ttl: 60 }, anything: true },
          dependencies: ['users@1.0.0'],
          middleware: [],
          routes: [{ method: 'GET', path: '/', handler: () => ({}) }],
          sockets: [{ event: 'ping', handler: () => 'pong' }],
        });
        expect(warnings().filter(m => m.includes('defineModule('))).toEqual([]);
      });

      it('keeps config, which conditional loading reads', () => {
        const module = defineModule({
          name: 'with-config',
          version: '1.0.0',
          config: { conditions: { environment: 'production' } },
        });
        expect(module.config).toEqual({ conditions: { environment: 'production' } });
      });
    });

    it('should accept CompiledRoute (defineRoute) in routes array', () => {
      const handler = async () => ({ success: true });

      const compiled = defineRoute({
        method: 'GET',
        path: '/health',
        handler,
      });

      const module = defineModule({
        name: 'health-module',
        version: '1.0.0',
        routes: [compiled],
      });

      expect(module.routes).toHaveLength(1);
      expect(module.routes![0].method).toBe('GET');
      expect(module.routes![0].path).toBe('/health');
      expect(module.routes![0].handler).toBe('route_handler_0');
      expect(module.routeHandlers).toHaveProperty('route_handler_0');
      expect(module.routeHandlers!['route_handler_0']).toBe(handler);
    });

    it('should accept mixed CompiledRoute and plain ModuleRoute in routes array', () => {
      const compiledHandler = async () => ({ compiled: true });
      const plainHandler = async () => ({ plain: true });

      const compiled = defineRoute({
        method: 'GET',
        path: '/compiled',
        handler: compiledHandler,
      });

      const module = defineModule({
        name: 'mixed-module',
        version: '1.0.0',
        routes: [compiled, { method: 'POST', path: '/plain', handler: plainHandler }],
      });

      expect(module.routes).toHaveLength(2);
      expect(module.routes![0].method).toBe('GET');
      expect(module.routes![0].path).toBe('/compiled');
      expect(module.routes![1].method).toBe('POST');
      expect(module.routes![1].path).toBe('/plain');
      expect(module.routeHandlers!['route_handler_0']).toBe(compiledHandler);
      expect(module.routeHandlers!['route_handler_1']).toBe(plainHandler);
    });

    it('should preserve validation and auth from a CompiledRoute', () => {
      const schema = z.object({ email: z.string().email() });

      const compiled = defineRoute({
        method: 'POST',
        path: '/sign-in',
        validation: { body: schema },
        auth: { roles: ['admin'], optional: false },
        rateLimit: { requests: 5, window: 60000 },
        handler: async () => ({ ok: true }),
      });

      const module = defineModule({
        name: 'auth-module',
        version: '1.0.0',
        routes: [compiled],
      });

      const route = module.routes![0];
      expect(route.validation).toEqual({ body: schema });
      expect(route.auth).toEqual({ roles: ['admin'], optional: false });
      expect(route.rateLimit).toEqual({ requests: 5, window: 60000 });
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

  describe('module WebSocket handlers', () => {
    // One connected socket on a namespace, with the handler's replies collected.
    async function connect(
      handler: (socket: any, data: any) => any,
      breaker?: Record<string, unknown>
    ) {
      const adapter = { getAdapterName: () => 'fake' } as any;
      const container = { resolve: () => ({ onMessage: handler }) } as any;
      const manager = new WebSocketManager(adapter, container);
      if (breaker) manager.setCircuitBreakerOptions(breaker);

      let onConnection: (socket: any) => void = () => {};
      const namespace = { on: (_event: string, cb: any) => (onConnection = cb) } as any;
      await manager.registerHandler(
        namespace,
        { event: 'message', handler: 'onMessage' },
        { name: 'chat', version: '1.0.0' }
      );

      const listeners: Record<string, (data: any, callback?: any) => void> = {};
      const socket = {
        id: 's1',
        data: {} as Record<string, unknown>,
        connected: true,
        on: (event: string, cb: any) => (listeners[event] = cb),
        emit: () => {},
        join: () => {},
        broadcast: { emit: () => {} },
      };
      onConnection(socket);

      const send = (data: unknown) =>
        new Promise<any>(resolve => (listeners.message as any)(data, resolve));
      return { send };
    }

    it('have no circuit breaker by default: failing messages never switch the event off', async () => {
      let handled = 0;
      const { send } = await connect((_socket, data) => {
        if (data.fail) throw new Error('boom');
        handled++;
        return { echo: data.text };
      });

      for (let i = 0; i < 8; i++) {
        expect(await send({ fail: true })).toMatchObject({ success: false, code: 'HANDLER_ERROR' });
      }
      expect(await send({ text: 'hi' })).toEqual({ success: true, data: { echo: 'hi' } });
      expect(handled).toBe(1);
    });

    it('open on handler failures once the breaker is enabled', async () => {
      let calls = 0;
      const { send } = await connect(
        () => {
          calls++;
          throw new Error('database unreachable');
        },
        { enabled: true, failureThreshold: 3, resetTimeout: 60000, monitoringPeriod: 10000 }
      );

      for (let i = 0; i < 3; i++) {
        expect(await send({})).toMatchObject({ success: false, code: 'HANDLER_ERROR' });
      }
      expect(await send({})).toMatchObject({ success: false, code: 'CIRCUIT_OPEN' });
      expect(calls).toBe(3);
    });

    it('do not count an error that carries a 4xx status towards opening it', async () => {
      let handled = 0;
      const { send } = await connect(
        (_socket, data) => {
          if (data.bad) throw Object.assign(new Error('unknown room'), { status: 404 });
          handled++;
          return { ok: true };
        },
        { enabled: true, failureThreshold: 3, resetTimeout: 60000, monitoringPeriod: 10000 }
      );

      for (let i = 0; i < 6; i++) {
        expect(await send({ bad: true })).toMatchObject({ success: false, code: 'HANDLER_ERROR' });
      }
      expect(await send({})).toEqual({ success: true, data: { ok: true } });
      expect(handled).toBe(1);
    });
  });
});
