// Express-compatibility tests — verify that classic Express idioms run on Moro
// without rewrites. Covers Tier 1 (handler-as-arg, 4-arg error mw, next(err),
// req/res helpers, createRouter, head/options) and native additions (req.context,
// res.locals, app.setErrorHandler, app.onClose, decorateRequest).

import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import http from 'node:http';
import net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { createApp, createRouter, json, urlencoded, param, z } from '../../../src/index.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';
import { logger } from '../../../src/core/logger/index.js';
import { createTestPort, delay, closeApp, waitFor } from '../../setup.js';
import { engineLoadable } from '../engine-test-utils.js';

describe('Express compatibility', () => {
  let app: any;
  let port: number;

  beforeEach(async () => {
    app = await createApp({ logger: { level: 'error' } });
    port = createTestPort();
  });

  afterEach(async () => {
    await closeApp(app);
    await delay(50);
  });

  const listen = () =>
    new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    }).then(() => delay(50));

  describe('request helpers', () => {
    it('exposes req.get, req.is, req.hostname, req.protocol, req.secure, req.xhr', async () => {
      app.post('/echo', (req: any, res: any) => {
        res.json({
          get: req.get('x-custom'),
          header: req.header('x-custom'),
          is: req.is('json'),
          hostname: req.hostname,
          protocol: req.protocol,
          secure: req.secure,
          xhr: req.xhr,
        });
      });

      await listen();
      const res = await request(`http://localhost:${port}`)
        .post('/echo')
        .set('X-Custom', 'abc')
        .set('X-Requested-With', 'XMLHttpRequest')
        .set('Content-Type', 'application/json')
        .send({ a: 1 })
        .expect(200);

      expect(res.body.get).toBe('abc');
      expect(res.body.header).toBe('abc');
      expect(res.body.is).toBe(true);
      expect(res.body.hostname).toBe('localhost');
      expect(res.body.protocol).toBe('http');
      expect(res.body.secure).toBe(false);
      expect(res.body.xhr).toBe(true);
    });

    it('populates req.context as an empty object per request', async () => {
      app.use((req: any, _res: any, next: () => void) => {
        req.context.userId = 'u-123';
        next();
      });
      app.get('/ctx', (req: any, res: any) => {
        res.json({ ctx: req.context });
      });
      await listen();
      const res = await request(`http://localhost:${port}`).get('/ctx').expect(200);
      expect(res.body.ctx).toEqual({ userId: 'u-123' });
    });
  });

  describe('response helpers', () => {
    it('supports res.set / res.get / res.append / res.type', async () => {
      app.get('/h', (_req: any, res: any) => {
        res.set('X-One', '1');
        res.set({ 'X-Two': '2' });
        res.append('X-Multi', 'a');
        res.append('X-Multi', 'b');
        res.type('json');
        res.send(JSON.stringify({ got: res.get('X-One') }));
      });
      await listen();
      const res = await request(`http://localhost:${port}`).get('/h').expect(200);
      expect(res.headers['x-one']).toBe('1');
      expect(res.headers['x-two']).toBe('2');
      expect(res.headers['x-multi']).toMatch(/a/);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.got).toBe('1');
    });

    it('supports res.sendStatus', async () => {
      app.get('/204', (_req: any, res: any) => res.sendStatus(204));
      await listen();
      const res = await request(`http://localhost:${port}`).get('/204');
      expect(res.status).toBe(204);
    });

    it('supports res.location and res.vary and res.links', async () => {
      app.get('/lv', (_req: any, res: any) => {
        res.location('/elsewhere');
        res.vary('Accept-Encoding');
        res.vary(['User-Agent']);
        res.links({ next: '/page/2' });
        res.status(200).send('ok');
      });
      await listen();
      const res = await request(`http://localhost:${port}`).get('/lv').expect(200);
      expect(res.headers['location']).toBe('/elsewhere');
      expect(res.headers['vary']).toMatch(/Accept-Encoding/);
      expect(res.headers['vary']).toMatch(/User-Agent/);
      expect(res.headers['link']).toMatch(/rel="next"/);
    });

    it('populates res.locals as an empty object per response', async () => {
      app.use((_req: any, res: any, next: () => void) => {
        res.locals.requestUser = { id: 1 };
        next();
      });
      app.get('/locals', (_req: any, res: any) => {
        res.json({ locals: res.locals });
      });
      await listen();
      const res = await request(`http://localhost:${port}`).get('/locals').expect(200);
      expect(res.body.locals).toEqual({ requestUser: { id: 1 } });
    });
  });

  describe('route signatures', () => {
    it('supports handler-as-second-arg (Express style)', async () => {
      app.get('/x', (_req: any, res: any) => res.status(200).send('ok'));
      await listen();
      const res = await request(`http://localhost:${port}`).get('/x').expect(200);
      expect(res.text).toBe('ok');
    });

    it('supports head() and options() on app', async () => {
      app.head('/h', (_req: any, res: any) => res.status(200).end());
      app.options('/o', (_req: any, res: any) => {
        res.set('Allow', 'GET, POST').status(204).end();
      });
      await listen();
      await request(`http://localhost:${port}`).head('/h').expect(200);
      const opts = await request(`http://localhost:${port}`).options('/o');
      expect(opts.status).toBe(204);
      expect(opts.headers['allow']).toBe('GET, POST');
    });

    it('supports app.all() across methods', async () => {
      app.all('/any', (req: any, res: any) => res.json({ method: req.method }));
      await listen();
      const baseUrl = `http://localhost:${port}`;
      const [g, p, pu, d] = await Promise.all([
        request(baseUrl).get('/any'),
        request(baseUrl).post('/any'),
        request(baseUrl).put('/any'),
        request(baseUrl).delete('/any'),
      ]);
      expect(g.body.method).toBe('GET');
      expect(p.body.method).toBe('POST');
      expect(pu.body.method).toBe('PUT');
      expect(d.body.method).toBe('DELETE');
    });
  });

  describe('additional req/res helpers', () => {
    it('exposes req.originalUrl, req.ips, req.subdomains, req.acceptsLanguages', async () => {
      app.get('/info', (req: any, res: any) => {
        res.json({
          originalUrl: req.originalUrl,
          ips: req.ips,
          subdomains: req.subdomains,
          lang: req.acceptsLanguages(['en', 'fr']),
        });
      });
      await listen();
      const res = await request(`http://localhost:${port}`)
        .get('/info?x=1')
        .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2')
        .set('Accept-Language', 'fr-FR,fr;q=0.9,en;q=0.8')
        .expect(200);
      expect(res.body.originalUrl).toBe('/info?x=1');
      expect(res.body.ips).toEqual(['1.1.1.1', '2.2.2.2']);
      // Hostname is "localhost" (no subdomain on loopback)
      expect(res.body.subdomains).toEqual([]);
      expect(res.body.lang).toBe('fr');
    });

    it('supports res.attachment and res.format', async () => {
      app.get('/att', (_req: any, res: any) => {
        res.attachment('report.pdf');
        res.status(200).send('pdf-bytes');
      });
      app.get('/fmt', (_req: any, res: any) => {
        res.format({
          'text/plain': () => res.status(200).send('plain'),
          'application/json': () => res.status(200).json({ kind: 'json' }),
          default: () => res.status(406).send('nope'),
        });
      });
      await listen();
      const baseUrl = `http://localhost:${port}`;

      const att = await request(baseUrl).get('/att').expect(200);
      expect(att.headers['content-disposition']).toMatch(/attachment; filename="report\.pdf"/);

      const plain = await request(baseUrl).get('/fmt').set('Accept', 'text/plain').expect(200);
      expect(plain.text).toBe('plain');

      const json = await request(baseUrl).get('/fmt').set('Accept', 'application/json').expect(200);
      expect(json.body.kind).toBe('json');
    });
  });

  describe('error middleware', () => {
    it('routes next(err) into a 4-arg error middleware', async () => {
      app.use((_req: any, _res: any, next: (e?: any) => void) => {
        next(new Error('boom'));
      });
      app.use((err: any, _req: any, res: any, _next: () => void) => {
        res.status(418).json({ caught: err.message });
      });
      app.get('/boom', (_req: any, res: any) => res.json({ ok: true }));

      await listen();
      const res = await request(`http://localhost:${port}`).get('/boom');
      expect(res.status).toBe(418);
      expect(res.body.caught).toBe('boom');
    });
  });

  describe('app.setErrorHandler (native)', () => {
    it('handles thrown errors from route handlers', async () => {
      app.setErrorHandler((err: any, _req: any, res: any) => {
        res.status(500).json({ handled: true, message: err.message });
      });
      app.get('/throw', () => {
        throw new Error('explode');
      });
      await listen();
      const res = await request(`http://localhost:${port}`).get('/throw');
      expect(res.status).toBe(500);
      expect(res.body.handled).toBe(true);
      expect(res.body.message).toBe('explode');
    });
  });

  describe('app.onClose (native)', () => {
    it('runs registered hooks during app.close() in order', async () => {
      const calls: string[] = [];
      app.onClose(() => {
        calls.push('a');
      });
      app.onClose(async () => {
        await delay(5);
        calls.push('b');
      });
      // onClose runs without starting the server
      await app.close();
      expect(calls).toEqual(['a', 'b']);
    });
  });

  describe('decorateRequest / decorateReply (native)', () => {
    it('injects decorations onto every request and response', async () => {
      app.decorateRequest('myValue', 42);
      app.decorateReply('helper', () => 'hi');
      app.get('/deco', (req: any, res: any) => {
        res.json({ v: req.myValue, h: (res.helper as any)() });
      });
      await listen();
      const res = await request(`http://localhost:${port}`).get('/deco').expect(200);
      expect(res.body.v).toBe(42);
      expect(res.body.h).toBe('hi');
    });
  });

  describe('app.group (Express Router replacement)', () => {
    it('registers prefixed routes via app.group', async () => {
      app.group('/api', (g: any) => {
        g.get('/users', (_req: any, res: any) => res.json({ list: ['a', 'b'] }));
        g.post('/users', (req: any, res: any) => res.status(201).json({ created: req.body }));
      });

      await listen();
      await request(`http://localhost:${port}`)
        .get('/api/users')
        .expect(200)
        .expect(res => expect(res.body.list).toEqual(['a', 'b']));
      await request(`http://localhost:${port}`).post('/api/users').send({ name: 'x' }).expect(201);
    });
  });

  describe('createRouter (standalone router)', () => {
    it('mounts routes onto the app at a prefix', async () => {
      const r = createRouter();
      r.get('/users', (_req: any, res: any) => res.json({ list: ['a', 'b'] }));
      r.post('/users', (req: any, res: any) => res.status(201).json({ created: req.body }));
      app.use('/api', r);

      await listen();
      await request(`http://localhost:${port}`)
        .get('/api/users')
        .expect(200)
        .expect(res => expect(res.body.list).toEqual(['a', 'b']));
      await request(`http://localhost:${port}`).post('/api/users').send({ name: 'x' }).expect(201);
    });

    it('runs per-route middlewares (passed as leading args)', async () => {
      const r = createRouter();
      const touch = (req: any, _res: any, next: () => void) => {
        req.context.touched = true;
        next();
      };
      r.get('/p', touch, (req: any, res: any) => res.json({ touched: req.context.touched }));
      app.use(r);

      await listen();
      const res = await request(`http://localhost:${port}`).get('/p').expect(200);
      expect(res.body.touched).toBe(true);
    });
  });

  describe('body-parser aliases', () => {
    it('app.use(json()) is a no-op pass-through (auto body-parse already handles JSON)', async () => {
      app.use(json());
      app.post('/j', (req: any, res: any) => res.json({ got: req.body }));
      await listen();
      const res = await request(`http://localhost:${port}`)
        .post('/j')
        .send({ hello: 'world' })
        .expect(200);
      expect(res.body.got).toEqual({ hello: 'world' });
    });

    it('urlencoded() parses string bodies if not pre-parsed', async () => {
      app.use(urlencoded({ extended: false }));
      app.post('/u', (req: any, res: any) => res.json({ got: req.body }));
      await listen();
      // supertest will serialize form fields and set the right content-type
      const res = await request(`http://localhost:${port}`)
        .post('/u')
        .type('form')
        .send({ a: '1', b: 'two' })
        .expect(200);
      // body may have been auto-parsed or parsed by our urlencoded() — either way:
      expect(res.body.got.a).toBe('1');
      expect(res.body.got.b).toBe('two');
    });
  });
});

