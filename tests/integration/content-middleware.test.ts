// Integration Tests - content-handling middleware, on every HTTP backend:
//
//   middleware.cache()  replays a stored body, status and content type intact;
//                       keeps Set-Cookie, responses to requests that carry
//                       Authorization, errors and private responses out of
//                       the store
//   route .cache()      calls a function key, keeps users apart and keeps the
//                       stored status
//   bodySize()          limits a chunked request by what was received
//   json({ limit }) ... the body parsers' own limit answers 413
//   upload()            takes files only from a real multipart body; stores a
//                       file when the handler asks for it and removes what a
//                       failed request stored
//   sse()               opens an event stream when the handler asks for one,
//                       never for the request's Accept header alone
//   staticFiles         serves a directory index only from inside the root and
//                       applies the dotfile policy to every path segment
//   cdn()               marks only shareable responses public and purges only
//                       after successful writes
//
// UnifiedRouter and the configuration are process-wide, so each test boots one
// app, exercises it and closes it before the next one starts.
import { describe, it, expect, afterEach, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp, middleware, json, urlencoded, text } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import type { CDNAdapter } from '../../src/types/cdn.js';
import { closeApp, createTestPort, waitFor } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';

type BackendId = 'node' | 'moro';
const BACKENDS: BackendId[] = engineLoadable ? ['node', 'moro'] : ['node'];

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Sent with Content-Length unless `chunked` */
  body?: string | Buffer;
  chunked?: boolean;
}

function send(port: number, reqPath: string, options: SendOptions = {}): Promise<Reply> {
  const { method = 'GET', headers = {}, body, chunked = false } = options;
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const allHeaders: Record<string, string> = { connection: 'close', ...headers };
  if (payload !== undefined) {
    if (chunked) allHeaders['transfer-encoding'] = 'chunked';
    else allHeaders['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers: allHeaders, agent: false },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode as number, headers: res.headers, body: text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) {
      if (chunked) {
        // several chunks, so the body cannot be mistaken for a sized one
        const third = Math.ceil(payload.length / 3);
        for (let offset = 0; offset < payload.length; offset += third) {
          req.write(payload.subarray(offset, offset + third));
        }
      } else {
        req.write(payload);
      }
    }
    req.end();
  });
}

/**
 * What a server sends within `ms`, for a response that may never end (an
 * event stream): the status and headers if any arrived, and the body so far.
 */
function collect(
  port: number,
  reqPath: string,
  headers: Record<string, string>,
  ms: number
): Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: string; ended: boolean }> {
  return new Promise(resolve => {
    let status: number | undefined;
    let replyHeaders: http.IncomingHttpHeaders = {};
    let body = '';
    let ended = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ status, headers: replyHeaders, body, ended });
    };
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers, agent: false },
      res => {
        status = res.statusCode;
        replyHeaders = res.headers;
        res.on('data', d => (body += d.toString('utf8')));
        res.on('end', () => {
          ended = true;
          done();
        });
        res.on('error', done);
      }
    );
    req.on('error', done);
    const timer = setTimeout(done, ms);
    req.end();
  });
}

let current: any;

async function boot(
  backend: BackendId,
  register: (app: any) => void | Promise<void>,
  config: Record<string, unknown> = {}
) {
  resetConfig();
  UnifiedRouter.reset();
  const app: any = await createApp({
    logger: { level: 'fatal' },
    autoDiscover: false,
    routing: false,
    server: { engine: backend },
    ...config,
  } as any);
  current = app;
  await register(app);
  const port = createTestPort();
  await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
  return { app, port };
}

afterEach(async () => {
  if (current) await closeApp(current);
  current = undefined;
});

