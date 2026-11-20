// Unit Tests - Intelligent Routing System
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createRoute, EXECUTION_PHASES, z, defineModule } from '../../../src/index.js';
import {
  UnifiedRouter,
  isNextError,
  warnUncalledGuard,
  warnUnsupportedAuthKeys,
} from '../../../src/core/routing/unified-router.js';
import {
  requireAuth,
  requireRole,
  requirePermission,
  requireAdmin,
  guestOnly,
  optionalAuth,
} from '../../../src/core/middleware/built-in/auth/helpers.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import { MoroHttpServer } from '../../../src/core/http/http-server.js';
import { MoroHttp2Server } from '../../../src/core/http/http2-server.js';

describe('Intelligent Routing System', () => {
  describe('createRoute helper', () => {
    it('should create a route builder for GET', () => {
      const builder = createRoute('GET', '/test');
      expect(builder).toBeDefined();
      expect(typeof builder).toBe('object');
    });

    it('should create a route builder for POST', () => {
      const builder = createRoute('POST', '/users');
      expect(builder).toBeDefined();
      expect(typeof builder).toBe('object');
    });

    it('should create routes for all HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

      methods.forEach(method => {
        const builder = createRoute(method, '/test');
        expect(builder).toBeDefined();
        expect(typeof builder).toBe('object');
      });
    });

    it('should create routes with different paths', () => {
      const paths = ['/users', '/users/:id', '/api/v1/users', '/complex/path/with/many/segments'];

      paths.forEach(path => {
        const builder = createRoute('GET', path);
        expect(builder).toBeDefined();
      });
    });
  });

  describe('EXECUTION_PHASES', () => {
    it('should define all required execution phases', () => {
      expect(EXECUTION_PHASES).toBeDefined();
      expect(Array.isArray(EXECUTION_PHASES)).toBe(true);

      // Check that the phases exist in the array
      expect(EXECUTION_PHASES).toContain('security');
      expect(EXECUTION_PHASES).toContain('parsing');
      expect(EXECUTION_PHASES).toContain('rateLimit');
      expect(EXECUTION_PHASES).toContain('auth');
      expect(EXECUTION_PHASES).toContain('validation');
      expect(EXECUTION_PHASES).toContain('cache');
      expect(EXECUTION_PHASES).toContain('handler');
    });

    it('should have string values for phases', () => {
      EXECUTION_PHASES.forEach(phase => {
        expect(typeof phase).toBe('string');
        expect(phase.length).toBeGreaterThan(0);
      });
    });

    it('should have correct phase order', () => {
      const expectedOrder = [
        'security',
        'parsing',
        'rateLimit',
        'before',
        'auth',
        'validation',
        'transform',
        'after',
        'cache',
        'handler',
      ];

      expect(EXECUTION_PHASES).toEqual(expectedOrder);
    });

    it('should have 10 execution phases', () => {
      expect(EXECUTION_PHASES.length).toBe(10);
    });
  });

  describe('Route Builder Validation', () => {
    it('should work with Zod schemas', () => {
      const userSchema = z.object({
        name: z.string().min(2),
        email: z.string().email(),
        age: z.number().min(18).optional(),
      });

      // Test that the schema works
      const validUser = { name: 'John Doe', email: 'john@example.com', age: 25 };
      const invalidUser = { name: 'J', email: 'invalid', age: 16 };

      expect(userSchema.safeParse(validUser).success).toBe(true);
      expect(userSchema.safeParse(invalidUser).success).toBe(false);

      // Test that we can create a route with this schema
      const builder = createRoute('POST', '/users');
      expect(builder).toBeDefined();
    });

    it('should work with query parameter schemas', () => {
      const querySchema = z.object({
        page: z.coerce.number().min(1).default(1),
        limit: z.coerce.number().min(1).max(100).default(10),
        search: z.string().optional(),
      });

      // Test schema functionality
      const validQuery = { page: '2', limit: '25', search: 'test' };
      const result = querySchema.parse(validQuery);

      expect(result).toEqual({ page: 2, limit: 25, search: 'test' });

      // Test route creation
      const builder = createRoute('GET', '/search');
      expect(builder).toBeDefined();
    });

    it('should work with path parameter schemas', () => {
      const paramsSchema = z.object({
        id: z.string().uuid(),
        category: z.enum(['users', 'posts', 'comments']),
      });

      // Test schema functionality
      const validParams = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        category: 'users',
      };
      const invalidParams = {
        id: 'invalid-uuid',
        category: 'invalid-category',
      };

      expect(paramsSchema.safeParse(validParams).success).toBe(true);
      expect(paramsSchema.safeParse(invalidParams).success).toBe(false);

      // Test route creation
      const builder = createRoute('GET', '/api/:category/:id');
      expect(builder).toBeDefined();
    });
  });

  describe('Complex Validation Scenarios', () => {
    it('should handle nested object validation', () => {
      const complexSchema = z.object({
        user: z.object({
          profile: z.object({
            name: z.string(),
            age: z.number(),
          }),
          settings: z.object({
            theme: z.enum(['light', 'dark']),
            notifications: z.boolean(),
          }),
        }),
        metadata: z.object({
          source: z.string(),
          timestamp: z.string().datetime(),
        }),
      });

      const validData = {
        user: {
          profile: { name: 'John', age: 30 },
          settings: { theme: 'dark', notifications: true },
        },
        metadata: {
          source: 'api',
          timestamp: new Date().toISOString(),
        },
      };

      expect(complexSchema.safeParse(validData).success).toBe(true);

      // Test route creation with complex schema
      const builder = createRoute('POST', '/complex');
      expect(builder).toBeDefined();
    });

    it('should handle array validation', () => {
      const arraySchema = z.object({
        items: z
          .array(
            z.object({
              id: z.number(),
              name: z.string(),
              tags: z.array(z.string()).max(5),
            })
          )
          .min(1)
          .max(10),
      });

      const validData = {
        items: [
          { id: 1, name: 'Item 1', tags: ['tag1', 'tag2'] },
          { id: 2, name: 'Item 2', tags: ['tag3'] },
        ],
      };

      expect(arraySchema.safeParse(validData).success).toBe(true);

      // Test route creation
      const builder = createRoute('POST', '/batch');
      expect(builder).toBeDefined();
    });

    it('should handle custom validation refinements', () => {
      const passwordSchema = z
        .object({
          password: z.string().min(8),
          confirmPassword: z.string(),
        })
        .refine((data: any) => data.password === data.confirmPassword, {
          message: "Passwords don't match",
          path: ['confirmPassword'],
        });

      const validData = {
        password: 'secret123',
        confirmPassword: 'secret123',
      };

      const invalidData = {
        password: 'secret123',
        confirmPassword: 'different',
      };

      expect(passwordSchema.safeParse(validData).success).toBe(true);
      expect(passwordSchema.safeParse(invalidData).success).toBe(false);

      // Test route creation
      const builder = createRoute('POST', '/register');
      expect(builder).toBeDefined();
    });
  });

  describe('Module Configuration', () => {
    it('should handle modules with dependencies', () => {
      const module = defineModule({
        name: 'dependent-module',
        version: '1.0.0',
        dependencies: ['auth@1.0.0', 'users@2.0.0', 'database@1.5.0'],
      });

      expect(module.dependencies).toEqual(['auth@1.0.0', 'users@2.0.0', 'database@1.5.0']);
    });

    it('should handle modules with custom configuration', () => {
      const module = defineModule({
        name: 'configurable-module',
        version: '1.0.0',
        config: {
          apiEndpoint: 'https://api.example.com',
          timeout: 5000,
          retries: 3,
          features: {
            caching: true,
            logging: false,
            analytics: true,
          },
        },
      });

      expect(module.config).toEqual({
        apiEndpoint: 'https://api.example.com',
        timeout: 5000,
        retries: 3,
        features: {
          caching: true,
          logging: false,
          analytics: true,
        },
      });
    });

    it('should handle modules with no routes or sockets', () => {
      const module = defineModule({
        name: 'config-only-module',
        version: '1.0.0',
        config: {
          setting1: 'value1',
          setting2: 42,
          setting3: true,
        },
      });

      expect(module.name).toBe('config-only-module');
      expect(module.version).toBe('1.0.0');
      expect(module.config).toBeDefined();
      expect(module.routes).toBeUndefined();
      expect(module.sockets).toBeUndefined();
    });
  });

  describe('isNextError', () => {
    it('follows the (req, res, next) contract', () => {
      expect(isNextError(new Error('x'))).toBe(true);
      expect(isNextError('boom')).toBe(true);
      expect(isNextError({ status: 401 })).toBe(true);
      expect(isNextError(undefined)).toBe(false);
      expect(isNextError(null)).toBe(false);
      expect(isNextError(false)).toBe(false);
      expect(isNextError('route')).toBe(false);
      expect(isNextError('router')).toBe(false);
    });
  });

  describe('warnUnsupportedAuthKeys', () => {
    it('names the keys route auth does not apply', () => {
      expect(
        warnUnsupportedAuthKeys({ roles: ['admin'], permissions: ['x'], optional: true }, 't')
      ).toEqual([]);
      expect(
        warnUnsupportedAuthKeys({ required: true, validator: () => true, roles: ['admin'] }, 't')
      ).toEqual([]);
      expect(warnUnsupportedAuthKeys({ roles: ['admin'], owner: true, scope: 'x' }, 't')).toEqual([
        'owner',
        'scope',
      ]);
      expect(warnUnsupportedAuthKeys(undefined, 't')).toEqual([]);
    });

    it('refuses a validator that is not a function', () => {
      expect(() => warnUnsupportedAuthKeys({ validator: 'owner' }, 'GET /orders/:id')).toThrow(
        /GET \/orders\/:id: auth\.validator must be a function/
      );
    });

    it('says that required: false does not make sign-in optional', () => {
      globalLogger.setLevel('debug');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      const warned = () =>
        log.mock.calls.filter(call => call[0] === 'warn').map(call => String(call[1]));
      try {
        warnUnsupportedAuthKeys({ required: true }, 'GET /a');
        warnUnsupportedAuthKeys({ required: false, optional: true }, 'GET /b');
        expect(warned()).toEqual([]);

        warnUnsupportedAuthKeys({ required: false }, 'GET /c');
        expect(warned()).toHaveLength(1);
        expect(warned()[0]).toContain('GET /c');
        expect(warned()[0]).toContain('optional: true');
      } finally {
        log.mockRestore();
        globalLogger.setLevel('fatal');
      }
    });
  });

  // A response double with what the router and its phases touch.
  const fakeRes = () => {
    const res: any = {
      headersSent: false,
      statusCode: 200,
      headers: {} as Record<string, string>,
      sent: [] as any[],
      setHeader(name: string, value: string) {
        res.headers[name.toLowerCase()] = value;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: any) {
        res.sent.push(body);
        res.headersSent = true;
      },
    };
    return res;
  };
  const fakeReq = (path: string, extra: Record<string, unknown> = {}) =>
    ({ method: 'GET', path, params: {}, query: {}, headers: {}, requestId: 'r1', ...extra }) as any;
  const dispatch = async (router: UnifiedRouter, req: any) => {
    const res = fakeRes();
    await router.handleRequest(req, res);
    return res;
  };

  describe('the current router', () => {
    const paths = (router: UnifiedRouter) => router.getAllRoutes().map(route => route.path);

    it('is one router until an app is created, and that app takes it over', () => {
      const standalone = UnifiedRouter.getInstance();
      expect(UnifiedRouter.getInstance()).toBe(standalone);
      createRoute('GET', '/registered-early').handler(() => ({}));

      const first = UnifiedRouter.createForApp();
      expect(first).toBe(standalone);
      expect(paths(first)).toEqual(['/registered-early']);
      expect(UnifiedRouter.getInstance()).toBe(first);
    });

    it('is a new, empty router for every further app, the newest one being current', () => {
      const first = UnifiedRouter.createForApp();
      first.get('/first-only').handler(() => ({}));

      const second = UnifiedRouter.createForApp();
      expect(second).not.toBe(first);
      expect(paths(second)).toEqual([]);
      expect(UnifiedRouter.getInstance()).toBe(second);

      createRoute('GET', '/standalone').handler(() => ({}));
      expect(paths(second)).toEqual(['/standalone']);
      expect(paths(first)).toEqual(['/first-only']);
      expect(first.matchRoute('GET', '/standalone')).toBeUndefined();
      expect(second.matchRoute('GET', '/first-only')).toBeUndefined();
    });

    it('goes back to the newest app still open when an app is closed', () => {
      const first = UnifiedRouter.createForApp();
      const second = UnifiedRouter.createForApp();
      const third = UnifiedRouter.createForApp();

      UnifiedRouter.setClosed(third, true);
      expect(UnifiedRouter.getInstance()).toBe(second);
      UnifiedRouter.setClosed(first, true);
      expect(UnifiedRouter.getInstance()).toBe(second);

      // Every app closed: the one created last
      UnifiedRouter.setClosed(second, true);
      expect(UnifiedRouter.getInstance()).toBe(third);

      // Listening again makes an app count as open again
      UnifiedRouter.setClosed(first, false);
      expect(UnifiedRouter.getInstance()).toBe(first);
    });

    it('is the router of the app loading its route files for as long as that lasts', () => {
      const first = UnifiedRouter.createForApp();
      const second = UnifiedRouter.createForApp();

      const done = UnifiedRouter.enterLoading(first);
      expect(UnifiedRouter.getInstance()).toBe(first);
      // An app created meanwhile does not take the place of the one loading
      const third = UnifiedRouter.createForApp();
      expect(UnifiedRouter.getInstance()).toBe(first);
      done();

      expect(UnifiedRouter.getInstance()).toBe(third);
      expect(second).not.toBe(third);
    });

    it('counts a rate limit on the router it is checked on', async () => {
      const first = UnifiedRouter.createForApp();
      const second = UnifiedRouter.createForApp();
      const request = () => ({ method: 'GET', path: '/metered', ip: '10.0.0.1', headers: {} });
      const limit = { requests: 1, window: 60000 };

      const allowed = fakeRes();
      await first.checkRateLimit(request() as any, allowed, limit);
      const refused = fakeRes();
      await first.checkRateLimit(request() as any, refused, limit);
      expect(allowed.headersSent).toBe(false);
      expect(refused.statusCode).toBe(429);

      const elsewhere = fakeRes();
      await second.checkRateLimit(request() as any, elsewhere, limit);
      expect(elsewhere.headersSent).toBe(false);
    });

    it('reset() empties every app’s router and starts over', () => {
      const first = UnifiedRouter.createForApp();
      const second = UnifiedRouter.createForApp();
      first.get('/a').handler(() => ({}));
      second.get('/b').handler(() => ({}));

      UnifiedRouter.reset();

      expect(paths(first)).toEqual([]);
      expect(paths(second)).toEqual([]);
      const fresh = UnifiedRouter.getInstance();
      expect(fresh).not.toBe(first);
      expect(fresh).not.toBe(second);
      // Closing an app from before the reset does not bring its router back
      UnifiedRouter.setClosed(second, true);
      expect(UnifiedRouter.getInstance()).toBe(fresh);
    });
  });

  describe('route auth validator', () => {
    let router: UnifiedRouter;
    beforeEach(() => {
      router = UnifiedRouter.getInstance();
      router.clearAllRoutes();
    });

    const signedIn = (id: string) => ({ isAuthenticated: true, user: { id, roles: ['user'] } });

    it('is called with the request and denies with 403 on a falsy result', async () => {
      const seen: string[] = [];
      let handled = 0;
      router
        .get('/users/:id/orders')
        .auth({
          required: true,
          validator: (req: any) => {
            seen.push(req.params.id);
            return req.auth.user.id === req.params.id;
          },
        })
        .handler(() => {
          handled++;
          return { orders: [] };
        });

      const own = await dispatch(router, fakeReq('/users/u1/orders', { auth: signedIn('u1') }));
      expect(own.statusCode).toBe(200);
      expect(own.sent).toEqual([{ orders: [] }]);

      const other = await dispatch(router, fakeReq('/users/u2/orders', { auth: signedIn('u1') }));
      expect(other.statusCode).toBe(403);
      expect(seen).toEqual(['u1', 'u2']);
      expect(handled).toBe(1);
    });

    it('waits for an async validator and treats a rejection or a throw as a denial', async () => {
      let handled = 0;
      const handler = () => {
        handled++;
        return { ok: true };
      };
      router
        .get('/slow/:id')
        .auth({ validator: async (req: any) => req.params.id === 'mine' })
        .handler(handler);
      router
        .get('/rejects')
        .auth({ validator: () => Promise.reject(new Error('lookup failed')) })
        .handler(handler);
      router
        .get('/throws')
        .auth({
          validator: () => {
            throw new Error('lookup failed');
          },
        })
        .handler(handler);

      const auth = signedIn('u1');
      expect((await dispatch(router, fakeReq('/slow/mine', { auth }))).statusCode).toBe(200);
      expect((await dispatch(router, fakeReq('/slow/theirs', { auth }))).statusCode).toBe(403);
      expect((await dispatch(router, fakeReq('/rejects', { auth }))).statusCode).toBe(403);
      expect((await dispatch(router, fakeReq('/throws', { auth }))).statusCode).toBe(403);
      expect(handled).toBe(1);
    });

    it('runs after the sign-in and role checks, never instead of them', async () => {
      let validated = 0;
      router
        .get('/admin/:id')
        .auth({
          roles: ['admin'],
          validator: () => {
            validated++;
            return true;
          },
        })
        .handler(() => ({ ok: true }));

      const anonymous = await dispatch(
        router,
        fakeReq('/admin/1', { auth: { isAuthenticated: false } })
      );
      expect(anonymous.statusCode).toBe(401);
      const wrongRole = await dispatch(router, fakeReq('/admin/1', { auth: signedIn('u1') }));
      expect(wrongRole.statusCode).toBe(403);
      expect(validated).toBe(0);

      const admin = { isAuthenticated: true, user: { id: 'a1', roles: ['admin'] } };
      expect((await dispatch(router, fakeReq('/admin/1', { auth: admin }))).statusCode).toBe(200);
      expect(validated).toBe(1);
    });

    it('is the whole check when no auth middleware is installed: 401 with required, else 403', async () => {
      const byHeader = (req: any) => req.headers['x-api-key'] === 'k1';
      router
        .get('/keyed')
        .auth({ required: true, validator: byHeader })
        .handler(() => ({ ok: true }));
      router
        .get('/keyed-403')
        .auth({ validator: byHeader })
        .handler(() => ({ ok: true }));

      const ok = await dispatch(router, fakeReq('/keyed', { headers: { 'x-api-key': 'k1' } }));
      expect(ok.statusCode).toBe(200);
      expect((await dispatch(router, fakeReq('/keyed'))).statusCode).toBe(401);
      expect((await dispatch(router, fakeReq('/keyed-403'))).statusCode).toBe(403);
    });

    it('applies to the schema-first form as well', async () => {
      router.route({
        method: 'GET',
        path: '/docs/:id',
        auth: { validator: (req: any) => req.params.id === 'public' },
        handler: () => ({ ok: true }),
      });
      const auth = signedIn('u1');
      expect((await dispatch(router, fakeReq('/docs/public', { auth }))).statusCode).toBe(200);
      expect((await dispatch(router, fakeReq('/docs/secret', { auth }))).statusCode).toBe(403);
    });
  });

  describe('route cache and the guards of the route', () => {
    let router: UnifiedRouter;
    beforeEach(() => {
      router = UnifiedRouter.getInstance();
      router.clearAllRoutes();
    });

    const guard = (req: any, res: any, next: () => void) => {
      if (req.headers.authorization !== 'Bearer s3cret') {
        res.status(401).json({ error: 'denied' });
        return;
      }
      next();
    };
    const allowed = { headers: { authorization: 'Bearer s3cret' } };

    it.each([
      ['.use()', (b: any) => b.use(guard)],
      ['.after()', (b: any) => b.after(guard)],
    ])('serves a hit only to a request that passed a %s guard', async (name, attach) => {
      let calls = 0;
      const path = `/reports/${name.replace(/\W/g, '')}`;
      attach(router.get(path).cache({ ttl: 60, shared: true })).handler(() => ({
        report: ++calls,
      }));

      const first = await dispatch(router, fakeReq(path, allowed));
      expect(first.sent).toEqual([{ report: 1 }]);
      expect(first.headers['x-cache']).toBe('MISS');

      const denied = await dispatch(router, fakeReq(path));
      expect(denied.statusCode).toBe(401);
      expect(denied.sent).toEqual([{ error: 'denied' }]);

      const second = await dispatch(router, fakeReq(path, allowed));
      expect(second.sent).toEqual([{ report: 1 }]);
      expect(second.headers['x-cache']).toBe('HIT');
      expect(calls).toBe(1);
    });

    it('holds for middleware given as an array, as createRouter() mounts it', async () => {
      let calls = 0;
      router.registerRoute({
        method: 'GET',
        path: '/mounted',
        middleware: [guard],
        cache: { ttl: 60, shared: true },
        handler: () => ({ report: ++calls }),
      });

      expect((await dispatch(router, fakeReq('/mounted', allowed))).sent).toEqual([{ report: 1 }]);
      expect((await dispatch(router, fakeReq('/mounted'))).statusCode).toBe(401);
      const hit = await dispatch(router, fakeReq('/mounted', allowed));
      expect(hit.headers['x-cache']).toBe('HIT');
    });
  });

  describe('optional parameters and wildcards', () => {
    let router: UnifiedRouter;
    beforeEach(() => {
      UnifiedRouter.reset();
      router = UnifiedRouter.getInstance();
    });
    afterEach(() => UnifiedRouter.reset());

    const answer = (route: string) => (req: any) => ({ route, params: req.params });
    const answerOf = async (path: string, extra: Record<string, unknown> = {}) => {
      const res = fakeRes();
      const handled = await router.handleRequest(fakeReq(path, extra), res);
      if (!handled) return 404;
      return res.statusCode === 200 ? res.sent[0] : res.statusCode;
    };
    // Every order a list of registrations can be made in
    const orders = <T>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            orders([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest])
          );

    it('names an optional parameter without the ?, and leaves its key out when the path does', async () => {
      router.get('/users/:id?').handler(answer('/users/:id?'));

      expect(await answerOf('/users/7')).toEqual({ route: '/users/:id?', params: { id: '7' } });
      const without = await answerOf('/users');
      expect(without).toEqual({ route: '/users/:id?', params: {} });
      expect('id' in without.params).toBe(false);
      expect(await answerOf('/users/')).toEqual({ route: '/users/:id?', params: {} });
      expect(await answerOf('/users/7/8')).toBe(404);
    });

    it('hands a wildcard the rest of the path, and nothing to a path that stops short', async () => {
      router.get('/files/*').handler(answer('/files/*'));
      router.get('/dl/*path').handler(answer('/dl/*path'));

      expect(await answerOf('/files/a/b.txt')).toEqual({
        route: '/files/*',
        params: { '*': 'a/b.txt' },
      });
      expect(await answerOf('/files/')).toEqual({ route: '/files/*', params: { '*': '' } });
      expect(await answerOf('/files')).toBe(404);
      expect(await answerOf('/files//x')).toBe(404);
      expect(await answerOf('/dl/a/b')).toEqual({ route: '/dl/*path', params: { path: 'a/b' } });
      // Dot segments stay in the value; the request does not reach another route
      router.get('/secret').handler(answer('/secret'));
      expect(await answerOf('/files/../secret')).toEqual({
        route: '/files/*',
        params: { '*': '../secret' },
      });
    });

    it('prefers fixed text, then a required parameter, then an optional one, then a wildcard, in any registration order', async () => {
      const routes = ['/things/new', '/things/:id', '/things/:id?', '/things/*', '/things/big/*'];
      for (const order of orders(routes)) {
        router.clearAllRoutes();
        for (const path of order) router.get(path).handler(answer(path));
        const answers = {
          new: (await answerOf('/things/new')).route,
          seven: (await answerOf('/things/7')).route,
          bare: (await answerOf('/things')).route,
          slash: (await answerOf('/things/')).route,
          deep: (await answerOf('/things/7/8')).route,
          big: (await answerOf('/things/big/x')).route,
        };
        expect([order, answers]).toEqual([
          order,
          {
            new: '/things/new',
            seven: '/things/:id',
            bare: '/things/:id?',
            slash: '/things/:id?',
            deep: '/things/*',
            big: '/things/big/*',
          },
        ]);
      }
    });

    it('reports the route as registered from matchRoute()', () => {
      router.get('/users/:id?').handler(answer('u'));
      router.get('/files/*').handler(answer('f'));

      expect(router.matchRoute('GET', '/users')).toBe('/users/:id?');
      expect(router.matchRoute('GET', '/users/7')).toBe('/users/:id?');
      expect(router.matchRoute('GET', '/files/a/b')).toBe('/files/*');
      expect(router.matchRoute('GET', '/files')).toBeUndefined();
      expect(router.matchRoute('POST', '/users')).toBeUndefined();
    });

    it.each([
      ['/users/:id?/posts', "the optional parameter ':id?' is followed by 'posts'"],
      ['/users/:id?.json', "'?' makes a parameter optional only when"],
      ['/files/*/meta', "the wildcard '*' must be the last segment"],
      ['/files/*rest/meta', "the wildcard '*rest' must be the last segment"],
    ])('refuses %s when it is registered, in every form', (path, reason) => {
      const handler = () => ({});
      const forms: Array<() => unknown> = [
        () => router.get(path).handler(handler),
        () => router.addRoute('GET', path, handler),
        () => router.route({ method: 'GET', path, handler }),
        () => createRoute('GET', path).handler(handler),
      ];
      for (const register of forms) {
        expect(register).toThrow(`GET ${path}: `);
        expect(register).toThrow(reason);
      }
      expect(router.getAllRoutes()).toEqual([]);
    });

    it('says nothing about these paths, and names a * or ? that is neither form', () => {
      globalLogger.setLevel('debug');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      const warned = () =>
        log.mock.calls.filter(call => call[0] === 'warn').map(call => String(call[1]));
      try {
        for (const path of ['/users/:id?', '/a/:b?/:c?', '/files/*', '/files/*path', '/c++']) {
          router.get(path).handler(() => ({}));
        }
        expect(warned()).toEqual([]);

        router.get('/glob/**').handler(() => ({}));
        expect(warned()).toHaveLength(1);
        expect(warned()[0]).toContain("Route GET /glob/** contains '*' where it is not a wildcard");

        // What the path has beside the wildcard is still named
        router.get('/re/:id(\\d+)/*').handler(() => ({}));
        expect(warned()).toHaveLength(2);
        expect(warned()[1]).toContain("contains '(', ");
        expect(warned()[1]).toContain('patterns are not supported');
        expect(warned()[1]).not.toContain("'*',");
      } finally {
        log.mockRestore();
        globalLogger.setLevel('fatal');
      }
    });

    it('validates params on such a route', async () => {
      router
        .get('/items/:id?')
        .params(z.object({ id: z.string().regex(/^\d+$/).optional() }))
        .handler(answer('/items/:id?'));
      router
        .get('/texts/*')
        .params(z.object({ '*': z.string().endsWith('.txt') }))
        .handler(answer('/texts/*'));

      expect((await answerOf('/items')).params).toEqual({});
      expect((await answerOf('/items/12')).params).toEqual({ id: '12' });
      expect(await answerOf('/items/twelve')).toBe(400);
      expect((await answerOf('/texts/a/b.txt')).params).toEqual({ '*': 'a/b.txt' });
      expect(await answerOf('/texts/a/b.bin')).toBe(400);
    });

    it('counts one rate limit for the route, whichever path reached it', async () => {
      router
        .get('/limited/:id?')
        .rateLimit({ requests: 2, window: 60000 })
        .handler(answer('/limited/:id?'));
      const from = { ip: '10.0.0.9' };

      expect((await answerOf('/limited', from)).route).toBe('/limited/:id?');
      expect((await answerOf('/limited/1', from)).route).toBe('/limited/:id?');
      expect(await answerOf('/limited/2', from)).toBe(429);
    });

    it('applies auth and the route cache', async () => {
      let calls = 0;
      router
        .get('/vault/*')
        .auth({ roles: ['admin'] })
        .cache({ ttl: 60, shared: true })
        .handler((req: any) => ({ file: req.params['*'], call: ++calls }));
      const admin = { auth: { isAuthenticated: true, user: { id: 'a', roles: ['admin'] } } };

      expect(await answerOf('/vault/a/b', { auth: { isAuthenticated: false } })).toBe(401);
      expect(await answerOf('/vault/a/b', admin)).toEqual({ file: 'a/b', call: 1 });
      expect(await answerOf('/vault/a/b', admin)).toEqual({ file: 'a/b', call: 1 });
      expect(await answerOf('/vault/c', admin)).toEqual({ file: 'c', call: 2 });
    });
  });

  // The route table a server keeps for routes added to it directly
  // (server.get(path, handler)); an app's routes are matched by its router.
  describe.each([
    ['MoroHttpServer', () => new MoroHttpServer()],
    ['MoroHttp2Server', () => new MoroHttp2Server()],
  ])('the route table of %s', (_name, create) => {
    it('finds routes with optional parameters and wildcards for paths of any length', () => {
      const server: any = create();
      const handler = () => {};
      // Parameter routes of two and three segments, so those lengths have
      // routes of their own to be looked up among
      server.get('/a/:x', handler);
      server.get('/a/:x/:y', handler);
      server.get('/users/:id?', handler);
      server.get('/files/*', handler);
      const found = (path: string) => server.findRoute('GET', path)?.path ?? null;

      expect(found('/a/1')).toBe('/a/:x');
      expect(found('/users')).toBe('/users/:id?');
      expect(found('/users/7')).toBe('/users/:id?');
      expect(found('/users/7/8')).toBeNull();
      expect(found('/files/a')).toBe('/files/*');
      expect(found('/files/a/b')).toBe('/files/*');
      expect(found('/files/a/b/c/d')).toBe('/files/*');
      expect(found('/files')).toBeNull();
      expect(found('/files/a//b')).toBeNull();
      expect(server.findRoute('GET', '/users/7').paramNames).toEqual(['id']);
      expect(() => server.get('/files/*/meta', handler)).toThrow('must be the last segment');
    });
  });

  describe('request targets the router does not match', () => {
    let router: UnifiedRouter;
    beforeEach(() => {
      router = UnifiedRouter.getInstance();
      router.clearAllRoutes();
      router.get('/admin/users/:id').handler((req: any) => ({ id: req.params.id }));
      router.get('/admin/static').handler(() => ({ ok: true }));
    });

    it.each(['//admin/users/1', '/admin//users/1', '/admin/users//1', '/admin/users/1//'])(
      'does not match %s, which a prefix check on req.path would not recognise',
      async target => {
        const res = fakeRes();
        expect(await router.handleRequest(fakeReq(target), res)).toBe(false);
        expect(res.headersSent).toBe(false);
        expect(router.matchRoute('GET', target)).toBeUndefined();

        // The path as registered, and with one trailing slash, still matches.
        expect((await dispatch(router, fakeReq('/admin/users/1'))).sent).toEqual([{ id: '1' }]);
        expect((await dispatch(router, fakeReq('/admin/users/1/'))).sent).toEqual([{ id: '1' }]);
        expect(router.matchRoute('GET', '/admin/users/1')).toBe('/admin/users/:id');
      }
    );

    it('answers 400 to a target with no leading slash, as the Node parser does', async () => {
      for (const target of ['admin/users/1', 'admin/static']) {
        const res = fakeRes();
        expect(await router.handleRequest(fakeReq(target), res)).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(router.matchRoute('GET', target)).toBeUndefined();
      }
      // "*" and an absolute-form target are valid request targets with no
      // route: they are left to the 404 of the server.
      for (const target of ['*', 'http://example.com/admin/users/1']) {
        const res = fakeRes();
        expect(await router.handleRequest(fakeReq(target), res)).toBe(false);
        expect(res.headersSent).toBe(false);
      }
    });
  });

  describe('auth guard factories passed uncalled', () => {
    it('are recognised; a guard that was called, or any other function, is not', () => {
      for (const factory of [
        requireAuth,
        requireRole,
        requirePermission,
        requireAdmin,
        guestOnly,
        optionalAuth,
      ]) {
        expect(warnUncalledGuard(factory, 't')).toBe(true);
      }
      expect(warnUncalledGuard(requireAuth(), 't')).toBe(false);
      expect(warnUncalledGuard(requireRole('admin'), 't')).toBe(false);
      expect(warnUncalledGuard((_req: any, _res: any, next: () => void) => next(), 't')).toBe(
        false
      );
      expect(warnUncalledGuard(undefined, 't')).toBe(false);
    });

    it('are named when a route is registered with one', () => {
      globalLogger.setLevel('debug');
      const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      const warned = () =>
        log.mock.calls.filter(call => call[0] === 'warn').map(call => String(call[1]));
      try {
        createRoute('GET', '/guarded-properly')
          .before(requireAuth())
          .handler(() => ({ ok: true }));
        expect(warned().filter(message => message.includes('passed uncalled'))).toEqual([]);

        createRoute('GET', '/guarded-in-name-only')
          .before(requireAuth as any)
          .handler(() => ({ ok: true }));
        const messages = warned().filter(message => message.includes('passed uncalled'));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('GET /guarded-in-name-only');
        expect(messages[0]).toContain("'requireAuth'");
        expect(messages[0]).toContain('requireAuth()');
      } finally {
        log.mockRestore();
        globalLogger.setLevel('fatal');
      }
    });
  });
});