// ---------------------------------------------------------------------------
// The suites below pin the (req, res, next) contract on an explicit HTTP
// backend. UnifiedRouter and the configuration are process-wide, so each test
// boots one app, exercises it and closes it before the next one starts.
// ---------------------------------------------------------------------------

type BackendId = 'node' | 'moro';
const BACKENDS: BackendId[] = engineLoadable ? ['node', 'moro'] : ['node'];

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  body: string;
}

// A raw node:http client: the path goes out exactly as written (trailing
// slashes included) and the body is captured whatever its content type.
function send(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({
          status: res.statusCode as number,
          headers: res.headers,
          raw,
          body: raw.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let current: any;

async function createFor(backend: BackendId) {
  resetConfig();
  UnifiedRouter.reset();
  const app: any = await createApp({
    logger: { level: 'fatal' },
    autoDiscover: false,
    routing: false,
    server: { engine: backend },
  } as any);
  current = app;
  return app;
}

async function boot(backend: BackendId, register: (app: any) => void | Promise<void>) {
  const app = await createFor(backend);
  await register(app);
  const port = createTestPort();
  await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
  return { app, port };
}

const warnings = (spy: any): string[] => spy.mock.calls.map((call: any[]) => String(call[0]));

afterEach(async () => {
  if (current) await closeApp(current);
  current = undefined;
  jest.restoreAllMocks();
});

describe.each(BACKENDS)('Express compatibility on the %s backend', backend => {
  describe('routing.strictMiddleware', () => {
    // An async middleware that finishes without next() and without an answer
    const forgetfulAsync = async function ownerOnly(_req: any, _res: any, _next: () => void) {};
    // The same mistake in a function that returns no promise
    const forgetful = (_req: any, _res: any, _next: () => void) => {};
    const twoParameters = (req: any, _res: any) => {
      req.seen = true;
    };
    const callsNext = (_req: any, _res: any, next: () => void) => next();
    const answers = (_req: any, res: any, _next: () => void) => {
      res.status(403).json({ denied: true });
    };
    const answersLater = (_req: any, res: any, _next: () => void) => {
      setTimeout(() => res.status(403).json({ denied: true }), 5);
    };
    const fails = (_req: any, _res: any, next: (err?: unknown) => void) => next(new Error('no'));

    const ran: string[] = [];
    // next() from a callback, as a middleware that looks something up does
    const fromCallback = (_req: any, _res: any, next: () => void) => {
      setTimeout(() => {
        ran.push('callback');
        next();
      }, 5);
    };
    const handler = (name: string) => () => {
      ran.push(name);
      return { ran: name };
    };
    function register(app: any) {
      app.get('/before').before(forgetfulAsync).handler(handler('before'));
      app.get('/use').use(forgetfulAsync).handler(handler('use'));
      app.get('/direct', handler('direct'), { middleware: [callsNext, forgetfulAsync] });
      app.route({
        method: 'GET',
        path: '/schema',
        middleware: [forgetfulAsync],
        handler: handler('schema'),
      });
      app.get('/two').before(twoParameters).handler(handler('two'));
      app.get('/next').before(callsNext).use(callsNext).handler(handler('next'));
      app.get('/answers').before(answers).handler(handler('answers'));
      app.get('/answers-later').before(answersLater).handler(handler('answers-later'));
      app.get('/fails').before(fails).handler(handler('fails'));
      app.get('/later').before(fromCallback).handler(handler('later'));
      app.get('/waits').before(forgetful).handler(handler('waits'));
    }
    const ANSWERED = [
      'before',
      'use',
      'direct',
      'schema',
      'two',
      'next',
      'answers',
      'fails',
      'later',
    ];

    // The status of a request, or 'no answer' when none has come in 300 ms
    function statusOf(port: number, urlPath: string): Promise<number | string> {
      return new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, agent: false }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode as number));
        });
        req.on('error', () => resolve('no answer'));
        req.setTimeout(300, () => req.destroy());
        req.end();
      });
    }

    async function bootWith(routing: unknown, level = 'fatal') {
      resetConfig();
      UnifiedRouter.reset();
      ran.length = 0;
      const app: any = await createApp({
        logger: { level },
        autoDiscover: false,
        routing,
        server: { engine: backend },
      } as any);
      current = app;
      register(app);
      const port = createTestPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
      const statuses: Record<string, number | string> = {};
      for (const name of ANSWERED) statuses[name] = await statusOf(port, `/${name}`);
      return { port, statuses };
    }

    it('waits for next() when on, and passes a request on when the middleware returns when off', async () => {
      // Off, which is the default: a middleware that returns passes the
      // request on, so the handler runs before a callback has called next()
      const off = await bootWith(false);
      expect(off.statuses).toEqual({
        before: 200,
        use: 200,
        direct: 200,
        schema: 200,
        two: 200,
        next: 200,
        answers: 403,
        fails: 500,
        later: 200,
      });
      await delay(20);
      expect(await statusOf(off.port, '/waits')).toBe(200);
      expect(ran).toEqual([
        'before',
        'use',
        'direct',
        'schema',
        'two',
        'next',
        'later',
        'callback',
        'waits',
      ]);
      await closeApp(current);

      const failures: string[] = [];
      logger.addOutput({
        name: 'strict-middleware',
        write: (entry: any) => {
          if (entry.level === 'error' && String(entry.message).includes('without calling next()')) {
            failures.push(String(entry.message));
          }
        },
      } as any);
      try {
        const on = await bootWith({ enabled: false, strictMiddleware: true }, 'error');
        expect(on.statuses).toEqual({
          before: 500,
          use: 500,
          direct: 500,
          schema: 500,
          two: 200,
          next: 200,
          answers: 403,
          fails: 500,
          later: 200,
        });
        // The handler ran once the callback had called next()
        expect(ran).toEqual(['two', 'next', 'callback', 'later']);

        // An answer from a callback is the answer; a middleware that does
        // neither is waited for, and its handler does not run
        expect(await statusOf(on.port, '/answers-later')).toBe(403);
        expect(await statusOf(on.port, '/waits')).toBe('no answer');
        expect(ran).toEqual(['two', 'next', 'callback', 'later']);
      } finally {
        logger.removeOutput('strict-middleware');
        logger.setLevel('fatal');
      }

      // One line for each request refused, naming the route and the middleware
      expect(failures).toHaveLength(4);
      expect(failures[0]).toContain("Middleware 'ownerOnly' on GET /before finished without");
      expect(failures[1]).toContain("Middleware 'ownerOnly' on GET /use ");
      expect(failures[2]).toContain("Middleware 'ownerOnly' on GET /direct ");
      expect(failures[3]).toContain("Middleware 'ownerOnly' on GET /schema ");
    });
  });

  describe('next(err) from route-level middleware', () => {
    const deny = (_req: any, _res: any, next: (err?: unknown) => void) => next(new Error('denied'));

    it('aborts before the handler for every attachment form', async () => {
      const ran: string[] = [];
      const handler = (name: string) => () => {
        ran.push(name);
        return { ran: name };
      };
      const { port } = await boot(backend, app => {
        app.get('/before').before(deny).handler(handler('before'));
        app.get('/use').use(deny).handler(handler('use'));
        app.get('/direct', handler('direct'), { middleware: [deny] });
        app.route({
          method: 'GET',
          path: '/schema',
          middleware: [deny],
          handler: handler('schema'),
        });
      });

      for (const urlPath of ['/before', '/use', '/direct', '/schema']) {
        const res = await send(port, 'GET', urlPath);
        expect({ path: urlPath, status: res.status }).toEqual({ path: urlPath, status: 500 });
        expect(res.body).not.toContain('"ran"');
      }
      expect(ran).toEqual([]);
    });

    it('also aborts when next(err) is called after an await', async () => {
      let handlerRan = false;
      const lateDeny = async (_req: any, _res: any, next: (err?: unknown) => void) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        next(new Error('denied late'));
      };
      const { port } = await boot(backend, app => {
        app
          .get('/late')
          .before(lateDeny)
          .handler(() => {
            handlerRan = true;
            return { ran: true };
          });
      });

      const res = await send(port, 'GET', '/late');
      expect(res.status).toBe(500);
      expect(handlerRan).toBe(false);
    });

    it('still advances on next(), next(null) and next(undefined)', async () => {
      const { port } = await boot(backend, app => {
        app
          .get('/plain')
          .before((_req: any, _res: any, next: (err?: unknown) => void) => next())
          .handler(() => ({ ok: 'plain' }));
        app
          .get('/null')
          .before((_req: any, _res: any, next: (err?: unknown) => void) => next(null))
          .handler(() => ({ ok: 'null' }));
        app
          .get('/undefined')
          .before((_req: any, _res: any, next: (err?: unknown) => void) => next(undefined))
          .handler(() => ({ ok: 'undefined' }));
      });

      for (const name of ['plain', 'null', 'undefined']) {
        const res = await send(port, 'GET', `/${name}`);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ ok: name });
      }
    });

    it('a guard that answers itself still stops the chain', async () => {
      let handlerRan = false;
      const { port } = await boot(backend, app => {
        app
          .get('/answered')
          .before((_req: any, res: any) => {
            res.status(401).json({ error: 'unauthorized' });
          })
          .handler(() => {
            handlerRan = true;
            return { ran: true };
          });
      });

      const res = await send(port, 'GET', '/answered');
      expect(res.status).toBe(401);
      expect(handlerRan).toBe(false);
    });
  });

  describe('trailing slash and route middleware', () => {
    it('never reaches a createRouter() handler without its guard', async () => {
      let purged = 0;
      const { port } = await boot(backend, async app => {
        const admin = createRouter();
        admin.use((req: any, res: any, next: () => void) => {
          if (req.headers.authorization !== 'Bearer s3cret') {
            res.status(401).json({ error: 'denied' });
            return;
          }
          next();
        });
        admin.get('/users', () => ({ users: ['alice', 'bob'] }));
        admin.post('/users/purge', () => ({ purged: ++purged }));
        await app.use('/admin', admin);
      });

      for (const [method, urlPath] of [
        ['GET', '/admin/users'],
        ['GET', '/admin/users/'],
        ['GET', '/admin/users/?x=1'],
        ['POST', '/admin/users/purge'],
        ['POST', '/admin/users/purge/'],
      ] as const) {
        const res = await send(port, method, urlPath);
        // The slash form may be routed (Node servers) or not found (native
        // engine); it must never be a 200 without credentials.
        expect({ path: urlPath, ok: res.status === 200 }).toEqual({ path: urlPath, ok: false });
        expect(res.body).not.toContain('alice');
      }
      expect(purged).toBe(0);

      // With credentials the canonical URL still works.
      const ok = await send(port, 'GET', '/admin/users', { authorization: 'Bearer s3cret' });
      expect(ok.status).toBe(200);
    });

    it('runs direct-form middleware on the slash form as well', async () => {
      let guardRuns = 0;
      const { port } = await boot(backend, app => {
        app.get('/reports', () => ({ rows: [1, 2, 3] }), {
          middleware: [
            (_req: any, res: any) => {
              guardRuns++;
              res.status(403).json({ error: 'forbidden' });
            },
          ],
        });
      });

      expect((await send(port, 'GET', '/reports')).status).toBe(403);
      const slash = await send(port, 'GET', '/reports/');
      expect(slash.status).not.toBe(200);
      expect(slash.body).not.toContain('rows');
      expect(guardRuns).toBeGreaterThanOrEqual(1);
    });
  });

  describe('app.use(prefix, fn)', () => {
    it('runs the middleware at and under the prefix, on a segment boundary only', async () => {
      const seen: string[] = [];
      const { port } = await boot(backend, async app => {
        await app.use('/admin', (req: any, res: any, next: () => void) => {
          seen.push(`${req.path} ${req.url}`);
          if (req.headers.authorization !== 'Bearer s3cret') {
            res.status(401).json({ error: 'denied' });
            return;
          }
          next();
        });
        app.get('/admin', () => ({ at: 'admin' }));
        app.get('/admin/users', () => ({ users: ['alice'] }));
        app.get('/admin/users/:id', (req: any) => ({ user: req.params.id }));
        app.get('/administrator', () => ({ open: 'administrator' }));
        app.get('/public', () => ({ open: 'public' }));
      });

      for (const urlPath of ['/admin', '/admin/users', '/admin/users/7', '/admin/users?x=1']) {
        const res = await send(port, 'GET', urlPath);
        expect({ path: urlPath, status: res.status }).toEqual({ path: urlPath, status: 401 });
        expect(res.body).not.toContain('alice');
      }
      const allowed = await send(port, 'GET', '/admin/users/7', {
        authorization: 'Bearer s3cret',
      });
      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.body)).toEqual({ user: '7' });

      // A sibling that merely starts with the same characters, and everything
      // outside the prefix, never reaches the middleware.
      expect(JSON.parse((await send(port, 'GET', '/administrator')).body)).toEqual({
        open: 'administrator',
      });
      expect(JSON.parse((await send(port, 'GET', '/public')).body)).toEqual({ open: 'public' });
      expect(seen.every(entry => entry.startsWith('/admin'))).toBe(true);
      expect(seen.some(entry => entry.startsWith('/administrator'))).toBe(false);
      // The request is passed on as it arrived: path and url keep the prefix.
      expect(seen).toContain('/admin/users /admin/users');
      expect(seen).toContain('/admin/users /admin/users?x=1');
    });

    it('takes the prefix with or without its slashes, and "/" covers everything', async () => {
      const hits: string[] = [];
      const { port } = await boot(backend, async app => {
        await app.use('api/', (req: any, _res: any, next: () => void) => {
          hits.push(`api:${req.path}`);
          next();
        });
        await app.use('/', (req: any, _res: any, next: () => void) => {
          hits.push(`root:${req.path}`);
          next();
        });
        app.get('/api/ping', () => ({ ok: true }));
        app.get('/other', () => ({ ok: true }));
      });

      expect((await send(port, 'GET', '/api/ping')).status).toBe(200);
      expect((await send(port, 'GET', '/other')).status).toBe(200);
      expect(hits).toEqual(['api:/api/ping', 'root:/api/ping', 'root:/other']);
    });

    it('mounts (err, req, res, next) error middleware at the prefix as well', async () => {
      const { port } = await boot(backend, async app => {
        await app.use((req: any, _res: any, next: (err?: unknown) => void) => {
          next(req.headers['x-fail'] ? new Error('boom') : undefined);
        });
        await app.use('/api', (err: any, _req: any, res: any, _next: () => void) => {
          res.status(418).json({ caught: err.message });
        });
        app.get('/api/thing', () => ({ ok: 'api' }));
        app.get('/web/thing', () => ({ ok: 'web' }));
      });

      const caught = await send(port, 'GET', '/api/thing', { 'x-fail': '1' });
      expect(caught.status).toBe(418);
      expect(JSON.parse(caught.body)).toEqual({ caught: 'boom' });
      // Outside the prefix the error is not this handler's to answer.
      const elsewhere = await send(port, 'GET', '/web/thing', { 'x-fail': '1' });
      expect(elsewhere.status).toBe(500);
      expect(elsewhere.body).not.toContain('caught');
      expect((await send(port, 'GET', '/api/thing')).status).toBe(200);
    });
  });

  describe('app.use() with something it cannot register', () => {
    it('throws at registration and says what it was given', async () => {
      const app = await createFor(backend);
      const twoArgs = function guard(_req: any, _res: any) {};

      await expect(app.use(twoArgs)).rejects.toThrow(
        /app\.use\(\): cannot register the function 'guard', which declares 2 parameters/
      );
      await expect(app.use({ requests: 2, window: 60000 })).rejects.toThrow(
        /cannot register an object with the keys requests, window/
      );
      await expect(app.use(null)).rejects.toThrow(/cannot register null/);
      await expect(app.use('/admin')).rejects.toThrow(/cannot register .* at the prefix '\/admin'/);
      await expect(app.use('/admin', twoArgs)).rejects.toThrow(
        /the function 'guard', which declares 2 parameters at the prefix '\/admin'/
      );
      await expect(
        app.use('/static', { install() {}, metadata: { name: 'static' } })
      ).rejects.toThrow(/at the prefix '\/static'.*cannot be mounted at a prefix/);

      // Every shape it does support is still taken.
      let pluginSawApp = false;
      await app.use((_req: any, _res: any, next: () => void) => next());
      await app.use((_err: any, _req: any, _res: any, next: () => void) => next());
      await app.use('/scoped', (_req: any, _res: any, next: () => void) => next());
      await app.use(createRouter());
      await app.use('/mounted', createRouter());
      await app.use((instance: any) => {
        pluginSawApp = instance === app;
      });
      expect(pluginSawApp).toBe(true);
    });
  });

  describe('route options in the app.METHOD(path, handler, options) form', () => {
    const strictEmail = {
      safeParse: (value: any) =>
        value && typeof value.email === 'string' && value.email.includes('@')
          ? { success: true, data: { email: value.email.toLowerCase() } }
          : {
              success: false,
              error: { issues: [{ path: ['email'], message: 'Invalid email', code: 'custom' }] },
            },
      parseAsync: async (value: unknown) => value,
    };
    const postJson = (port: number, urlPath: string, body: unknown) =>
      new Promise<Reply>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: urlPath,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
          },
          res => {
            const chunks: Buffer[] = [];
            res.on('data', d => chunks.push(d as Buffer));
            res.on('end', () => {
              const raw = Buffer.concat(chunks);
              resolve({
                status: res.statusCode as number,
                headers: res.headers,
                raw,
                body: raw.toString('utf8'),
              });
            });
          }
        );
        req.on('error', reject);
        req.end(payload);
      });

    it('validates with `validation`, as an object of schemas or a body schema on its own', async () => {
      const received: unknown[] = [];
      const { port } = await boot(backend, app => {
        const handler = (req: any) => {
          received.push(req.body);
          return { ok: true };
        };
        app.post('/signup', handler, { validation: { body: strictEmail } });
        app.post('/subscribe', handler, { validation: strictEmail });
      });

      for (const urlPath of ['/signup', '/subscribe']) {
        const bad = await postJson(port, urlPath, { email: 'nope' });
        expect({ path: urlPath, status: bad.status }).toEqual({ path: urlPath, status: 400 });
        expect(bad.body).toContain('Invalid email');
      }
      expect(received).toEqual([]);

      expect((await postJson(port, '/signup', { email: 'A@B.CO' })).status).toBe(200);
      // The handler gets what the schema produced, not what was sent.
      expect(received).toEqual([{ email: 'a@b.co' }]);
    });

    it('validates a declared query schema on a bare URL, and a param route says its reply is text', async () => {
      let ran = 0;
      const { port } = await boot(backend, app => {
        app
          .get('/export')
          .query(z.object({ token: z.string().min(8), limit: z.coerce.number().default(10) }))
          .handler((req: any) => {
            ran++;
            return { limit: req.query.limit };
          });
        // A global middleware, so the parameter route is answered in JavaScript
        // on every backend.
        app.use((_req: any, _res: any, next: () => void) => next());
        app.get('/echo/:word', param('word'));
      });

      const bare = await fetch(`http://127.0.0.1:${port}/export`);
      expect(bare.status).toBe(400);
      expect(ran).toBe(0);

      const good = await fetch(`http://127.0.0.1:${port}/export?token=abcdefgh`);
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ limit: 10 });

      const echoed = await fetch(`http://127.0.0.1:${port}/echo/%3Cb%3Ehi`);
      expect(echoed.status).toBe(200);
      expect(echoed.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await echoed.text()).toBe('<b>hi');
    });

    // Rate-limit counters and cached responses are kept per process, so each
    // backend gets paths of its own.
    it('limits with `rateLimit`', async () => {
      const limitedPath = `/limited-${backend}`;
      const { port } = await boot(backend, app => {
        app.get(limitedPath, () => ({ ok: true }), { rateLimit: { requests: 2, window: 60000 } });
        app.get('/unlimited', () => ({ ok: true }));
      });

      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await send(port, 'GET', limitedPath)).status);
      expect(statuses).toEqual([200, 200, 429, 429]);
      const limited = await send(port, 'GET', limitedPath);
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await send(port, 'GET', '/unlimited')).status).toBe(200);
    });

    it('caches with `cache`, behind the middleware of the route', async () => {
      let calls = 0;
      const reportPath = `/report-${backend}`;
      const { port } = await boot(backend, app => {
        app.get(reportPath, () => ({ report: ++calls }), {
          cache: { ttl: 60, shared: true },
          middleware: [
            (req: any, res: any, next: () => void) => {
              if (req.headers['x-team'] !== 'ops') {
                res.status(403).json({ error: 'forbidden' });
                return;
              }
              next();
            },
          ],
        });
      });

      const first = await send(port, 'GET', reportPath, { 'x-team': 'ops' });
      expect(JSON.parse(first.body)).toEqual({ report: 1 });
      expect(first.headers['x-cache']).toBe('MISS');
      const denied = await send(port, 'GET', reportPath);
      expect(denied.status).toBe(403);
      expect(denied.body).not.toContain('report');
      const second = await send(port, 'GET', reportPath, { 'x-team': 'ops' });
      expect(JSON.parse(second.body)).toEqual({ report: 1 });
      expect(second.headers['x-cache']).toBe('HIT');
      expect(calls).toBe(1);
    });

    it('checks `auth`, with its validator', async () => {
      const { port } = await boot(backend, async app => {
        await app.use((req: any, _res: any, next: () => void) => {
          const user = req.headers['x-user'];
          req.auth = user
            ? { isAuthenticated: true, user: { id: user, roles: ['user'] } }
            : { isAuthenticated: false };
          next();
        });
        app.get('/users/:id/orders', (req: any) => ({ orders: [`${req.params.id}-1`] }), {
          auth: { required: true, validator: (req: any) => req.auth.user.id === req.params.id },
        });
      });

      expect((await send(port, 'GET', '/users/u1/orders')).status).toBe(401);
      const other = await send(port, 'GET', '/users/u2/orders', { 'x-user': 'u1' });
      expect(other.status).toBe(403);
      expect(other.body).not.toContain('u2-1');
      const own = await send(port, 'GET', '/users/u1/orders', { 'x-user': 'u1' });
      expect(own.status).toBe(200);
      expect(JSON.parse(own.body)).toEqual({ orders: ['u1-1'] });
    });

    it('applies the same options on the slash form, with one counter for both', async () => {
      let calls = 0;
      const limitedPath = `/slash-limited-${backend}`;
      const { port } = await boot(backend, app => {
        app.post('/signup', () => ({ created: ++calls }), { validation: { body: strictEmail } });
        app.get(limitedPath, () => ({ ok: true }), { rateLimit: { requests: 2, window: 60000 } });
      });

      // Routed (Node servers) or not found (native engine): never the handler
      // with a body the schema refuses.
      const bad = await postJson(port, '/signup/', { email: 'nope' });
      expect(bad.status).not.toBe(200);
      expect(calls).toBe(0);

      const statuses: number[] = [];
      for (const urlPath of [
        limitedPath,
        `${limitedPath}/`,
        limitedPath,
        `${limitedPath}/`,
        limitedPath,
      ]) {
        statuses.push((await send(port, 'GET', urlPath)).status);
      }
      expect(statuses.filter(status => status === 200).length).toBeLessThanOrEqual(2);
      expect(statuses[4]).toBe(429);
    });

    it('names an option it does not know, once, when the route is registered', async () => {
      const app = await createFor(backend);
      const warn = jest.spyOn(app.logger, 'warn');

      app.get('/plain', () => ({ ok: true }));
      app.get('/known', () => ({ ok: true }), {
        middleware: [],
        validation: { body: strictEmail },
        rateLimit: { requests: 2, window: 60000 },
        cache: { ttl: 60 },
        auth: { roles: ['admin'] },
        description: 'A route',
        tags: ['x'],
      });
      expect(warnings(warn)).toEqual([]);

      app.get('/odd', () => ({ ok: true }), {
        timeout: 5000,
        rateLimit: { requests: 2, window: 1 },
      });
      const messages = warnings(warn);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('GET /odd');
      expect(messages[0]).toContain("'timeout'");
      expect(messages[0]).toContain('NOT be applied');
      expect(messages[0]).not.toContain("'rateLimit'");

      // A function where the options go is a handler that would never run.
      const first = (_req: any, _res: any, next: () => void) => next();
      app.get('/two-functions', first, () => ({ ok: true }));
      expect(warnings(warn)).toHaveLength(2);
      expect(warnings(warn)[1]).toContain('GET /two-functions');
      expect(warnings(warn)[1]).toContain('third argument is a function');
    });
  });

  describe('request targets no route is registered under', () => {
    // The request line goes out exactly as written; node:http would refuse to
    // send a path that does not start with a slash.
    const rawStatus = (port: number, target: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        let head = '';
        socket.on('data', chunk => {
          head += chunk.toString('latin1');
        });
        socket.on('close', () => resolve(Number(head.split(' ')[1])));
        socket.on('error', reject);
      });

    it('refuses doubled slashes and a missing leading slash that a prefix check would not see', async () => {
      const seen: string[] = [];
      let handled = 0;
      const { port } = await boot(backend, async app => {
        await app.use((req: any, res: any, next: () => void) => {
          seen.push(req.path);
          if (req.path.startsWith('/admin')) {
            res.status(401).json({ error: 'denied' });
            return;
          }
          next();
        });
        const handler = () => ({ handled: ++handled });
        app.get('/admin/users/:id', handler);
        app.get('/admin/reports/:id').handler(handler);
        app.get('/admin/static', handler);
      });

      expect(await rawStatus(port, '/admin/users/1')).toBe(401);
      for (const target of [
        '//admin/users/1',
        '//admin/reports/1',
        '//admin/static',
        '///admin/users/1',
      ]) {
        expect({ target, status: await rawStatus(port, target) }).toEqual({ target, status: 404 });
      }
      for (const target of ['admin/users/1', 'admin/reports/1', 'admin/static']) {
        expect({ target, status: await rawStatus(port, target) }).toEqual({ target, status: 400 });
      }
      expect(handled).toBe(0);
    });

    it('still matches a parameter route with one trailing slash', async () => {
      const { port } = await boot(backend, app => {
        app.get('/items/:id', (req: any) => ({ id: req.params.id }));
      });
      expect(await rawStatus(port, '/items/5')).toBe(200);
      expect(await rawStatus(port, '/items/5/')).toBe(200);
      expect(await rawStatus(port, '/items//5')).toBe(404);
      expect(await rawStatus(port, '/items/5//')).toBe(404);
    });
  });
});

