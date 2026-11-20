import { jest } from '@jest/globals';
import { createApp, defineModule, middleware } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { ModuleDefinition } from '../../src/types/module.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';

describe('Module Middleware - Integration Tests', () => {
  let app: Moro;
  let port: number;

  beforeEach(async () => {
    // Use dynamic port allocation to avoid conflicts in CI
    port = createTestPort();
    app = await createApp({ logging: { level: 'error' } });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    // Wait a bit for port to be released in CI environments
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should execute module-level middleware before route handler', async () => {
    const executionOrder: string[] = [];

    const moduleMiddleware = (req: any, res: any, next: () => void) => {
      executionOrder.push('module-middleware');
      (req as any).fromModuleMiddleware = true;
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [moduleMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: (req: any) => {
            executionOrder.push('route-handler');
            return {
              success: true,
              hadModuleMiddleware: (req as any).fromModuleMiddleware === true,
              executionOrder,
            };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(data.success).toBe(true);
    expect(data.hadModuleMiddleware).toBe(true);
    expect(data.executionOrder).toEqual(['module-middleware', 'route-handler']);
  });

  it('should execute route-level middleware after module middleware', async () => {
    const executionOrder: string[] = [];

    const moduleMiddleware = (req: any, res: any, next: () => void) => {
      executionOrder.push('module-middleware');
      next();
    };

    const routeMiddleware = (req: any, res: any, next: () => void) => {
      executionOrder.push('route-middleware');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [moduleMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: [routeMiddleware],
          handler: () => {
            executionOrder.push('route-handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(data.executionOrder).toEqual(['module-middleware', 'route-middleware', 'route-handler']);
  });

  it('should handle middleware that modifies request', async () => {
    const addCustomProperty = (req: any, res: any, next: () => void) => {
      (req as any).customProperty = 'custom-value';
      (req as any).middlewareTimestamp = Date.now();
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [addCustomProperty],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: (req: any) => {
            return {
              success: true,
              customProperty: (req as any).customProperty,
              hasTimestamp: !!(req as any).middlewareTimestamp,
            };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(data.success).toBe(true);
    expect(data.customProperty).toBe('custom-value');
    expect(data.hasTimestamp).toBe(true);
  });

  it('should support multiple module-level middleware functions', async () => {
    const executionOrder: string[] = [];

    const middleware1 = (req: any, res: any, next: () => void) => {
      executionOrder.push('middleware-1');
      next();
    };

    const middleware2 = (req: any, res: any, next: () => void) => {
      executionOrder.push('middleware-2');
      next();
    };

    const middleware3 = (req: any, res: any, next: () => void) => {
      executionOrder.push('middleware-3');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [middleware1, middleware2, middleware3],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => {
            executionOrder.push('handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(data.executionOrder).toEqual([
      'middleware-1',
      'middleware-2',
      'middleware-3',
      'handler',
    ]);
  });

  it('should support mixed middleware (functions only - string resolution for simple middleware)', async () => {
    const executionOrder: string[] = [];

    const customMiddleware1 = (req: any, res: any, next: () => void) => {
      executionOrder.push('custom-middleware-1');
      next();
    };

    const customMiddleware2 = (req: any, res: any, next: () => void) => {
      executionOrder.push('custom-middleware-2');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [customMiddleware1, customMiddleware2],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => {
            executionOrder.push('handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(data.executionOrder).toEqual(['custom-middleware-1', 'custom-middleware-2', 'handler']);
  });

  it('should apply module middleware to all routes in the module', async () => {
    const middleware1Calls: string[] = [];

    const moduleMiddleware = (req: any, res: any, next: () => void) => {
      middleware1Calls.push(req.path);
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [moduleMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/route1',
          handler: () => ({ route: 'route1' }),
        },
        {
          method: 'GET',
          path: '/route2',
          handler: () => ({ route: 'route2' }),
        },
        {
          method: 'POST',
          path: '/route3',
          handler: () => ({ route: 'route3' }),
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    await fetch(`http://localhost:${port}/api/v1.0.0/test-module/route1`);
    await fetch(`http://localhost:${port}/api/v1.0.0/test-module/route2`);
    await fetch(`http://localhost:${port}/api/v1.0.0/test-module/route3`, { method: 'POST' });

    expect(middleware1Calls.length).toBe(3);
    expect(middleware1Calls).toContain('/api/v1.0.0/test-module/route1');
    expect(middleware1Calls).toContain('/api/v1.0.0/test-module/route2');
    expect(middleware1Calls).toContain('/api/v1.0.0/test-module/route3');
  });

  it('should resolve built-in chain middleware by string name', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['helmet'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    // helmet with default options sets security headers
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('should fail closed for hook-based built-ins referenced by string name', async () => {
    // builtInMiddleware.cors is a hook-style factory (MiddlewareInterface) and
    // cannot run per-route — the request must fail rather than silently skip
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: ['cors'],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    expect(response.status).toBe(500);
  });

  it('should resolve simple middleware by string name', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['requestLogger'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should resolve user-installed middleware from the middleware manager by name', async () => {
    let ran = false;
    function taggedMiddleware(req: any, res: any, next: () => void) {
      ran = true;
      next();
    }
    (app as any).middlewareManager.install(taggedMiddleware);

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['taggedMiddleware'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(ran).toBe(true);
  });

  it('should fail the request instead of hanging or skipping when a named middleware cannot be resolved', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['doesNotExist'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Unresolvable declared middleware must fail closed (500), never run the handler
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    expect(response.status).toBe(500);
  });

  it('should throw at registration when a built-in factory is passed uncalled to app.use()', async () => {
    // app.use(middleware.helmet) — missing parens — must fail loudly, not
    // silently no-op through the app-plugin dispatch path
    await expect(app.use((middleware as any).helmet)).rejects.toThrow(/uncalled/);
  });

  it('should fail the request when a built-in factory is passed uncalled in a middleware array', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: [(middleware as any).helmet],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    expect(response.status).toBe(500);
  });

  it('should not hang when middleware ends the response without calling next()', async () => {
    const rejectingMiddleware = (_req: any, res: any, _next: () => void) => {
      res.status(403).json({ success: false, error: 'denied' });
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: [rejectingMiddleware],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
  });

  it('should handle async middleware functions', async () => {
    const executionOrder: string[] = [];

    const asyncMiddleware = async (req: any, res: any, next: () => void) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      executionOrder.push('async-middleware');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [asyncMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => {
            executionOrder.push('handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(data.executionOrder).toEqual(['async-middleware', 'handler']);
  });
});

// Module routes on an explicit HTTP backend. UnifiedRouter and the
// configuration are process-wide, so each test boots one app, exercises it and
// closes it before the next one starts.
type BackendId = 'node' | 'moro';
const BACKENDS: BackendId[] = engineLoadable ? ['node', 'moro'] : ['node'];

describe.each(BACKENDS)('Module routes on the %s backend', backend => {
  let app: any;

  async function createFor(options: Record<string, unknown> = {}): Promise<any> {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      server: { engine: backend },
      ...options,
    } as any);
    return app;
  }

  async function listen(): Promise<string> {
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    jest.restoreAllMocks();
  });

  describe('routing.strictMiddleware', () => {
    const checkTenant = async (_req: any, _res: any, _next: () => void) => {};
    const checkPlan = (_req: any, _res: any, _next: () => void) => {};
    const callsNext = (_req: any, _res: any, next: () => void) => next();
    const ran: string[] = [];
    // next() from a callback, as a middleware that looks something up does
    const loadAccount = (_req: any, _res: any, next: () => void) => {
      setTimeout(() => {
        ran.push('callback');
        next();
      }, 5);
    };
    const handler = (name: string) => () => {
      ran.push(name);
      return { ran: name };
    };

    async function statusesWith(routing: unknown) {
      ran.length = 0;
      await createFor({ routing });
      await app.loadModule(
        defineModule({
          name: 'billing',
          version: '1.0.0',
          middleware: [callsNext],
          routes: [
            { method: 'GET', path: '/async', middleware: [checkTenant], handler: handler('async') },
            { method: 'GET', path: '/sync', middleware: [checkPlan], handler: handler('sync') },
            { method: 'GET', path: '/open', middleware: [callsNext], handler: handler('open') },
            { method: 'GET', path: '/later', middleware: [loadAccount], handler: handler('later') },
          ],
        } as any)
      );
      await app.loadModule(
        defineModule({
          name: 'ops',
          version: '1.0.0',
          middleware: [checkTenant],
          routes: [{ method: 'GET', path: '/dump', handler: handler('dump') }],
        } as any)
      );
      const base = await listen();
      const statuses: Record<string, number | string> = {};
      for (const path of ['/billing/async', '/billing/open', '/billing/later', '/ops/dump']) {
        statuses[path] = (await fetch(`${base}/api/v1.0.0${path}`)).status;
      }
      // A middleware that returns no promise, calls no next() and sends
      // nothing is waited for, with the option and without it
      statuses['/billing/sync'] = await fetch(`${base}/api/v1.0.0/billing/sync`, {
        signal: AbortSignal.timeout(300),
      }).then(
        reply => reply.status,
        () => 'no answer'
      );
      return statuses;
    }

    it('refuses an async middleware that finishes without next() when on, and passes its request on when off', async () => {
      expect(await statusesWith(false)).toEqual({
        '/billing/async': 200,
        '/billing/open': 200,
        '/billing/later': 200,
        '/ops/dump': 200,
        '/billing/sync': 'no answer',
      });
      expect(ran).toEqual(['async', 'open', 'callback', 'later', 'dump']);
      await closeApp(app);

      expect(await statusesWith({ enabled: false, strictMiddleware: true })).toEqual({
        '/billing/async': 500,
        '/billing/open': 200,
        '/billing/later': 200,
        '/ops/dump': 500,
        '/billing/sync': 'no answer',
      });
      expect(ran).toEqual(['open', 'callback', 'later']);
    });
  });

  it('aborts before the handler when module-level or module-route middleware calls next(err)', async () => {
    const ran: string[] = [];
    const deny = (_req: any, _res: any, next: (err?: unknown) => void) => next(new Error('denied'));
    await createFor();
    await app.loadModule(
      defineModule({
        name: 'billing',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/guarded',
            middleware: [deny],
            handler: () => {
              ran.push('route');
              return { ran: 'route' };
            },
          },
          { method: 'GET', path: '/open', handler: () => ({ ok: true }) },
        ],
      } as any)
    );
    await app.loadModule(
      defineModule({
        name: 'ops',
        version: '1.0.0',
        middleware: [deny],
        routes: [
          {
            method: 'GET',
            path: '/dump',
            handler: () => {
              ran.push('module');
              return { ran: 'module' };
            },
          },
        ],
      } as any)
    );
    const base = await listen();

    expect((await fetch(`${base}/api/v1.0.0/billing/guarded`)).status).toBe(500);
    expect((await fetch(`${base}/api/v1.0.0/ops/dump`)).status).toBe(500);
    expect(ran).toEqual([]);
    // An unguarded route in the same module is unaffected.
    expect((await fetch(`${base}/api/v1.0.0/billing/open`)).status).toBe(200);
  });

  // Rate-limit counters and cached responses are kept per process, so each
  // backend gets a module name, and with it paths, of its own.
  it('enforces rateLimit on a module route', async () => {
    await createFor();
    const name = `limits-${backend}`;
    await app.loadModule(
      defineModule({
        name,
        version: '1.0.0',
        routes: [
          { method: 'GET', path: '/open', handler: () => ({ ok: true }) },
          {
            method: 'GET',
            path: '/limited',
            rateLimit: { requests: 2, window: 60000 },
            handler: () => ({ ok: true }),
          },
        ],
      } as any)
    );
    const base = await listen();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await fetch(`${base}/api/v1.0.0/${name}/limited`)).status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    const limited = await fetch(`${base}/api/v1.0.0/${name}/limited`);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    // The route beside it has no limit.
    for (let i = 0; i < 4; i++) {
      expect((await fetch(`${base}/api/v1.0.0/${name}/open`)).status).toBe(200);
    }
  });

  it('caches a module route, and serves a hit only past its middleware and auth', async () => {
    await createFor();
    await app.use((req: any, _res: any, next: () => void) => {
      const user = req.headers['x-user'];
      req.auth = user
        ? { isAuthenticated: true, user: { id: user, roles: [req.headers['x-role'] || 'user'] } }
        : { isAuthenticated: false };
      next();
    });
    let calls = 0;
    const name = `reports-${backend}`;
    await app.loadModule(
      defineModule({
        name,
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/summary',
            cache: { ttl: 60, shared: true },
            auth: { roles: ['admin'] },
            middleware: [
              (req: any, res: any, next: () => void) => {
                if (req.headers['x-team'] !== 'ops') {
                  res.status(403).json({ error: 'wrong team' });
                  return;
                }
                next();
              },
            ],
            handler: () => ({ summary: ++calls }),
          },
        ],
      } as any)
    );
    const base = await listen();
    const get = (headers: Record<string, string>) =>
      fetch(`${base}/api/v1.0.0/${name}/summary`, { headers });
    const admin = { 'x-user': 'a1', 'x-role': 'admin', 'x-team': 'ops' };

    const first = await get(admin);
    expect(await first.json()).toEqual({ summary: 1 });
    expect(first.headers.get('x-cache')).toBe('MISS');

    // Stored now. None of these may be answered from the store.
    expect((await get({ 'x-team': 'ops' })).status).toBe(401);
    expect((await get({ 'x-user': 'u2', 'x-team': 'ops' })).status).toBe(403);
    expect((await get({ 'x-user': 'a1', 'x-role': 'admin' })).status).toBe(403);

    const second = await get(admin);
    expect(await second.json()).toEqual({ summary: 1 });
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(calls).toBe(1);
  });

  it('runs the auth validator of a module route', async () => {
    await createFor();
    await app.use((req: any, _res: any, next: () => void) => {
      const user = req.headers['x-user'];
      req.auth = user
        ? { isAuthenticated: true, user: { id: user, roles: ['user'] } }
        : { isAuthenticated: false };
      next();
    });
    const seen: string[] = [];
    await app.loadModule(
      defineModule({
        name: 'orders',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/users/:id',
            auth: {
              required: true,
              validator: async (req: any) => {
                seen.push(req.params.id);
                return req.auth.user.id === req.params.id;
              },
            },
            handler: (req: any) => ({ orders: [`${req.params.id}-1`] }),
          },
          {
            method: 'GET',
            path: '/keyed',
            auth: { required: true, validator: (req: any) => req.headers['x-api-key'] === 'k1' },
            handler: () => ({ ok: 'keyed' }),
          },
        ],
      } as any)
    );
    const base = await listen();
    const orders = (id: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/v1.0.0/orders/users/${id}`, { headers });

    expect((await orders('u1')).status).toBe(401);
    expect(seen).toEqual([]);
    const other = await orders('u2', { 'x-user': 'u1' });
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain('u2-1');
    const own = await orders('u1', { 'x-user': 'u1' });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ orders: ['u1-1'] });
    expect(seen).toEqual(['u2', 'u1']);

    // A validator that does not look at the user denies a signed-in caller too.
    const keyed = (headers: Record<string, string>) =>
      fetch(`${base}/api/v1.0.0/orders/keyed`, { headers });
    expect((await keyed({ 'x-user': 'u1' })).status).toBe(403);
    expect((await keyed({ 'x-user': 'u1', 'x-api-key': 'k1' })).status).toBe(200);
  });

  it('hands what a module route throws to app.setErrorHandler(), as a route on the app does', async () => {
    const fail = (kind: string) => {
      if (kind === 'missing') throw Object.assign(new Error('no such order'), { status: 404 });
      if (kind === 'invalid') throw Object.assign(new Error('bad order'), { statusCode: 422 });
      if (kind === 'object') throw { status: 409, message: 'already shipped' };
      throw new Error('database unreachable');
    };
    const ordersModule = (name: string) =>
      defineModule({
        name,
        version: '1.0.0',
        routes: [
          { method: 'GET', path: '/:kind', handler: (req: any) => fail(req.params.kind) },
          {
            method: 'GET',
            path: '/guarded/:kind',
            middleware: [(_req: any, _res: any, next: (err?: unknown) => void) => next()],
            handler: async (req: any) => fail(req.params.kind),
          },
        ],
      } as any);
    const answers = async (base: string, prefix: string) => {
      const seen: Record<string, unknown> = {};
      for (const kind of ['missing', 'invalid', 'object', 'down']) {
        const reply = await fetch(`${base}${prefix}/${kind}`);
        seen[kind] = { status: reply.status, body: await reply.json() };
      }
      return seen;
    };

    await createFor();
    const offered: string[] = [];
    app.setErrorHandler((error: any, req: any, res: any) => {
      offered.push(req.path);
      const status = error.status ?? error.statusCode;
      // An error that says nothing about its status is left to the default
      if (typeof status === 'number') res.status(status).json({ problem: error.message });
    });
    app.get(`/${backend}/app-orders/:kind`, (req: any) => fail(req.params.kind));
    await app.loadModule(ordersModule(`${backend}-orders`));
    let base = await listen();

    const expected = {
      missing: { status: 404, body: { problem: 'no such order' } },
      invalid: { status: 422, body: { problem: 'bad order' } },
      object: { status: 409, body: { problem: 'already shipped' } },
      down: { status: 500, body: expect.objectContaining({ error: 'Internal server error' }) },
    };
    expect(await answers(base, `/${backend}/app-orders`)).toEqual(expected);
    expect(await answers(base, `/api/v1.0.0/${backend}-orders`)).toEqual(expected);
    expect(await answers(base, `/api/v1.0.0/${backend}-orders/guarded`)).toEqual(expected);
    // Once per failed request
    expect(offered).toHaveLength(12);

    // With no error handler a module route answers as it always did
    await closeApp(app);
    await createFor();
    await app.loadModule(ordersModule(`${backend}-plain-orders`));
    base = await listen();
    const plain: any = await answers(base, `/api/v1.0.0/${backend}-plain-orders`);
    for (const kind of ['missing', 'invalid', 'object', 'down']) {
      expect(plain[kind]).toEqual({
        status: 500,
        body: { success: false, error: 'Internal server error', requestId: expect.any(String) },
      });
    }
  });

  describe('circuit breaker', () => {
    const itemsModule = (name: string, runs: { ok: number }) =>
      defineModule({
        name,
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/items/:id',
            handler: (req: any, res: any) => {
              if (req.params.id === 'missing') {
                throw Object.assign(new Error('no such item'), { status: 404 });
              }
              if (req.params.id === 'gone') {
                res.status(410).json({ error: 'gone' });
                return;
              }
              if (req.params.id === 'down') throw new Error('database unreachable');
              if (req.params.id === 'bad-gateway') {
                res.status(502).json({ error: 'upstream' });
                return;
              }
              runs.ok++;
              return { item: req.params.id };
            },
          },
        ],
      } as any);

    it('is off by default: failing requests never take the route away from the others', async () => {
      await createFor();
      const runs = { ok: 0 };
      await app.loadModule(itemsModule('stock', runs));
      const base = await listen();
      const item = (id: string) => fetch(`${base}/api/v1.0.0/stock/items/${id}`);

      for (let i = 0; i < 8; i++) expect((await item('down')).status).toBe(500);
      for (let i = 0; i < 8; i++) expect((await item('missing')).status).toBe(500);
      const ok = await item('42');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ item: '42' });
      expect(runs.ok).toBe(1);
    });

    it('opens on server-side failures when performance.circuitBreaker.enabled is set, and recovers', async () => {
      await createFor({
        performance: {
          circuitBreaker: {
            enabled: true,
            failureThreshold: 3,
            resetTimeout: 1000,
            monitoringPeriod: 10000,
          },
        },
      });
      const runs = { ok: 0 };
      await app.loadModule(itemsModule('depot', runs));
      const base = await listen();
      const item = (id: string) => fetch(`${base}/api/v1.0.0/depot/items/${id}`);

      expect((await item('down')).status).toBe(500);
      expect((await item('bad-gateway')).status).toBe(502);
      expect((await item('down')).status).toBe(500);

      // Open: answered without running the handler, and saying when to retry.
      const refused = await item('42');
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('1');
      expect(runs.ok).toBe(0);

      await new Promise(resolve => setTimeout(resolve, 1100));
      expect((await item('42')).status).toBe(200);
      expect((await item('43')).status).toBe(200);
      expect(runs.ok).toBe(2);
    });

    it('never counts what a client can cause: a thrown 4xx or a 4xx answer', async () => {
      await createFor({
        performance: {
          circuitBreaker: {
            enabled: true,
            failureThreshold: 3,
            resetTimeout: 60000,
            monitoringPeriod: 10000,
          },
        },
      });
      const runs = { ok: 0 };
      await app.loadModule(itemsModule('shelf', runs));
      const base = await listen();
      const item = (id: string) => fetch(`${base}/api/v1.0.0/shelf/items/${id}`);

      for (let i = 0; i < 6; i++) await item('missing');
      for (let i = 0; i < 6; i++) expect((await item('gone')).status).toBe(410);
      expect((await item('42')).status).toBe(200);
      expect(runs.ok).toBe(1);
    });
  });

  it('matches route auth roles and permissions entry by entry, never by substring', async () => {
    await createFor();
    await app.use((req: any, _res: any, next: () => void) => {
      const header = req.headers['x-roles'];
      req.auth = {
        isAuthenticated: true,
        user: {
          id: 'u1',
          roles: header === 'array' ? ['editor', 'admin'] : header,
          permissions: req.headers['x-permissions'],
        },
      };
      next();
    });
    await app.loadModule(
      defineModule({
        name: 'backoffice',
        version: '1.0.0',
        routes: [
          {
            method: 'GET',
            path: '/admin',
            auth: { roles: ['admin'] },
            handler: () => ({ ok: 'admin' }),
          },
          {
            method: 'GET',
            path: '/delete',
            auth: { permissions: ['users:delete'] },
            handler: () => ({ ok: 'delete' }),
          },
        ],
      } as any)
    );
    const base = await listen();
    const admin = (roles: string) =>
      fetch(`${base}/api/v1.0.0/backoffice/admin`, { headers: { 'x-roles': roles } });

    expect((await admin('not-an-admin-at-all')).status).toBe(403);
    expect((await admin('administrator')).status).toBe(403);
    expect((await admin('admin')).status).toBe(200);
    expect((await admin('editor,admin')).status).toBe(200); // comma-separated storage
    expect((await admin('array')).status).toBe(200);

    const del = (permissions: string) =>
      fetch(`${base}/api/v1.0.0/backoffice/delete`, {
        headers: { 'x-roles': 'user', 'x-permissions': permissions },
      });
    expect((await del('users:delete-own-drafts')).status).toBe(403);
    expect((await del('users:read users:delete')).status).toBe(200);
  });
});
