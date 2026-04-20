/* eslint-disable */
// Express-compatibility tests — verify that classic Express idioms run on Moro
// without rewrites. Covers Tier 1 (handler-as-arg, 4-arg error mw, next(err),
// req/res helpers, createRouter, head/options) and native additions (req.context,
// res.locals, app.setErrorHandler, app.onClose, decorateRequest).

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp, createRouter, json, urlencoded } from '../../../src/index.js';
import { createTestPort, delay, closeApp } from '../../setup.js';

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