describe('res.sendFile on the Node server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-sendfile-'));
  const smallPath = path.join(dir, 'small.txt');
  const largePath = path.join(dir, 'large.bin');
  const small = Buffer.from('hello world\n');
  const large = Buffer.alloc(300 * 1024);
  for (let i = 0; i < large.length; i++) large[i] = i % 251;
  fs.writeFileSync(smallPath, small);
  fs.writeFileSync(largePath, large);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends small and large files intact, and 404s what is not a file', async () => {
    const { port } = await boot('node', app => {
      app.get('/small', (_req: any, res: any) => res.sendFile(smallPath));
      app.get('/large', (_req: any, res: any) => res.sendFile(largePath));
      app.get('/missing', (_req: any, res: any) => res.sendFile(path.join(dir, 'nope.bin')));
      app.get('/dir', (_req: any, res: any) => res.sendFile(dir));
    });

    const s = await send(port, 'GET', '/small');
    expect(s.status).toBe(200);
    expect(s.headers['content-length']).toBe(String(small.length));
    expect(s.raw.equals(small)).toBe(true);

    const l = await send(port, 'GET', '/large');
    expect(l.status).toBe(200);
    expect(l.headers['content-length']).toBe(String(large.length));
    expect(l.raw.equals(large)).toBe(true);

    expect((await send(port, 'GET', '/missing')).status).toBe(404);
    expect((await send(port, 'GET', '/dir')).status).toBe(404);

    // A client that abandons a large download does not break the next one.
    await new Promise<void>(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/large' }, res => {
        res.once('data', () => {
          res.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
    });
    const again = await send(port, 'GET', '/large');
    expect(again.raw.equals(large)).toBe(true);
  });
});