describe.each(BACKENDS)('content middleware on the %s backend', backend => {
  describe('middleware.cache()', () => {
    it('replays a res.json() body intact, with its content type', async () => {
      let runs = 0;
      const { port } = await boot(backend, async app => {
        await app.use(middleware.cache({ ttl: 60, strategy: 'memory' }));
        app.get('/data', (_req: any, res: any) => {
          runs++;
          res.json({ items: [1, 2, 3], run: runs });
        });
        app.get('/returned', () => {
          runs++;
          return { returned: true };
        });
      });

      const first = await send(port, '/data');
      expect(first.status).toBe(200);
      expect(first.headers['x-cache']).toBe('MISS');
      expect(first.json).toEqual({ items: [1, 2, 3], run: 1 });

      const second = await send(port, '/data');
      expect(second.status).toBe(200);
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.headers['content-type']).toContain('application/json');
      expect(second.body).toBe(first.body);
      expect(runs).toBe(1);

      const returned = await send(port, '/returned');
      const returnedAgain = await send(port, '/returned');
      expect(returned.json).toEqual({ returned: true });
      expect(returnedAgain.headers['x-cache']).toBe('HIT');
      expect(returnedAgain.json).toEqual({ returned: true });
      expect(runs).toBe(2);
    });

    it('replays text bodies and the stored status', async () => {
      const { port } = await boot(backend, async app => {
        await app.use(middleware.cache());
        app.get('/page', (_req: any, res: any) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send('<h1>page</h1>');
        });
        app.get('/gone', (_req: any, res: any) => {
          res.status(410).json({ error: 'gone' });
        });
      });

      await send(port, '/page');
      const page = await send(port, '/page');
      expect(page.headers['x-cache']).toBe('HIT');
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toBe('<h1>page</h1>');

      await send(port, '/gone');
      const gone = await send(port, '/gone');
      expect(gone.headers['x-cache']).toBe('HIT');
      expect(gone.status).toBe(410);
      expect(gone.json).toEqual({ error: 'gone' });
    });

    it('does not replay Set-Cookie to the next caller', async () => {
      const { port } = await boot(backend, async app => {
        await app.use(middleware.cache());
        app.get('/welcome', (_req: any, res: any) => {
          res.setHeader('Set-Cookie', 'sid=SESSION-OF-FIRST-CALLER; HttpOnly');
          res.json({ welcome: true });
        });
      });

      const first = await send(port, '/welcome');
      expect(String(first.headers['set-cookie'])).toContain('SESSION-OF-FIRST-CALLER');

      const second = await send(port, '/welcome');
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.json).toEqual({ welcome: true });
      expect(second.headers['set-cookie']).toBeUndefined();
    });

    it('keeps responses to requests with Authorization out of the store', async () => {
      const seen: string[] = [];
      const { port } = await boot(backend, async app => {
        await app.use(middleware.cache());
        app.get('/api/me', (req: any, res: any) => {
          const token = req.headers.authorization;
          seen.push(token ?? 'anonymous');
          if (!token) {
            res.status(401).json({ error: 'sign in' });
            return;
          }
          res.json({ user: token.replace('Bearer ', ''), secret: `SECRET-OF-${token}` });
        });
      });

      const alice = await send(port, '/api/me', { headers: { authorization: 'Bearer alice' } });
      expect(alice.json.user).toBe('alice');
      expect(alice.headers['x-cache']).toBe('BYPASS');

      const anonymous = await send(port, '/api/me');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).not.toContain('alice');

      const bob = await send(port, '/api/me', { headers: { authorization: 'Bearer bob' } });
      expect(bob.json.user).toBe('bob');

      // the 401 was not stored either: alice is still answered as alice
      const aliceAgain = await send(port, '/api/me', {
        headers: { authorization: 'Bearer alice' },
      });
      expect(aliceAgain.json.user).toBe('alice');
      const anonymousAgain = await send(port, '/api/me');
      expect(anonymousAgain.status).toBe(401);
      expect(seen).toEqual([
        'Bearer alice',
        'anonymous',
        'Bearer bob',
        'Bearer alice',
        'anonymous',
      ]);
    });

    // The lookup is a request hook, and hooks run before app.use() middleware:
    // the cache answers before the application's authentication has looked.
    // What keeps a signed-in caller apart is what the request itself carries.
    it('keeps a caller with Authorization or a Cookie from reading or writing a shared entry', async () => {
      const runs: string[] = [];
      const { port } = await boot(backend, async app => {
        app.use((req: any, _res: any, next: () => void) => {
          const token =
            req.headers.authorization?.replace('Bearer ', '') ??
            /(?:^|; )sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
          if (token) req.user = { id: token };
          next();
        });
        await app.use(middleware.cache());
        app.get('/page', (req: any, res: any) => {
          const who = req.user?.id ?? 'anonymous';
          runs.push(who);
          res.json({ page: who });
        });
        app.get('/fresh', (req: any, res: any) => {
          res.json({ page: req.user?.id ?? 'anonymous' });
        });
      });
      const alice = { headers: { authorization: 'Bearer alice' } };
      const carol = { headers: { cookie: 'theme=dark; sid=carol' } };

      // A shared entry exists for the page
      expect((await send(port, '/page')).headers['x-cache']).toBe('MISS');
      expect((await send(port, '/page')).headers['x-cache']).toBe('HIT');

      // Signed-in callers are not answered with it
      for (const [who, options] of [
        ['alice', alice],
        ['carol', carol],
      ] as const) {
        const own = await send(port, '/page', options);
        expect({ who, cache: own.headers['x-cache'], body: own.json }).toEqual({
          who,
          cache: 'BYPASS',
          body: { page: who },
        });
        expect(own.headers['cache-control']).toMatch(/^private/);
      }

      // and they left nothing behind for the callers that follow
      const after = await send(port, '/page');
      expect(after.headers['x-cache']).toBe('HIT');
      expect(after.json).toEqual({ page: 'anonymous' });
      expect(runs).toEqual(['anonymous', 'alice', 'carol']);

      // The same on a page nobody has asked for yet: nothing of theirs is stored
      expect((await send(port, '/fresh', alice)).json).toEqual({ page: 'alice' });
      expect((await send(port, '/fresh', carol)).json).toEqual({ page: 'carol' });
      const first = await send(port, '/fresh');
      expect(first.headers['x-cache']).toBe('MISS');
      expect(first.json).toEqual({ page: 'anonymous' });
    });

    it('keeps an entry per host, and per caller for a header named in varyBy', async () => {
      const { port } = await boot(backend, async app => {
        app.use((req: any, res: any, next: () => void) => {
          // An API key the cache knows nothing about unless it is told
          const key = req.headers['x-api-key'];
          if (key) req.user = { id: `owner-of-${key}` };
          next();
        });
        await app.use(middleware.cache({ varyBy: ['X-API-Key'] }));
        app.get('/site', (req: any, res: any) => res.json({ site: req.headers.host }));
        app.get('/report', (req: any, res: any) => {
          res.json({ owner: req.user?.id ?? 'nobody' });
        });
      });

      const a = await send(port, '/site', { headers: { host: 'tenant-a.example' } });
      const b = await send(port, '/site', { headers: { host: 'tenant-b.example' } });
      expect(a.json).toEqual({ site: 'tenant-a.example' });
      expect(b.headers['x-cache']).toBe('MISS');
      expect(b.json).toEqual({ site: 'tenant-b.example' });
      const again = await send(port, '/site', { headers: { host: 'tenant-a.example' } });
      expect(again.headers['x-cache']).toBe('HIT');
      expect(again.json).toEqual({ site: 'tenant-a.example' });

      const withKey = (key: string) => send(port, '/report', { headers: { 'x-api-key': key } });
      const one = await withKey('k1');
      expect(one.headers['x-cache']).toBe('MISS');
      expect(one.headers['cache-control']).toMatch(/^private/);
      expect(String(one.headers.vary).toLowerCase()).toContain('x-api-key');
      expect(String(one.headers['x-cache-key'])).not.toContain('k1');
      const two = await withKey('k2');
      expect(two.json).toEqual({ owner: 'owner-of-k2' });
      const oneAgain = await withKey('k1');
      expect(oneAgain.headers['x-cache']).toBe('HIT');
      expect(oneAgain.json).toEqual({ owner: 'owner-of-k1' });
      const none = await send(port, '/report');
      expect(none.headers['x-cache']).toBe('MISS');
      expect(none.json).toEqual({ owner: 'nobody' });
    });

    it('does not store errors or responses the handler marked private', async () => {
      let flakyRuns = 0;
      let accountRuns = 0;
      const { port } = await boot(backend, async app => {
        await app.use(middleware.cache());
        app.get('/flaky', (req: any, res: any) => {
          flakyRuns++;
          if (req.headers['x-break']) {
            res.status(500).json({ error: 'broken' });
            return;
          }
          res.json({ ok: true });
        });
        app.get('/account', (_req: any, res: any) => {
          accountRuns++;
          res.setHeader('Cache-Control', 'private, max-age=60');
          res.json({ balance: accountRuns });
        });
      });

      const broken = await send(port, '/flaky', { headers: { 'x-break': '1' } });
      expect(broken.status).toBe(500);
      const healthy = await send(port, '/flaky');
      expect(healthy.status).toBe(200);
      expect(healthy.json).toEqual({ ok: true });
      expect(flakyRuns).toBe(2);

      const one = await send(port, '/account');
      const two = await send(port, '/account');
      expect(one.headers['cache-control']).toBe('private, max-age=60');
      expect(one.json).toEqual({ balance: 1 });
      expect(two.json).toEqual({ balance: 2 });
    });
  });

  describe('route .cache()', () => {
    it('calls a function key, keeps users apart and keeps the status', async () => {
      const asUser = (req: any, _res: any, next: () => void) => {
        const name = req.headers['x-user'];
        if (name) req.user = { id: name };
        next();
      };
      // The route cache is one store per process, shared by every app in it:
      // paths and keys carry the backend so the two runs do not meet there
      const p = `/${backend}`;
      const { port } = await boot(backend, app => {
        app
          .get(`${p}/profile/:id`)
          .cache({ ttl: 60, key: (req: any) => `${backend}:profile:${req.params.id}` })
          .handler((req: any) => ({ profile: req.params.id }));
        app
          .get(`${p}/me`)
          .before(asUser)
          .cache({ ttl: 60 })
          .handler((req: any) => ({ secret: `SECRET-OF-${req.user?.id ?? 'nobody'}` }));
        app
          .get(`${p}/item/:id`)
          .cache({ ttl: 60 })
          .handler((req: any, res: any) => {
            if (req.params.id !== '1') {
              res.status(404).json({ error: 'not found' });
              return;
            }
            return { item: 1 };
          });
      });

      // function key
      expect((await send(port, `${p}/profile/1`)).json).toEqual({ profile: '1' });
      const two = await send(port, `${p}/profile/2`);
      expect(two.headers['x-cache']).toBe('MISS');
      expect(two.json).toEqual({ profile: '2' });
      const oneAgain = await send(port, `${p}/profile/1`);
      expect(oneAgain.headers['x-cache']).toBe('HIT');
      expect(oneAgain.json).toEqual({ profile: '1' });

      // identity in the default key
      const alice = await send(port, `${p}/me`, { headers: { 'x-user': 'alice' } });
      expect(alice.json).toEqual({ secret: 'SECRET-OF-alice' });
      const bob = await send(port, `${p}/me`, { headers: { 'x-user': 'bob' } });
      expect(bob.json).toEqual({ secret: 'SECRET-OF-bob' });
      const nobody = await send(port, `${p}/me`);
      expect(nobody.json).toEqual({ secret: 'SECRET-OF-nobody' });
      const aliceAgain = await send(port, `${p}/me`, { headers: { 'x-user': 'alice' } });
      expect(aliceAgain.headers['x-cache']).toBe('HIT');
      expect(aliceAgain.json).toEqual({ secret: 'SECRET-OF-alice' });

      // status
      const missing = await send(port, `${p}/item/2`);
      expect(missing.status).toBe(404);
      const missingAgain = await send(port, `${p}/item/2`);
      expect(missingAgain.headers['x-cache']).toBe('HIT');
      expect(missingAgain.status).toBe(404);
      expect(missingAgain.json).toEqual({ error: 'not found' });
    });

    it('keeps the hosts an application answers for apart, unless the route is shared', async () => {
      const asUser = (req: any, _res: any, next: () => void) => {
        const name = req.headers['x-user'];
        if (name) req.user = { id: name };
        next();
      };
      const p = `/${backend}/hosts`;
      const site = (req: any) => ({ site: req.headers.host, user: req.user?.id ?? null });
      const { port } = await boot(backend, app => {
        app.get(`${p}/home`).cache({ ttl: 60 }).handler(site);
        app.get(`${p}/me`).before(asUser).cache({ ttl: 60 }).handler(site);
        app.get(`${p}/catalog`).cache({ ttl: 60, shared: true }).handler(site);
        app
          .get(`${p}/catalog-by-host`)
          .cache({ ttl: 60, key: (req: any) => `${backend}:catalog:${req.hostname}` })
          .handler(site);
      });
      const on = (host: string, path: string, user?: string) =>
        send(port, `${p}${path}`, { headers: { host, ...(user ? { 'x-user': user } : {}) } });

      // The default key: one entry per host
      expect((await on('tenant-a.example', '/home')).json.site).toBe('tenant-a.example');
      const other = await on('tenant-b.example', '/home');
      expect(other.headers['x-cache']).toBe('MISS');
      expect(other.json.site).toBe('tenant-b.example');
      const again = await on('TENANT-A.example', '/home');
      expect(again.headers['x-cache']).toBe('HIT');
      expect(again.json.site).toBe('tenant-a.example');

      // and per host for a signed-in user: the same id on two hosts is two users
      expect((await on('tenant-a.example', '/me', '7')).json.site).toBe('tenant-a.example');
      const sameId = await on('tenant-b.example', '/me', '7');
      expect(sameId.headers['x-cache']).toBe('MISS');
      expect(sameId.json).toEqual({ site: 'tenant-b.example', user: '7' });
      expect((await on('tenant-a.example', '/me', '7')).headers['x-cache']).toBe('HIT');

      // shared: true says the response is the same for every caller, under
      // every host name: one entry
      expect((await on('tenant-a.example', '/catalog')).headers['x-cache']).toBe('MISS');
      const shared = await on('tenant-b.example', '/catalog');
      expect(shared.headers['x-cache']).toBe('HIT');
      expect(shared.json.site).toBe('tenant-a.example');

      // a key of the route's own is how a shared route is keyed by host
      expect((await on('tenant-a.example', '/catalog-by-host')).headers['x-cache']).toBe('MISS');
      const keyed = await on('tenant-b.example', '/catalog-by-host');
      expect(keyed.headers['x-cache']).toBe('MISS');
      expect(keyed.json.site).toBe('tenant-b.example');
    });

    it('sizes the store from modules.cache.maxSize', async () => {
      const p = `/${backend}/sized`;
      const { port } = await boot(
        backend,
        app => {
          app
            .get(`${p}/:id`)
            .cache({ ttl: 60 })
            .handler((req: any) => ({ id: req.params.id }));
        },
        { modules: { cache: { maxSize: 2 } } }
      );

      for (const id of ['1', '2', '3']) {
        expect((await send(port, `${p}/${id}`)).headers['x-cache']).toBe('MISS');
      }
      // Two entries fit: the first one made room for the third
      expect((await send(port, `${p}/3`)).headers['x-cache']).toBe('HIT');
      expect((await send(port, `${p}/2`)).headers['x-cache']).toBe('HIT');
      expect((await send(port, `${p}/1`)).headers['x-cache']).toBe('MISS');
    });

    it('gives a route that names no ttl the lifetime in modules.cache.defaultTtl', async () => {
      const p = `/${backend}/untimed`;
      let calls = 0;
      const { port } = await boot(
        backend,
        app => {
          app
            .get(`${p}/default`)
            .cache({})
            .handler(() => ({ call: ++calls }));
          app
            .get(`${p}/own`)
            .cache({ ttl: 60 })
            .handler(() => ({ call: ++calls }));
        },
        { modules: { cache: { defaultTtl: 0.25 } } }
      );

      expect((await send(port, `${p}/default`)).json).toEqual({ call: 1 });
      const stored = await send(port, `${p}/default`);
      expect(stored.headers['x-cache']).toBe('HIT');
      expect(stored.json).toEqual({ call: 1 });
      expect((await send(port, `${p}/own`)).json).toEqual({ call: 2 });

      await new Promise(resolve => setTimeout(resolve, 400));

      // The default lifetime is over; the route's own ttl is not
      const fresh = await send(port, `${p}/default`);
      expect(fresh.headers['x-cache']).toBe('MISS');
      expect(fresh.json).toEqual({ call: 3 });
      expect((await send(port, `${p}/own`)).headers['x-cache']).toBe('HIT');
    });

    it('caches nothing for a route that declares no caching, with modules.cache.enabled', async () => {
      const p = `/${backend}/undeclared`;
      let calls = 0;
      const { port } = await boot(
        backend,
        app => {
          app.get(p, () => ({ call: ++calls }));
          app.get(`${p}/chained`).handler(() => ({ call: ++calls }));
        },
        { modules: { cache: { enabled: true, defaultTtl: 300, maxSize: 1000, strategy: 'lru' } } }
      );

      const first = await send(port, p);
      const second = await send(port, p);
      expect(first.json).toEqual({ call: 1 });
      expect(second.json).toEqual({ call: 2 });
      expect(first.headers['x-cache']).toBeUndefined();
      expect(second.headers['x-cache']).toBeUndefined();
      expect(second.headers['cache-control']).toBeUndefined();

      expect((await send(port, `${p}/chained`)).json).toEqual({ call: 3 });
      const chained = await send(port, `${p}/chained`);
      expect(chained.json).toEqual({ call: 4 });
      expect(chained.headers['x-cache']).toBeUndefined();
    });
  });

  describe('bodySize()', () => {
    it('limits a chunked request by what was received', async () => {
      let handled = 0;
      const { port } = await boot(backend, async app => {
        await app.use(middleware.bodySize({ limit: '1kb' }));
        app.post('/echo', (req: any) => {
          handled++;
          return { keys: Object.keys(req.body ?? {}).length };
        });
      });
      const json = { 'content-type': 'application/json' };
      const big = JSON.stringify({ a: 'x'.repeat(5000) });
      const small = JSON.stringify({ a: 'ok' });

      const sized = await send(port, '/echo', { method: 'POST', headers: json, body: big });
      expect(sized.status).toBe(413);

      const chunked = await send(port, '/echo', {
        method: 'POST',
        headers: json,
        body: big,
        chunked: true,
      });
      expect(chunked.status).toBe(413);
      expect(handled).toBe(0);

      const smallChunked = await send(port, '/echo', {
        method: 'POST',
        headers: json,
        body: small,
        chunked: true,
      });
      expect(smallChunked.status).toBe(200);
      expect(smallChunked.json).toEqual({ keys: 1 });
      const smallSized = await send(port, '/echo', { method: 'POST', headers: json, body: small });
      expect(smallSized.status).toBe(200);
      expect(handled).toBe(2);
    });
  });

  describe('body parser limit', () => {
    it('answers 413 for a body over the parser limit, like the server limit does', async () => {
      let handled = 0;
      const { port } = await boot(backend, async app => {
        app.use(json({ limit: '1kb' }));
        app.use(urlencoded({ limit: 64 }));
        app.use(text({ limit: 32 }));
        app.post('/echo', (req: any) => {
          handled++;
          return { type: typeof req.body };
        });
      });
      const post = (contentType: string, body: string, chunked = false) =>
        send(port, '/echo', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
          chunked,
        });
      const bigJson = JSON.stringify({ a: 'x'.repeat(5000) });

      for (const reply of [
        await post('application/json', bigJson),
        await post('application/json', bigJson, true),
        await post('application/x-www-form-urlencoded', `a=${'x'.repeat(200)}`),
        await post('text/plain', 'x'.repeat(200)),
      ]) {
        expect(reply.status).toBe(413);
        expect(reply.json).toEqual({ success: false, error: 'Request entity too large' });
      }
      expect(handled).toBe(0);

      // within each parser's limit, and a type none of them limits
      expect((await post('application/json', '{"a":1}')).status).toBe(200);
      expect((await post('application/json', '{"a":1}', true)).status).toBe(200);
      expect((await post('application/x-www-form-urlencoded', 'a=1')).status).toBe(200);
      expect((await post('text/plain', 'short')).status).toBe(200);
      expect((await post('application/xml', `<a>${'x'.repeat(5000)}</a>`)).status).toBe(200);
      expect(handled).toBe(5);
    });
  });

  describe('sse()', () => {
    const ACCEPT = { accept: 'text/event-stream' };

    it('opens a stream only when the handler asks for one', async () => {
      let guarded = 0;
      const { port } = await boot(backend, async app => {
        await app.use(middleware.sse({ heartbeat: 20, retry: 1500 }));
        app.get('/private', (_req: any, res: any) => {
          guarded++;
          res.status(401).json({ error: 'unauthorized' });
        });
        app.get('/plain', () => ({ plain: true }));
        app.get('/events', (req: any, res: any) => {
          const stream = res.sse();
          stream.sendEvent({ n: 1 }, 'tick', '1');
          res.sendEvent('two');
          const timer = setTimeout(() => stream.close(), 80);
          req.on('close', () => clearTimeout(timer));
        });
      });

      // A request that says it accepts an event stream is answered by its
      // route like any other: the guard's 401, a JSON body, the 404.
      const refused = await collect(port, '/private', ACCEPT, 400);
      expect(refused.status).toBe(401);
      expect(refused.ended).toBe(true);
      expect(String(refused.headers['content-type'])).not.toContain('text/event-stream');
      expect(JSON.parse(refused.body)).toEqual({ error: 'unauthorized' });
      expect(guarded).toBe(1);

      const plain = await collect(port, '/plain', ACCEPT, 400);
      expect(plain.status).toBe(200);
      expect(JSON.parse(plain.body)).toEqual({ plain: true });

      const missing = await collect(port, '/no-such-route', ACCEPT, 400);
      expect(missing.status).toBe(404);
      expect(missing.ended).toBe(true);

      // The handler that asks for a stream gets one, with the configured
      // retry line and heartbeat, until it closes it.
      const stream = await collect(port, '/events', ACCEPT, 1500);
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toBe('text/event-stream');
      expect(stream.headers['cache-control']).toBe('no-cache');
      expect(stream.body.startsWith('retry: 1500\n\n')).toBe(true);
      expect(stream.body).toContain('id: 1\nevent: tick\ndata: {"n":1}\n\n');
      expect(stream.body).toContain('data: two\n\n');
      expect(stream.body).toContain(': heartbeat\n\n');
      expect(stream.ended).toBe(true);

      // ...whatever the client's Accept header says
      const anyAccept = await collect(port, '/events', { accept: '*/*' }, 1500);
      expect(anyAccept.headers['content-type']).toBe('text/event-stream');
      expect(anyAccept.body).toContain('event: tick');
    });
  });

  describe('upload()', () => {
    let dest: string;

    beforeAll(async () => {
      dest = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-upload-int-')));
    });
    afterAll(async () => {
      await fs.rm(dest, { recursive: true, force: true });
    });

    it('ignores file objects forged in a JSON body and still takes real uploads', async () => {
      const { port } = await boot(backend, async app => {
        await app.use(middleware.upload({ dest, maxFileSize: 1024 }));
        app.post('/up', (req: any) => ({
          files: Object.values(req.files ?? {}).map((f: any) => ({
            filename: f.filename,
            size: f.size,
            isBuffer: Buffer.isBuffer(f.data),
            stored: typeof f.path === 'string',
          })),
        }));
      });

      const forged = JSON.stringify({
        files: {
          a: { filename: 'x.png', mimetype: 'image/png', size: 1, data: 'B'.repeat(20000) },
        },
      });
      for (const contentType of [
        'application/json; x=multipart/form-data',
        'application/json; boundary=multipart/form-data',
      ]) {
        const reply = await send(port, '/up', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: forged,
        });
        // whatever the server makes of the request, no forged file gets through
        if (reply.status === 200) expect(reply.json).toEqual({ files: [] });
        else expect(reply.status).toBeGreaterThanOrEqual(400);
      }
      expect(await fs.readdir(dest)).toEqual([]);

      const boundary = 'XBOUND';
      const real = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="note.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\n`
        ),
        Buffer.from('hello upload'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const uploaded = await send(port, '/up', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: real,
      });
      expect(uploaded.status).toBe(200);
      expect(uploaded.json).toEqual({
        files: [{ filename: 'note.txt', size: 12, isBuffer: true, stored: true }],
      });
      const written = await fs.readdir(dest);
      expect(written).toHaveLength(1);
      expect(await fs.readFile(path.join(dest, written[0] as string), 'utf8')).toBe('hello upload');
      await fs.rm(path.join(dest, written[0] as string));
    });

    it('stores a file when the handler asks, and nothing for a request that never gets there', async () => {
      const { port } = await boot(backend, async app => {
        await app.use(middleware.upload({ dest, maxFileSize: 1024 }));
        // refuses every request, as an auth guard would
        const guard = (_req: any, res: any, _next: () => void) =>
          res.status(401).json({ error: 'unauthorized' });
        app.post('/guarded', guard, (req: any) => ({ path: req.files.doc.path }));
        app.post('/unused', () => ({ ok: true }));
        app.post('/store', (req: any) => ({ stored: path.basename(req.files.doc.path) }));
        app.post('/store-then-fail', (req: any) => {
          if (typeof req.files.doc.path === 'string') throw new Error('after storing');
          return { unreachable: true };
        });
        app.post('/store-then-refuse', (req: any, res: any) => {
          res.status(422).json({ stored: path.basename(req.files.doc.path) });
        });
      });

      const boundary = 'XBOUND';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="note.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\n`
        ),
        Buffer.from('hello upload'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const post = (reqPath: string) =>
        send(port, reqPath, {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body,
        });
      const settled = () => new Promise(resolve => setTimeout(resolve, 60));

      // No route, a route whose guard refuses, a handler with no use for the file
      expect((await post('/no-such-route')).status).toBe(404);
      expect((await post('/guarded')).status).toBe(401);
      expect((await post('/unused')).status).toBe(200);
      await settled();
      expect(await fs.readdir(dest)).toEqual([]);

      // A handler that stored the file and then failed, or answered an error
      expect((await post('/store-then-fail')).status).toBe(500);
      const refused = await post('/store-then-refuse');
      expect(refused.status).toBe(422);
      expect(refused.json.stored).toMatch(/^[0-9a-f]{16}-note\.txt$/);
      await waitFor(async () => (await fs.readdir(dest)).length === 0, {
        timeout: 2000,
        description: 'the files of the failed requests to be removed',
      });
      expect(await fs.readdir(dest)).toEqual([]);

      // A handler that stored it and answered normally
      const ok = await post('/store');
      expect(ok.status).toBe(200);
      await settled();
      expect(await fs.readdir(dest)).toEqual([ok.json.stored]);
      expect(await fs.readFile(path.join(dest, ok.json.stored), 'utf8')).toBe('hello upload');
      await fs.rm(path.join(dest, ok.json.stored));
    });
  });

  describe('staticFiles', () => {
    let base: string;
    let root: string;

    beforeAll(async () => {
      base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-static-int-')));
      root = path.join(base, 'public');
      await fs.mkdir(path.join(root, 'linkdir'), { recursive: true });
      await fs.mkdir(path.join(root, '.git'));
      await fs.mkdir(path.join(root, '.well-known'));
      await fs.writeFile(path.join(base, 'secret.txt'), 'OUTSIDE-SECRET');
      await fs.writeFile(path.join(root, 'hello.txt'), 'hello');
      await fs.writeFile(path.join(root, '.git', 'config'), 'GITCONFIG-SECRET');
      await fs.writeFile(path.join(root, '.well-known', 'security.txt'), 'Contact: sec@example');
      await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'linkdir', 'index.html'));
    });
    afterAll(async () => {
      await fs.rm(base, { recursive: true, force: true });
    });

    it.each([false, true])(
      'keeps a linked index and hidden directories from being served (cache: %s)',
      async cache => {
        const { port } = await boot(backend, async app => {
          await app.use(middleware.staticFiles({ root, cache }));
        });

        for (const reqPath of ['/linkdir/', '/linkdir']) {
          const reply = await send(port, reqPath);
          expect(reply.status).toBe(403);
          expect(reply.body).not.toContain('OUTSIDE-SECRET');
        }

        const git = await send(port, '/.git/config');
        expect(git.status).toBe(404);
        expect(git.body).not.toContain('GITCONFIG-SECRET');

        // twice: the second answer comes from memory when the cache is on
        for (let i = 0; i < 2; i++) {
          expect((await send(port, '/hello.txt')).body).toBe('hello');
          expect((await send(port, '//hello.txt')).body).toBe('hello');
          const wellKnown = await send(port, '/.well-known/security.txt');
          expect(wellKnown.status).toBe(200);
          expect(wellKnown.body).toBe('Contact: sec@example');
        }
      }
    );
  });

  describe('cdn()', () => {
    function fakeCdn() {
      const purged: string[][] = [];
      const adapter: CDNAdapter = {
        purge: async urls => {
          purged.push(urls);
        },
        setHeaders: response => {
          response.setHeader('Cache-Control', 'public, max-age=3600');
          response.setHeader('X-CDN-Provider', 'Fake');
        },
      };
      return { adapter, purged };
    }

    it('marks only shareable responses public and purges only after successful writes', async () => {
      const { adapter, purged } = fakeCdn();
      const { port } = await boot(backend, async app => {
        await app.use(
          middleware.cdn({ adapter, autoInvalidate: true, invalidationPatterns: ['^/api/'] })
        );
        app.get('/api/catalogue', () => ({ items: 3 }));
        app.get('/api/account', (req: any) => ({ account: req.headers.authorization }));
        app.get('/api/login', (_req: any, res: any) => {
          res.setHeader('Set-Cookie', 'sid=1; HttpOnly');
          res.json({ signedIn: true });
        });
        app.get('/api/own', (_req: any, res: any) => {
          res.setHeader('Cache-Control', 'private, no-store');
          res.json({ own: true });
        });
        app.get('/api/broken', (_req: any, res: any) => {
          res.status(500).json({ error: 'broken' });
        });
        app.post('/api/items', (_req: any, res: any) => {
          res.status(201).json({ created: true });
        });
        app.post('/api/rejected', (_req: any, res: any) => {
          res.status(422).json({ error: 'invalid' });
        });
      });

      const catalogue = await send(port, '/api/catalogue');
      expect(catalogue.status).toBe(200);
      expect(catalogue.headers['cache-control']).toBe('public, max-age=3600');
      expect(catalogue.headers['x-cdn-provider']).toBe('Fake');

      const account = await send(port, '/api/account', {
        headers: { authorization: 'Bearer alice' },
      });
      expect(account.status).toBe(200);
      expect(account.headers['cache-control']).toBeUndefined();
      expect(account.headers['x-cdn-provider']).toBe('Fake');

      const login = await send(port, '/api/login');
      expect(login.headers['set-cookie']).toBeDefined();
      expect(login.headers['cache-control']).toBeUndefined();

      const own = await send(port, '/api/own');
      expect(own.headers['cache-control']).toBe('private, no-store');

      const broken = await send(port, '/api/broken');
      expect(broken.status).toBe(500);
      expect(broken.headers['cache-control']).toBeUndefined();

      const missing = await send(port, '/api/no-such-route');
      expect(missing.status).toBe(404);
      expect(missing.headers['cache-control']).toBeUndefined();

      const rejected = await send(port, '/api/rejected', { method: 'POST', body: '{}' });
      expect(rejected.status).toBe(422);
      expect(rejected.headers['cache-control']).toBeUndefined();

      // Seven requests so far: reads and a failed write. None of them purges.
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(purged).toEqual([]);

      const created = await send(port, '/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBeUndefined();
      await waitFor(() => purged.length > 0, { description: 'purge after a successful write' });
      expect(purged).toEqual([['/api/items']]);
    });
  });
});
