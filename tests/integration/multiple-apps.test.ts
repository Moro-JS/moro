// @ts-nocheck
// Integration Tests - several apps in one process
//
// Each app owns its routes, the rate-limit counters and cached responses of
// those routes, its module routes, its documentation and its configuration.
// Two apps listening on two ports (a public API and an admin app, an app and
// a test double) share none of them.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createApp,
  createRoute,
  defineModule,
  defineRoute,
  getApp,
  getGlobalConfig,
  middleware,
  resetConfig,
  z,
} from '../../src/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { engineLoadable } from './engine-test-utils.js';

// The documentation system serves Swagger UI from the optional swagger-ui-dist
// package and looks for it from the working directory. This runs `build` in a
// directory where a package of that name is installed.
function withSwaggerUiPackage(build: () => void): void {
  const root = mkdtempSync(join(tmpdir(), 'moro-apps-docs-'));
  mkdirSync(join(root, 'node_modules', 'swagger-ui-dist'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', 'swagger-ui-dist', 'package.json'),
    JSON.stringify({ name: 'swagger-ui-dist', version: '0.0.0' })
  );
  const cwd = jest.spyOn(process, 'cwd').mockReturnValue(root);
  try {
    build();
  } finally {
    cwd.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}

const servers = engineLoadable ? (['node', 'moro'] as const) : (['node'] as const);

describe.each(servers)('several apps in one process (%s server)', engine => {
  const apps: any[] = [];

  async function create(options: any = {}): Promise<any> {
    const app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      ...options,
      server: { engine, ...(options.server ?? {}) },
    });
    apps.push(app);
    return app;
  }

  // Listens on a port the operating system picks and returns the app's URL
  async function listen(app: any): Promise<string> {
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${app.address().port}`;
  }

  const status = async (url: string, init?: any) => (await fetch(url, init)).status;
  const json = async (url: string, init?: any) => (await fetch(url, init)).json();

  async function close(app: any): Promise<void> {
    apps.splice(apps.indexOf(app), 1);
    await app.close();
  }

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      await app.close();
    }
    resetConfig();
  });

  describe('routes', () => {
    it('answers a route only on the app it was registered on', async () => {
      const publicApp = await create();
      const adminApp = await create();
      publicApp.get('/products', () => ({ from: 'public' }));
      adminApp.get('/internal/users', () => ({ from: 'admin' }));
      adminApp.get('/internal/users/:id', (req: any) => ({ from: 'admin', id: req.params.id }));
      adminApp.get('/internal/banner').handler('admin only');

      const publicUrl = await listen(publicApp);
      const adminUrl = await listen(adminApp);

      expect(await json(`${publicUrl}/products`)).toEqual({ from: 'public' });
      expect(await json(`${adminUrl}/internal/users`)).toEqual({ from: 'admin' });
      expect(await json(`${adminUrl}/internal/users/7`)).toEqual({ from: 'admin', id: '7' });

      expect(await status(`${publicUrl}/internal/users`)).toBe(404);
      expect(await status(`${publicUrl}/internal/users/7`)).toBe(404);
      expect(await status(`${publicUrl}/internal/banner`)).toBe(404);
      expect(await status(`${adminUrl}/products`)).toBe(404);
    });

    it('runs each app’s own handler for a path both register', async () => {
      const first = await create();
      const second = await create();
      first.get('/whoami', () => ({ app: 'first' }));
      second.get('/whoami', () => ({ app: 'second' }));
      first.get('/item/:id').handler((req: any) => ({ app: 'first', id: req.params.id }));
      second.get('/item/:id').handler((req: any) => ({ app: 'second', id: req.params.id }));

      const firstUrl = await listen(first);
      const secondUrl = await listen(second);

      expect(await json(`${firstUrl}/whoami`)).toEqual({ app: 'first' });
      expect(await json(`${secondUrl}/whoami`)).toEqual({ app: 'second' });
      expect(await json(`${firstUrl}/item/1`)).toEqual({ app: 'first', id: '1' });
      expect(await json(`${secondUrl}/item/1`)).toEqual({ app: 'second', id: '1' });
    });

    it('gives each app its own error handler', async () => {
      const first = await create();
      const second = await create();
      first.setErrorHandler((_err: any, _req: any, res: any) => {
        res.status(500).json({ handledBy: 'first' });
      });
      second.setErrorHandler((_err: any, _req: any, res: any) => {
        res.status(500).json({ handledBy: 'second' });
      });
      first.get('/boom').handler(() => {
        throw new Error('first failed');
      });
      second.get('/boom').handler(() => {
        throw new Error('second failed');
      });

      const firstUrl = await listen(first);
      const secondUrl = await listen(second);

      expect(await json(`${firstUrl}/boom`)).toEqual({ handledBy: 'first' });
      expect(await json(`${secondUrl}/boom`)).toEqual({ handledBy: 'second' });
    });

    it('keeps one app serving its own routes when the other is closed', async () => {
      const kept = await create();
      const closed = await create();
      kept.get('/kept', () => ({ ok: true }));
      closed.get('/closed', () => ({ ok: true }));

      const keptUrl = await listen(kept);
      const closedUrl = await listen(closed);
      expect(await status(`${closedUrl}/closed`)).toBe(200);

      await close(closed);

      expect(await json(`${keptUrl}/kept`)).toEqual({ ok: true });
      expect(await status(`${keptUrl}/closed`)).toBe(404);
      await expect(fetch(`${closedUrl}/closed`)).rejects.toThrow();

      // The app that is still open is the current one again
      expect(getApp()).toBe(kept);
      createRoute('GET', '/added-later').handler(() => ({ on: 'kept' }));
      expect(await json(`${keptUrl}/added-later`)).toEqual({ on: 'kept' });
    });
  });

  describe('route-level rate limits', () => {
    it('counts each app’s requests on its own counters', async () => {
      const first = await create();
      const second = await create();
      for (const app of [first, second]) {
        app
          .get('/limited')
          .rateLimit({ requests: 2, window: 60000 })
          .handler(() => ({ ok: true }));
        app.get('/limited-direct', () => ({ ok: true }), {
          rateLimit: { requests: 1, window: 60000 },
        });
      }
      const firstUrl = await listen(first);
      const secondUrl = await listen(second);

      expect(await status(`${firstUrl}/limited`)).toBe(200);
      expect(await status(`${firstUrl}/limited`)).toBe(200);
      expect(await status(`${firstUrl}/limited`)).toBe(429);
      expect(await status(`${firstUrl}/limited-direct`)).toBe(200);
      expect(await status(`${firstUrl}/limited-direct`)).toBe(429);

      // The second app has served nothing yet: its allowance is untouched
      expect(await status(`${secondUrl}/limited`)).toBe(200);
      expect(await status(`${secondUrl}/limited`)).toBe(200);
      expect(await status(`${secondUrl}/limited`)).toBe(429);
      expect(await status(`${secondUrl}/limited-direct`)).toBe(200);
    });

    it('counts a module route on the counters of the app that loaded the module', async () => {
      const first = await create();
      const second = await create();
      for (const app of [first, second]) {
        await app.loadModule(
          defineModule({
            name: 'tickets',
            version: '1.0.0',
            routes: [
              {
                method: 'GET',
                path: '/next',
                rateLimit: { requests: 1, window: 60000 },
                handler: async () => ({ ok: true }),
              },
            ],
          })
        );
      }
      const firstUrl = await listen(first);
      const secondUrl = await listen(second);
      const path = '/api/v1.0.0/tickets/next';

      expect(await status(`${firstUrl}${path}`)).toBe(200);
      expect(await status(`${firstUrl}${path}`)).toBe(429);
      expect(await status(`${secondUrl}${path}`)).toBe(200);
    });

    it('names the matched route from the router of the app that got the request', async () => {
      // middleware.rateLimit() keeps one counter per registered route. The
      // second app has no '/orders/:id' route, so its requests are counted
      // per path, whatever the first app registered.
      const withRoute = await create();
      const without = await create();
      withRoute.get('/orders/:id', (req: any) => ({ id: req.params.id }));
      await withRoute.use(middleware.rateLimit({ requests: 2, window: 60000 }));
      await without.use(middleware.rateLimit({ requests: 2, window: 60000 }));

      const withRouteUrl = await listen(withRoute);
      const withoutUrl = await listen(without);

      expect(await status(`${withRouteUrl}/orders/1`)).toBe(200);
      expect(await status(`${withRouteUrl}/orders/2`)).toBe(200);
      expect(await status(`${withRouteUrl}/orders/3`)).toBe(429);

      expect(await status(`${withoutUrl}/orders/1`)).toBe(404);
      expect(await status(`${withoutUrl}/orders/2`)).toBe(404);
      expect(await status(`${withoutUrl}/orders/3`)).toBe(404);
    });
  });

  describe('route caching', () => {
    it('stores each app’s responses in its own cache', async () => {
      const first = await create();
      const second = await create();
      let firstCalls = 0;
      let secondCalls = 0;
      // The same key on both apps: one store would serve the first app's
      // response from the second.
      first
        .get('/first-report')
        .cache({ ttl: 60, key: 'report' })
        .handler(() => ({ app: 'first', calls: ++firstCalls }));
      second
        .get('/second-report')
        .cache({ ttl: 60, key: 'report' })
        .handler(() => ({ app: 'second', calls: ++secondCalls }));

      const firstUrl = await listen(first);
      const secondUrl = await listen(second);

      expect(await json(`${firstUrl}/first-report`)).toEqual({ app: 'first', calls: 1 });
      expect(await json(`${firstUrl}/first-report`)).toEqual({ app: 'first', calls: 1 });

      const fromSecond = await fetch(`${secondUrl}/second-report`);
      expect(fromSecond.headers.get('x-cache')).not.toBe('HIT');
      expect(await fromSecond.json()).toEqual({ app: 'second', calls: 1 });
      expect(await json(`${secondUrl}/second-report`)).toEqual({ app: 'second', calls: 1 });
      expect(firstCalls).toBe(1);
      expect(secondCalls).toBe(1);
    });

    it('sizes each app’s cache from that app’s configuration', async () => {
      const small = await create({ modules: { cache: { maxSize: 1 } } });
      const roomy = await create();
      const calls = { small: 0, roomy: 0 };
      small
        .get('/page/:n')
        .cache({ ttl: 60 })
        .handler(() => ({ calls: ++calls.small }));
      roomy
        .get('/page/:n')
        .cache({ ttl: 60 })
        .handler(() => ({ calls: ++calls.roomy }));

      const smallUrl = await listen(small);
      const roomyUrl = await listen(roomy);

      // One entry at most: the second page pushes the first out
      await json(`${smallUrl}/page/1`);
      await json(`${smallUrl}/page/2`);
      await json(`${smallUrl}/page/1`);
      expect(calls.small).toBe(3);

      // The app created after it keeps both
      await json(`${roomyUrl}/page/1`);
      await json(`${roomyUrl}/page/2`);
      await json(`${roomyUrl}/page/1`);
      expect(calls.roomy).toBe(2);
    });
  });

  describe('modules', () => {
    it('serves a module only from the app that loaded it', async () => {
      const first = await create();
      const second = await create();
      await first.loadModule(
        defineModule({
          name: 'billing',
          version: '1.0.0',
          routes: [{ method: 'GET', path: '/invoices', handler: async () => ({ app: 'first' }) }],
        })
      );
      await second.loadModule(
        defineModule({
          name: 'reports',
          version: '1.0.0',
          routes: [{ method: 'GET', path: '/daily', handler: async () => ({ app: 'second' }) }],
        })
      );
      const firstUrl = await listen(first);
      const secondUrl = await listen(second);

      expect(await json(`${firstUrl}/api/v1.0.0/billing/invoices`)).toEqual({ app: 'first' });
      expect(await json(`${secondUrl}/api/v1.0.0/reports/daily`)).toEqual({ app: 'second' });
      expect(await status(`${firstUrl}/api/v1.0.0/reports/daily`)).toBe(404);
      expect(await status(`${secondUrl}/api/v1.0.0/billing/invoices`)).toBe(404);
    });
  });

  describe('configuration', () => {
    it('applies each app’s own body size limit', async () => {
      const strict = await create({ server: { bodySizeLimit: '1kb' } });
      const roomy = await create({ server: { bodySizeLimit: '1mb' } });
      for (const app of [strict, roomy]) {
        app.post('/echo', (req: any) => ({ length: req.body.text.length }));
      }
      const strictUrl = await listen(strict);
      const roomyUrl = await listen(roomy);

      const post = (url: string) =>
        fetch(`${url}/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'x'.repeat(8 * 1024) }),
        });

      expect((await post(strictUrl)).status).toBe(413);
      const accepted = await post(roomyUrl);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ length: 8 * 1024 });
    });

    it('gives each app the configuration it was created with', async () => {
      const first = await create({
        server: { bodySizeLimit: '1kb' },
        modules: { apiPrefix: '/v1' },
      });
      const second = await create({ server: { bodySizeLimit: '2mb' } });

      expect(first.getConfig().server.bodySizeLimit).toBe('1kb');
      expect(first.getConfig().modules.apiPrefix).toBe('/v1');
      expect(second.getConfig().server.bodySizeLimit).toBe('2mb');
      expect(second.getConfig().modules.apiPrefix).not.toBe('/v1');
      expect(second.getConfig()).not.toBe(first.getConfig());

      // getGlobalConfig() is the current app's: the one created last
      expect(getGlobalConfig()).toBe(second.getConfig());
      // ...and the first app's again once the second is closed
      await close(second);
      expect(getGlobalConfig()).toBe(first.getConfig());
    });

    it('applies a configured global rate limit to the app that configured it', async () => {
      const limited = await create({
        security: { rateLimit: { global: { enabled: true, requests: 1, window: 60000 } } },
      });
      const open = await create();
      for (const app of [limited, open]) app.get('/ping', () => ({ ok: true }));
      const limitedUrl = await listen(limited);
      const openUrl = await listen(open);

      expect(await status(`${limitedUrl}/ping`)).toBe(200);
      expect(await status(`${limitedUrl}/ping`)).toBe(429);
      expect(await status(`${openUrl}/ping`)).toBe(200);
      expect(await status(`${openUrl}/ping`)).toBe(200);
      expect(await status(`${openUrl}/ping`)).toBe(200);
    });

    it('answers a failed validation with the handler of the app that got the request', async () => {
      const custom = await create({
        modules: {
          validation: {
            onError: () => ({ status: 422, body: { rejectedBy: 'custom' } }),
          },
        },
      });
      const standard = await create();
      for (const app of [custom, standard]) {
        app
          .post('/people')
          .body(z.object({ name: z.string() }))
          .handler(() => ({ ok: true }));
      }
      const customUrl = await listen(custom);
      const standardUrl = await listen(standard);
      const invalid = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 7 }),
      };

      const fromCustom = await fetch(`${customUrl}/people`, invalid);
      expect(fromCustom.status).toBe(422);
      expect(await fromCustom.json()).toEqual({ rejectedBy: 'custom' });

      const fromStandard = await fetch(`${standardUrl}/people`, invalid);
      expect(fromStandard.status).toBe(400);
      expect(await fromStandard.json()).not.toEqual({ rejectedBy: 'custom' });
    });
  });

  describe('documentation', () => {
    it('documents only the routes of the app it was enabled on', async () => {
      const first = await create();
      const second = await create();
      first
        .get('/catalog')
        .describe('The catalog')
        .handler(() => ({}));
      second
        .get('/ledger')
        .describe('The ledger')
        .handler(() => ({}));
      withSwaggerUiPackage(() => {
        first.enableDocs({ title: 'First API', version: '1.0.0', basePath: '/docs' });
        second.enableDocs({ title: 'Second API', version: '2.0.0', basePath: '/docs' });
      });

      const firstPaths = Object.keys(first.getOpenAPISpec().paths);
      const secondPaths = Object.keys(second.getOpenAPISpec().paths);
      expect(firstPaths).toContain('/catalog');
      expect(firstPaths).not.toContain('/ledger');
      expect(secondPaths).toContain('/ledger');
      expect(secondPaths).not.toContain('/catalog');
      expect(first.getOpenAPISpec().info.title).toBe('First API');
      expect(second.getOpenAPISpec().info.title).toBe('Second API');
    });
  });

  describe('the current app', () => {
    it('gives a standalone route registered before any app to the first app created', async () => {
      createRoute('GET', '/early').handler(() => ({ early: true }));
      defineRoute({ method: 'GET', path: '/early-schema', handler: () => ({ early: 'schema' }) });

      const first = await create();
      const second = await create();
      const firstUrl = await listen(first);
      const secondUrl = await listen(second);

      expect(await json(`${firstUrl}/early`)).toEqual({ early: true });
      expect(await json(`${firstUrl}/early-schema`)).toEqual({ early: 'schema' });
      expect(await status(`${secondUrl}/early`)).toBe(404);
      expect(await status(`${secondUrl}/early-schema`)).toBe(404);
    });

    it('registers a standalone route on the app created most recently', async () => {
      const first = await create();
      const second = await create();
      createRoute('GET', '/standalone').handler(() => ({ on: 'second' }));

      expect(
        UnifiedRouter.getInstance()
          .getAllRoutes()
          .map(r => r.path)
      ).toEqual(['/standalone']);
      expect(getApp()).toBe(second);

      const firstUrl = await listen(first);
      const secondUrl = await listen(second);
      expect(await json(`${secondUrl}/standalone`)).toEqual({ on: 'second' });
      expect(await status(`${firstUrl}/standalone`)).toBe(404);
    });

    it('is the app that is loading its route files while they load', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'moro-apps-'));
      try {
        const routes = join(dir, `routes-${engine}`);
        await mkdir(routes);
        await writeFile(
          join(routes, 'from-file.ts'),
          `(globalThis as any).__registerFileRoutes(); export {};`
        );
        (globalThis as any).__registerFileRoutes = () => {
          getApp().get('/via-get-app', () => ({ via: 'getApp' }));
          createRoute('GET', '/via-builder').handler(() => ({ via: 'createRoute' }));
        };

        const owner = await create();
        const newer = await create();
        expect(getApp()).toBe(newer);
        await owner.loadRoutes(routes);
        expect(getApp()).toBe(newer);

        const ownerUrl = await listen(owner);
        const newerUrl = await listen(newer);
        expect(await json(`${ownerUrl}/via-get-app`)).toEqual({ via: 'getApp' });
        expect(await json(`${ownerUrl}/via-builder`)).toEqual({ via: 'createRoute' });
        expect(await status(`${newerUrl}/via-get-app`)).toBe(404);
        expect(await status(`${newerUrl}/via-builder`)).toBe(404);
      } finally {
        delete (globalThis as any).__registerFileRoutes;
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves an app from before a reset with no routes, counters or cached responses', async () => {
      const earlier = await create();
      earlier
        .get('/metered')
        .rateLimit({ requests: 1, window: 60000 })
        .handler(() => ({ app: 'earlier' }));
      const earlierUrl = await listen(earlier);
      expect(await status(`${earlierUrl}/metered`)).toBe(200);
      expect(await status(`${earlierUrl}/metered`)).toBe(429);

      // What the test setup does between tests
      UnifiedRouter.reset();

      // The earlier app is still listening but answers nothing
      expect(await status(`${earlierUrl}/metered`)).toBe(404);

      // ...and the same route on a new app starts from a fresh allowance
      const later = await create();
      later
        .get('/metered')
        .rateLimit({ requests: 1, window: 60000 })
        .handler(() => ({ app: 'later' }));
      const laterUrl = await listen(later);
      expect(await json(`${laterUrl}/metered`)).toEqual({ app: 'later' });
      expect(await status(`${earlierUrl}/metered`)).toBe(404);
    });
  });
});