describe('response and request details on the Node server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-node-details-'));
  const filePath = path.join(dir, 'report.txt');
  fs.writeFileSync(filePath, 'hello file\n');

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function bootNode(
    register: (app: any) => void | Promise<void>,
    options: Record<string, unknown> = {}
  ): Promise<number> {
    resetConfig();
    UnifiedRouter.reset();
    const app: any = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      server: { engine: 'node' },
      ...options,
    } as any);
    current = app;
    await register(app);
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    return port;
  }

  // Raw bytes in; everything the server sent back, and whether it closed the socket.
  function rawExchange(port: number, bytes: string): Promise<{ text: string; closed: boolean }> {
    return new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
      let text = '';
      const finish = (closed: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ text, closed });
      };
      const timer = setTimeout(() => finish(false), 2000);
      socket.on('data', d => (text += d.toString('latin1')));
      socket.on('close', () => finish(true));
      socket.on('error', () => finish(true));
    });
  }

  function post(port: number, urlPath: string, type: string, body: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: urlPath,
          method: 'POST',
          headers: { 'content-type': type },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', d => chunks.push(d as Buffer));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            resolve({
              status: res.statusCode as number,
              headers: res.headers,
              raw,
              body: raw.toString('utf8'),
            });
          });
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  describe('res.download and res.attachment', () => {
    it('sends a name outside Latin-1 as filename* with an ASCII fallback', async () => {
      const port = await bootNode(app => {
        app.get('/awaited', async (_req: any, res: any) => {
          await res.download(filePath, '报告 2026.pdf');
        });
        // Not awaited: a failure here used to be an unhandled rejection
        app.get('/not-awaited', (_req: any, res: any) => {
          res.download(filePath, 'données-日本.csv');
        });
        app.get('/control', (_req: any, res: any) => res.download(filePath, 'a\u0000b\u0007.txt'));
      });

      const awaited = await send(port, 'GET', '/awaited');
      expect(awaited.status).toBe(200);
      expect(awaited.body).toBe('hello file\n');
      expect(awaited.headers['content-disposition']).toBe(
        `attachment; filename="__ 2026.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202026.pdf`
      );

      const notAwaited = await send(port, 'GET', '/not-awaited');
      expect(notAwaited.status).toBe(200);
      expect(notAwaited.headers['content-disposition']).toBe(
        `attachment; filename="donn_es-__.csv"; filename*=UTF-8''donn%C3%A9es-%E6%97%A5%E6%9C%AC.csv`
      );

      // Control characters cannot be part of a file name: they are left out
      const control = await send(port, 'GET', '/control');
      expect(control.status).toBe(200);
      expect(control.headers['content-disposition']).toBe('attachment; filename="ab.txt"');
    });

    it('sends ASCII and Latin-1 names in the quoted filename parameter, unchanged', async () => {
      const port = await bootNode(app => {
        app.get('/ascii', (_req: any, res: any) => res.download(filePath, 'report "final".pdf'));
        // The header as set, read back: what a Latin-1 value looks like on the
        // wire is Node's business
        app.get('/latin1', (_req: any, res: any) => {
          res.attachment('résumé.pdf');
          const value = res.getHeader('Content-Disposition');
          res.removeHeader('Content-Disposition');
          res.json({ value });
        });
        app.get('/default-name', (_req: any, res: any) => res.download(filePath));
      });

      const ascii = await rawExchange(
        port,
        'GET /ascii HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n'
      );
      expect(ascii.text).toContain(
        'Content-Disposition: attachment; filename="report final.pdf"\r\n'
      );

      const latin1 = await send(port, 'GET', '/latin1');
      expect(JSON.parse(latin1.body)).toEqual({ value: 'attachment; filename="résumé.pdf"' });

      const defaultName = await send(port, 'GET', '/default-name');
      expect(defaultName.headers['content-disposition']).toBe('attachment; filename="report.txt"');
    });

    it('answers a missing file with a 404 that carries no Content-Disposition', async () => {
      const port = await bootNode(app => {
        app.get('/missing', (_req: any, res: any) =>
          res.download(path.join(dir, 'nope.pdf'), 'report.pdf')
        );
        app.get('/missing-attachment', (_req: any, res: any) => {
          res.attachment('report.pdf');
          res.setHeader('Cache-Control', 'private, max-age=60');
          return res.sendFile(path.join(dir, 'nope.pdf'));
        });
      });

      const missing = await send(port, 'GET', '/missing');
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body)).toEqual({ success: false, error: 'File not found' });
      expect(missing.headers['content-disposition']).toBeUndefined();

      const attachment = await send(port, 'GET', '/missing-attachment');
      expect(attachment.status).toBe(404);
      expect(attachment.headers['content-disposition']).toBeUndefined();
      // What the handler set about caching is its own decision
      expect(attachment.headers['cache-control']).toBe('private, max-age=60');
    });

    it('never rejects, whatever it is called with', async () => {
      let outcome: Promise<string> | undefined;
      const port = await bootNode(app => {
        app.get('/bad-call', (_req: any, res: any) => {
          outcome = res.download(undefined).then(
            () => 'resolved',
            () => 'rejected'
          );
        });
      });

      const res = await send(port, 'GET', '/bad-call');
      expect(res.status).toBe(500);
      expect(await outcome).toBe('resolved');
    });
  });

  describe('res.redirect and res.location', () => {
    it('percent-encode a target a header cannot carry and leave the rest alone', async () => {
      const port = await bootNode(app => {
        app.get('/unicode', (_req: any, res: any) => res.redirect('/日本/ページ?q=é'));
        app.get('/location', (_req: any, res: any) => res.location('/日本').status(201).end());
        app.get('/ascii', (_req: any, res: any) => res.redirect('/a b?x=%20&y=1#frag', 301));
        app.get('/latin1', (_req: any, res: any) => {
          res.location('/café');
          const value = res.getHeader('Location');
          res.removeHeader('Location');
          res.json({ value });
        });
        app.get('/crlf', (_req: any, res: any) => res.redirect('/a\r\nx-injected: 1'));
      });

      const unicode = await send(port, 'GET', '/unicode');
      expect(unicode.status).toBe(302);
      expect(unicode.headers.location).toBe(
        '/%E6%97%A5%E6%9C%AC/%E3%83%9A%E3%83%BC%E3%82%B8?q=%C3%A9'
      );

      const location = await send(port, 'GET', '/location');
      expect(location.status).toBe(201);
      expect(location.headers.location).toBe('/%E6%97%A5%E6%9C%AC');

      const ascii = await send(port, 'GET', '/ascii');
      expect(ascii.status).toBe(301);
      expect(ascii.headers.location).toBe('/a b?x=%20&y=1#frag');

      // A Latin-1 target is a value a header can carry: set as given
      const latin1 = await send(port, 'GET', '/latin1');
      expect(JSON.parse(latin1.body)).toEqual({ value: '/café' });

      const crlf = await send(port, 'GET', '/crlf');
      expect(crlf.headers.location).toBe('/ax-injected: 1');
      expect(crlf.headers['x-injected']).toBeUndefined();
    });
  });

  describe('res.json', () => {
    const big = { pad: 'x'.repeat(40000) };

    it('does not compress for a client that refuses the encoding with q=0', async () => {
      const port = await bootNode(app => app.get('/big', (_req: any, res: any) => res.json(big)), {
        performance: { compression: { enabled: true } },
      });

      const refused = await send(port, 'GET', '/big', { 'accept-encoding': 'gzip;q=0, identity' });
      expect(refused.status).toBe(200);
      expect(refused.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(refused.body)).toEqual(big);

      // gzip refused, deflate accepted
      const other = await send(port, 'GET', '/big', { 'accept-encoding': 'gzip;q=0, deflate' });
      expect(other.headers['content-encoding']).toBe('deflate');

      // An encoding asked for without q-values is used, as before
      for (const accept of ['gzip', 'deflate']) {
        const res = await send(port, 'GET', '/big', { 'accept-encoding': accept });
        expect({ accept, encoding: res.headers['content-encoding'] }).toEqual({
          accept,
          encoding: accept,
        });
      }
    });

    it('sends a 204 without Content-Length and an undefined value as an empty body', async () => {
      const port = await bootNode(app => {
        app.get('/no-content', (_req: any, res: any) => res.status(204).json({ a: 1 }));
        app.get('/undefined', (_req: any, res: any) => res.status(202).json(undefined));
        app.get('/value', (_req: any, res: any) => res.json({ a: 1 }));
      });

      const noContent = await rawExchange(
        port,
        'GET /no-content HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n'
      );
      expect(noContent.text).toMatch(/^HTTP\/1\.1 204 /);
      expect(noContent.text).not.toMatch(/content-length/i);

      const undefinedBody = await send(port, 'GET', '/undefined');
      expect(undefinedBody.status).toBe(202);
      expect(undefinedBody.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(undefinedBody.headers['content-length']).toBe('0');
      expect(undefinedBody.body).toBe('');

      const value = await send(port, 'GET', '/value');
      expect(value.headers['content-length']).toBe('7');
      expect(value.body).toBe('{"a":1}');
    });
  });

  describe('request intake', () => {
    it('keeps a bracketed IPv6 literal whole in req.hostname', async () => {
      const port = await bootNode(app => app.get('/h', (req: any) => ({ hostname: req.hostname })));

      for (const [host, hostname] of [
        ['[::1]:3000', '[::1]'],
        ['[2001:db8::1]', '[2001:db8::1]'],
        ['example.com:8080', 'example.com'],
        ['example.com', 'example.com'],
      ]) {
        const res = await send(port, 'GET', '/h', { host: host as string });
        expect({ host, ...JSON.parse(res.body) }).toEqual({ host, hostname });
      }
    });

    it('parses a urlencoded body whatever the case of the media type', async () => {
      const port = await bootNode(app => app.post('/form', (req: any) => ({ body: req.body })));

      for (const type of [
        'application/x-www-form-urlencoded',
        'Application/X-WWW-Form-Urlencoded',
        'APPLICATION/X-WWW-FORM-URLENCODED; charset=UTF-8',
      ]) {
        const res = await post(port, '/form', type, 'a=1&b=two+words');
        expect({ type, ...JSON.parse(res.body) }).toEqual({
          type,
          body: { a: '1', b: 'two words' },
        });
      }
    });

    it('advances on next(null) in app.use() middleware', async () => {
      const port = await bootNode(app => {
        app.use((_req: any, _res: any, next: (err?: unknown) => void) => next(null));
        app.get('/ok', () => ({ ok: true }));
      });
      const res = await send(port, 'GET', '/ok');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });

  describe('a request that fails', () => {
    it('closes the connection when the handler fails after the response has started', async () => {
      const port = await bootNode(app => {
        app.get('/late', async (_req: any, res: any) => {
          res.setHeader('Content-Type', 'text/plain');
          res.write('partial');
          await delay(20);
          throw new Error('failed after the first chunk');
        });
        app.get('/done-then-throws', (_req: any, res: any) => {
          res.json({ done: true });
          throw new Error('after the response');
        });
        // The same failure from app.use() middleware, ahead of the router
        app.use(async (req: any, res: any, next: () => void) => {
          if (req.path !== '/late-middleware') return next();
          res.write('partial');
          await delay(20);
          throw new Error('failed after the first chunk');
        });
      });

      for (const urlPath of ['/late', '/late-middleware']) {
        const out = await rawExchange(port, `GET ${urlPath} HTTP/1.1\r\nHost: t\r\n\r\n`);
        expect({ urlPath, closed: out.closed }).toEqual({ urlPath, closed: true });
        expect(out.text).toContain('partial');
        // Not ended as a complete chunked body
        expect(out.text.endsWith('0\r\n\r\n')).toBe(false);
      }

      // A response the handler finished is left alone, whatever it throws afterwards
      const done = await send(port, 'GET', '/done-then-throws');
      expect(done.status).toBe(200);
      expect(JSON.parse(done.body)).toEqual({ done: true });
    });

    it('does not put the headers of the body that never came on the default 500', async () => {
      const port = await bootNode(app => {
        app.get('/boom', (_req: any, res: any) => {
          res.setHeader('Cache-Control', 'public, max-age=31536000');
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Range', 'bytes 0-9/100');
          res.setHeader('ETag', '"abc"');
          res.setHeader('Last-Modified', 'Mon, 01 Jan 2024 00:00:00 GMT');
          res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('X-Frame-Options', 'DENY');
          res.cookie('sid', 'v');
          throw new Error('boom');
        });
        app.get('/boom-no-store', (_req: any, res: any) => {
          res.setHeader('Cache-Control', 'no-store');
          throw new Error('boom');
        });
        // With middleware the route takes the router's other failure path
        app
          .get('/boom-with-middleware')
          .before((_req: any, _res: any, next: () => void) => next())
          .handler((_req: any, res: any) => {
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Cache-Control', 'public, max-age=60');
            throw new Error('boom');
          });
      });

      const res = await send(port, 'GET', '/boom');
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Internal server error' });
      for (const gone of [
        'content-encoding',
        'content-range',
        'etag',
        'last-modified',
        'content-disposition',
        'cache-control',
      ]) {
        expect({ header: gone, value: res.headers[gone] }).toEqual({
          header: gone,
          value: undefined,
        });
      }
      expect(res.headers['content-length']).toBe(String(res.raw.length));
      // Everything else is as the handler set it
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(String(res.headers['set-cookie'])).toContain('sid=v');

      const noStore = await send(port, 'GET', '/boom-no-store');
      expect(noStore.status).toBe(500);
      expect(noStore.headers['cache-control']).toBe('no-store');

      const viaMiddleware = await send(port, 'GET', '/boom-with-middleware');
      expect(viaMiddleware.status).toBe(500);
      expect(viaMiddleware.headers['content-encoding']).toBeUndefined();
      expect(viaMiddleware.headers['cache-control']).toBeUndefined();
    });
  });
});

// Every HTTP server an app can run on: [label, the `server` options].
const SERVERS: Array<[string, Record<string, unknown>]> = [
  ['Node http', { engine: 'node' }],
  ['Node HTTP/2', { engine: 'node', http2: true }],
  ...(engineLoadable ? ([['native engine', { engine: 'moro' }]] as Array<[string, any]>) : []),
];

async function createOn(server: Record<string, unknown>) {
  resetConfig();
  UnifiedRouter.reset();
  const app: any = await createApp({
    logger: { level: 'fatal' },
    autoDiscover: false,
    routing: false,
    server,
  } as any);
  current = app;
  return app;
}

describe('app.close()', () => {
  const listenOn = (app: any) =>
    new Promise<number>(resolve => {
      const port = createTestPort();
      app.listen(port, '127.0.0.1', () => resolve(port));
    });

  it.each(SERVERS.filter(([, server]) => server.engine === 'node'))(
    'resolves when the %s server has closed, not at the deadline for requests in flight',
    async (_label, server) => {
      const app = await createOn(server);
      await listenOn(app);

      const started = Date.now();
      await app.close();

      expect(Date.now() - started).toBeLessThan(1000);
    }
  );

  it('lets a request in flight on the Node server finish, and resolves once it has', async () => {
    const app = await createOn({ engine: 'node' });
    app.get('/slow', async () => {
      await delay(300);
      return { done: true };
    });
    const port = await listenOn(app);
    const reply = send(port, 'GET', '/slow', { connection: 'close' });
    await delay(50);

    const started = Date.now();
    await app.close();
    const took = Date.now() - started;

    expect((await reply).status).toBe(200);
    expect(took).toBeGreaterThanOrEqual(200);
    expect(took).toBeLessThan(1500);
  });
});

describe('app.listen(0)', () => {
  const reachable = (port: number) =>
    new Promise<boolean>(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });

  it.each(SERVERS)(
    'binds a free port on the %s server and reports it through app.address()',
    async (_label, server) => {
      const app = await createOn(server);
      app.get('/ping', () => ({ pong: true }));
      const started: number[] = [];
      app.events.on('server:started', ({ data }: any) => started.push(data.port));
      expect(app.address()).toBeNull();

      await new Promise<void>((resolve, reject) => {
        app.once('error', reject);
        app.listen(0, '127.0.0.1', () => resolve());
      });

      const bound = app.address();
      expect(bound.port).toBeGreaterThan(0);
      expect(await reachable(bound.port)).toBe(true);
      if (!server.http2) {
        const reply = await send(bound.port, 'GET', '/ping', { connection: 'close' });
        expect(JSON.parse(reply.body)).toEqual({ pong: true });
      }
      await waitFor(() => started.length > 0, { description: 'server:started' });
      expect(started).toEqual([bound.port]);

      await app.close();
      expect(app.address()).toBeNull();
    }
  );

  it('is refused with clustering, where every worker would be given a different port', async () => {
    resetConfig();
    UnifiedRouter.reset();
    const app: any = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      performance: { clustering: { enabled: true, workers: 2 } },
    } as any);
    current = app;

    expect(() => app.listen(0)).toThrow(/listen\(0\) cannot be used with performance\.clustering/);
  });
});
