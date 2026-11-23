// @ts-nocheck
// Integration - MoroHttp2Server answers real HTTP/2 clients, cleartext
// (prior knowledge, what h2load and `curl --http2-prior-knowledge` speak) and
// over TLS with ALPN. Until 1.8.15 no test drove this server with an h2 client:
// it advertised SETTINGS_ENABLE_PUSH=1, which RFC 9113 §6.5.2 forbids a server
// to send, and nghttp2-based clients (curl, Node, browsers) answered with a
// connection-level PROTOCOL_ERROR before any response could be read. A request
// completing at all is therefore the assertion these tests exist for.
//
// The response-lifecycle tests cover responses that carry no body (HEAD, 204,
// 304), streams the client resets, and compressed bodies: each is answered
// exactly once, and the server keeps serving afterwards. Every one of them
// finishes by sending an ordinary request to the same server; an uncaught
// stream error would fail the test process before that request completes.
//
// The remaining groups state what the same application code must do here as
// it does on the Node http server: app.use() middleware (next(err), error
// middleware), request intake (which status a bad body gets), responses a
// handler builds with HTTP/1.1 habits, the failure path, and the request and
// response helpers, which are compared against the Node server call by call.
import { describe, it, expect, afterEach, beforeAll, afterAll, jest } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as http2 from 'http2';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { createApp, defineModule, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { logger } from '../../src/core/logger/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort, delay, waitFor } from '../setup.js';
import { h2Request, fixture, testCA } from '../utils/tls-client.js';
import {
  createHelperFiles,
  registerHelpers,
  runHelperExchanges,
  expectDocumentedAnswers,
  EXCHANGES,
} from '../utils/helper-parity.js';
import {
  registerSyntaxRoutes,
  SYNTAX_CASES,
  RAW_PATH_CASES,
  describeReply,
  collectAnswers,
  expectedAnswers,
} from '../utils/route-syntax-parity.js';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

const inlineSSL = () => ({ key: fixture('localhost.key'), cert: fixture('localhost.pem') });

function registerRoutes(app: any) {
  app.get('/sum', (req: any) => ({ sum: Number(req.query.a) + Number(req.query.b) }));
  app.get('/text', (req: any, res: any) => res.send('55'));
  app.post('/echo', (req: any) => ({ received: req.body }));
}

interface H2cResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

// Cleartext HTTP/2 with prior knowledge: no upgrade, no TLS, no ALPN.
function h2cRequest(
  port: number,
  reqPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<H2cResponse> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://localhost:${port}`);
    session.on('error', reject);
    const req = session.request({
      ':path': reqPath,
      ':method': options.method ?? 'GET',
      ...options.headers,
    });
    let status = 0;
    let headers: Record<string, string | string[] | undefined> = {};
    const chunks: Buffer[] = [];
    req.on('error', reject);
    req.on('response', h => {
      status = Number(h[':status'] ?? 0);
      headers = h as any;
    });
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      session.close();
      const body = Buffer.concat(chunks);
      resolve({ status, headers, body, text: body.toString('utf8') });
    });
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

// Like h2cRequest, for exchanges that may end without a response: never
// rejects, and reports how the stream ended (`rstCode` 0 is a clean close).
function h2cExchange(
  port: number,
  reqPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}
): Promise<H2cResponse & { rstCode: number }> {
  return new Promise(resolve => {
    const session = http2.connect(`http://localhost:${port}`);
    session.on('error', () => {});
    const req = session.request({
      ':path': reqPath,
      ':method': options.method ?? 'GET',
      ...options.headers,
    });
    let status = 0;
    let headers: Record<string, string | string[] | undefined> = {};
    const chunks: Buffer[] = [];
    req.on('error', () => {});
    req.on('response', h => {
      status = Number(h[':status'] ?? 0);
      headers = h as any;
    });
    req.on('data', c => chunks.push(c));
    req.on('close', () => {
      const body = Buffer.concat(chunks);
      const rstCode = req.rstCode;
      session.destroy();
      resolve({ status, headers, body, text: body.toString('utf8'), rstCode });
    });
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

// One request against the Node http server, in the shape h2cRequest returns.
function http1Request(
  port: number,
  reqPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<H2cResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as any,
            body,
            text: body.toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('HTTP/2 server end to end', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  describe('cleartext (h2c, prior knowledge)', () => {
    it('answers GET and POST streams and labels the bodies', async () => {
      const port = createTestPort();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node', http2: true },
      });
      expect(app.engine.server).toBe('http2');
      registerRoutes(app);
      await listen(app, port);

      const sum = await h2cRequest(port, '/sum?a=13&b=42');
      expect(sum.status).toBe(200);
      expect(String(sum.headers['content-type'])).toContain('application/json');
      expect(JSON.parse(sum.text)).toEqual({ sum: 55 });

      // A bare number is text, not JSON (the sniff looks for '{' or '[')
      const text = await h2cRequest(port, '/text');
      expect(text.status).toBe(200);
      expect(String(text.headers['content-type'])).toContain('text/plain');
      expect(text.text).toBe('55');
      expect(text.headers['content-length']).toBe('2');

      const echo = await h2cRequest(port, '/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'h2' }),
      });
      expect(echo.status).toBe(200);
      expect(JSON.parse(echo.text)).toEqual({ received: { hello: 'h2' } });
    });

    it('lists h2 as the only protocol it speaks', async () => {
      const port = createTestPort();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node', http2: true },
      });
      registerRoutes(app);
      await listen(app, port);

      expect(app.engine.protocols).toEqual(['h2']);

      // An HTTP/1.1 client gets HTTP/2 frames back, which it cannot parse
      const outcome = await new Promise<string>(resolve => {
        const req = http.get({ host: 'localhost', port, path: '/text', agent: false }, res => {
          res.resume();
          resolve(`status ${res.statusCode}`);
        });
        req.on('error', error => resolve((error as { code?: string }).code ?? error.message));
      });
      expect(outcome).not.toMatch(/^status/);

      expect((await h2cRequest(port, '/text')).status).toBe(200);
    });

    it('answers an unknown path with a 404 instead of hanging the stream', async () => {
      const port = createTestPort();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node', http2: true },
      });
      registerRoutes(app);
      await listen(app, port);

      const missing = await h2cRequest(port, '/nope');
      expect(missing.status).toBe(404);
    });

    it('serves many streams on one session', async () => {
      const port = createTestPort();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node', http2: true },
      });
      registerRoutes(app);
      await listen(app, port);

      const session = http2.connect(`http://localhost:${port}`);
      try {
        const one = (i: number) =>
          new Promise<string>((resolve, reject) => {
            const req = session.request({ ':path': `/sum?a=${i}&b=1` });
            const chunks: Buffer[] = [];
            req.on('error', reject);
            req.on('data', c => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.end();
          });
        const bodies = await Promise.all(Array.from({ length: 20 }, (_, i) => one(i)));
        bodies.forEach((body, i) => expect(JSON.parse(body)).toEqual({ sum: i + 1 }));
      } finally {
        session.close();
      }
    });
  });

  describe('response lifecycle (h2c)', () => {
    const BIG = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row-${i}` })) };

    async function boot(extra: Record<string, unknown> = {}): Promise<number> {
      resetConfig();
      UnifiedRouter.reset();
      app = await createApp({
        logger: { level: 'fatal' },
        autoDiscover: false,
        routing: false,
        server: { engine: 'node', http2: true },
        ...extra,
      } as any);
      expect(app.engine.server).toBe('http2');
      app.get('/ok', () => ({ ok: true }));
      app.get('/big', () => BIG);
      app.get('/no-content', (_req: any, res: any) => {
        res.status(204).end();
      });
      app.get('/no-content-json', (_req: any, res: any) => {
        res.status(204).json({ ignored: true });
      });
      app.get('/not-modified', (_req: any, res: any) => {
        res.setHeader('etag', '"v1"');
        res.status(304).end();
      });
      app.get('/redirect', (_req: any, res: any) => res.redirect('/ok'));
      const port = createTestPort();
      await listen(app, port);
      return port;
    }

    const stillServing = async (port: number) => {
      const res = await h2cRequest(port, '/ok');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ ok: true });
    };

    it('answers HEAD requests without a body, for known and unknown paths', async () => {
      const port = await boot();

      const known = await h2cRequest(port, '/ok', { method: 'HEAD' });
      expect(known.body.length).toBe(0);
      expect(known.status).toBeGreaterThanOrEqual(200);

      const unknown = await h2cRequest(port, '/does-not-exist', { method: 'HEAD' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.length).toBe(0);

      await stillServing(port);
    });

    it('answers 204 and 304 without a body', async () => {
      const port = await boot();

      const noContent = await h2cRequest(port, '/no-content');
      expect(noContent.status).toBe(204);
      expect(noContent.body.length).toBe(0);
      expect(noContent.headers['content-length']).toBeUndefined();

      const noContentJson = await h2cRequest(port, '/no-content-json');
      expect(noContentJson.status).toBe(204);
      expect(noContentJson.body.length).toBe(0);
      expect(noContentJson.headers['content-length']).toBeUndefined();

      const notModified = await h2cRequest(port, '/not-modified');
      expect(notModified.status).toBe(304);
      expect(notModified.body.length).toBe(0);
      expect(notModified.headers['etag']).toBe('"v1"');

      const redirect = await h2cRequest(port, '/redirect');
      expect(redirect.status).toBe(302);
      expect(redirect.headers['location']).toBe('/ok');

      await stillServing(port);
    });

    it('survives a client resetting a stream whose response is still queued', async () => {
      const port = await boot();

      // A zero-size flow-control window keeps the response body queued on the
      // server, so the reset arrives while the stream still has data to send.
      const session = http2.connect(`http://localhost:${port}`, {
        settings: { initialWindowSize: 0 },
      });
      session.on('error', () => {});
      await new Promise<void>(resolve => session.once('remoteSettings', () => resolve()));
      const req = session.request({ ':path': '/big', ':method': 'GET' });
      req.on('error', () => {});
      await new Promise<void>(resolve => req.once('response', () => resolve()));
      req.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      await delay(100);
      session.destroy();

      await stillServing(port);
    });

    it('res.cookie throws when asked to sign and no cookie middleware is registered', async () => {
      const port = await boot();
      app.get('/set', (_req: any, res: any) => {
        let message = '';
        try {
          res.cookie('pref', 'dark', { signed: true });
        } catch (error) {
          message = (error as Error).message;
        }
        res.cookie('plain', 'y');
        res.json({ message });
      });

      const res = await h2cRequest(port, '/set');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text).message).toMatch(
        /res\.cookie\('pref'.*signed: true.*cannot sign/
      );
      // nothing went out under the name the application wanted signed
      expect(String(res.headers['set-cookie'])).not.toContain('pref');
      expect(String(res.headers['set-cookie'])).toContain('plain=y');
    });

    it('res.cookie takes maxAge in milliseconds and refuses an invalid name or attribute', async () => {
      const port = await boot();
      app.get('/set', (_req: any, res: any) => {
        const outcome: string[] = [];
        const attempt = (set: () => void) => {
          try {
            set();
            outcome.push('sent');
          } catch (error) {
            outcome.push((error as Error).name);
          }
        };
        attempt(() => res.cookie('day', 'x', { maxAge: 24 * 60 * 60 * 1000, path: '/' }));
        attempt(() => res.cookie('a b', 'x'));
        attempt(() => res.cookie('sid', 'x', { path: '/app; Domain=evil.example' }));
        attempt(() => res.cookie('sid', 'x', { domain: 'example.com; Secure' }));
        attempt(() => res.cookie('sid', 'x', { sameSite: 'lax; Secure' }));
        res.json({ outcome });
      });

      const res = await h2cRequest(port, '/set');
      expect(JSON.parse(res.text).outcome).toEqual([
        'sent',
        'TypeError',
        'TypeError',
        'TypeError',
        'TypeError',
      ]);
      expect([res.headers['set-cookie']].flat()).toEqual(['day=x; Max-Age=86400; Path=/']);
    });

    it('honours a refused encoding and compresses large bodies once', async () => {
      const port = await boot({
        // threshold below the body size; inline limit below it too, so the
        // off-thread path is the one exercised
        performance: { compression: { enabled: true, threshold: 100 } },
      });

      const refused = await h2cRequest(port, '/big', {
        headers: { 'accept-encoding': 'gzip;q=0' },
      });
      expect(refused.status).toBe(200);
      expect(refused.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(refused.text)).toEqual(BIG);

      const gzipped = await h2cRequest(port, '/big', { headers: { 'accept-encoding': 'gzip' } });
      expect(gzipped.status).toBe(200);
      expect(gzipped.headers['content-encoding']).toBe('gzip');
      expect(JSON.parse(zlib.gunzipSync(gzipped.body).toString())).toEqual(BIG);

      const deflated = await h2cRequest(port, '/big', {
        headers: { 'accept-encoding': 'deflate' },
      });
      expect(deflated.status).toBe(200);
      expect(deflated.headers['content-encoding']).toBe('deflate');
      expect(JSON.parse(zlib.inflateSync(deflated.body).toString())).toEqual(BIG);

      await stillServing(port);
    });
  });

  // Boots one app on the HTTP/2 server (or, for the comparisons, on the Node
  // http server) with whatever the test registers.
  async function bootWith(
    register: (a: any) => void | Promise<void>,
    extra: Record<string, unknown> = {},
    server: Record<string, unknown> = { engine: 'node', http2: true }
  ): Promise<number> {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({ logger: { level: 'fatal' }, autoDiscover: false, server, ...extra });
    await register(app);
    const port = createTestPort();
    await listen(app, port);
    return port;
  }

  describe('route paths (h2c)', () => {
    it('answers optional parameters and wildcards as the HTTP/1.1 servers do', async () => {
      const port = await bootWith(a => registerSyntaxRoutes(a));
      expect(app.engine.server).toBe('http2');

      // ':path' goes out as written, dot segments included
      const cases = [...SYNTAX_CASES, ...RAW_PATH_CASES];
      const answers = await collectAnswers(cases, async url => {
        const reply = await h2cRequest(port, url);
        return describeReply(reply.status, reply.text);
      });
      expect(answers).toEqual(expectedAnswers(cases));
    });
  });

  describe('app.use() middleware (h2c)', () => {
    it('next(err) stops the request before the handler', async () => {
      let handlerRan = false;
      const port = await bootWith(a => {
        a.use((req: any, _res: any, next: any) =>
          req.headers['x-deny'] ? next(new Error('denied')) : next()
        );
        a.get('/guarded', () => {
          handlerRan = true;
          return { secret: 'data' };
        });
      });

      const denied = await h2cRequest(port, '/guarded', { headers: { 'x-deny': '1' } });
      expect(denied.status).toBe(500);
      expect(denied.text).not.toContain('secret');
      expect(handlerRan).toBe(false);

      const allowed = await h2cRequest(port, '/guarded');
      expect(allowed.status).toBe(200);
      expect(JSON.parse(allowed.text)).toEqual({ secret: 'data' });
    });

    it('next(err) reaches the handler registered with app.setErrorHandler()', async () => {
      const port = await bootWith(a => {
        a.use((_req: any, _res: any, next: any) => next(new Error('denied')));
        a.setErrorHandler((err: any, _req: any, res: any) => {
          res.status(403).json({ refused: err.message });
        });
        a.get('/guarded', () => ({ secret: 'data' }));
      });

      const res = await h2cRequest(port, '/guarded');
      expect(res.status).toBe(403);
      expect(JSON.parse(res.text)).toEqual({ refused: 'denied' });
    });

    it('runs a four-parameter error middleware only for a request that failed', async () => {
      const port = await bootWith(a => {
        a.use((req: any, _res: any, next: any) =>
          req.headers['x-deny'] ? next(new Error('denied')) : next()
        );
        a.use((err: any, _req: any, res: any, _next: any) => {
          res.status(403).json({ refused: err.message });
        });
        a.get('/ok', () => ({ ok: true }));
      });

      const ok = await h2cRequest(port, '/ok');
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({ ok: true });

      const refused = await h2cRequest(port, '/ok', { headers: { 'x-deny': '1' } });
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.text)).toEqual({ refused: 'denied' });
    });

    it('advances on next(null), so next can be handed to a callback API', async () => {
      const port = await bootWith(a => {
        a.use((_req: any, _res: any, next: any) => next(null));
        a.get('/ok', () => ({ ok: true }));
      });
      expect((await h2cRequest(port, '/ok')).status).toBe(200);
    });

    // The shapes an app.use() middleware can have, each on a prefix of its
    // own, and what a request under it gets. The Node http server runs the
    // same shapes: the two answer alike.
    const MIDDLEWARE_SHAPES: Array<[shape: string, answer: string]> = [
      ['calls-next', '200 handler'],
      ['calls-next-later', '200 handler after the callback'],
      ['async-returns', '200 handler'],
      ['answers', '403 denied'],
      ['answers-later', '403 denied'],
      ['returns', 'no answer'],
    ];
    function registerShapes(a: any, order: string[]) {
      a.use('/calls-next', (_req: any, _res: any, next: () => void) => next());
      a.use('/calls-next-later', (_req: any, _res: any, next: () => void) => {
        setTimeout(() => {
          order.push('callback');
          next();
        }, 10);
      });
      a.use('/async-returns', async (_req: any, _res: any, _next: () => void) => {});
      a.use('/answers', (_req: any, res: any, _next: () => void) => {
        res.status(403).json({ denied: true });
      });
      a.use('/answers-later', (_req: any, res: any, _next: () => void) => {
        setTimeout(() => res.status(403).json({ denied: true }), 10);
      });
      // Neither next() nor an answer: the request waits for the next() that
      // a callback may still bring
      a.use('/returns', (_req: any, _res: any, _next: () => void) => {});
      for (const [shape] of MIDDLEWARE_SHAPES) {
        a.get(`/${shape}`, () => {
          order.push(`handler ${shape}`);
          return { handler: true };
        });
      }
    }
    // The status of a GET, or undefined when no answer has come in 300 ms;
    // the request is given up then, so nothing is left open
    const statusOverH2c = (port: number, reqPath: string) =>
      new Promise<number | undefined>(resolve => {
        const session = http2.connect(`http://localhost:${port}`);
        session.on('error', () => {});
        const req = session.request({ ':path': reqPath });
        const giveUp = setTimeout(() => {
          session.destroy();
          resolve(undefined);
        }, 300);
        req.on('error', () => {});
        req.on('response', h => {
          clearTimeout(giveUp);
          req.resume();
          req.on('end', () => session.close());
          resolve(Number(h[':status']));
        });
        req.end();
      });
    const statusOverHttp1 = (port: number, reqPath: string) =>
      new Promise<number | undefined>(resolve => {
        const req = http.request({ host: '127.0.0.1', port, path: reqPath, agent: false }, res => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', () => resolve(undefined));
        req.setTimeout(300, () => req.destroy());
        req.end();
      });

    async function answersOf(
      port: number,
      order: string[],
      get: (port: number, path: string) => Promise<number | undefined>
    ) {
      const answers: Record<string, string> = {};
      for (const [shape] of MIDDLEWARE_SHAPES) {
        order.length = 0;
        const status = await get(port, `/${shape}`);
        const reply = status === undefined ? undefined : { status };
        if (reply === undefined) {
          answers[shape] = order.length === 0 ? 'no answer' : `no answer, ran ${order.join()}`;
        } else if (reply.status === 403) {
          answers[shape] = order.length === 0 ? '403 denied' : `403, ran ${order.join()}`;
        } else if (order.join() === `callback,handler ${shape}`) {
          answers[shape] = `${reply.status} handler after the callback`;
        } else if (order.join() === `handler ${shape}`) {
          answers[shape] = `${reply.status} handler`;
        } else {
          answers[shape] = `${reply.status}, ran ${order.join()}`;
        }
      }
      return answers;
    }

    it('waits for the next() of a middleware that returns without it, as the Node http server does', async () => {
      const order: string[] = [];
      const expected = Object.fromEntries(MIDDLEWARE_SHAPES);

      const port = await bootWith(a => registerShapes(a, order));
      expect(app.engine.server).toBe('http2');
      expect(await answersOf(port, order, statusOverH2c)).toEqual(expected);
      await closeApp(app);

      const http1Port = await bootWith(a => registerShapes(a, order), {}, { engine: 'node' });
      expect(app.engine.server).toBe('node');
      expect(await answersOf(http1Port, order, statusOverHttp1)).toEqual(expected);
    });

    it('upload(): a stored file stays after a success and is removed after a failure', async () => {
      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-h2-upload-'));
      try {
        const port = await bootWith(async a => {
          await a.use(middleware.upload({ dest }));
          a.post('/store', (req: any) => ({ stored: path.basename(req.files.doc.path) }));
          a.post('/store-then-fail', (req: any) => {
            if (typeof req.files.doc.path === 'string') throw new Error('after storing');
          });
        });
        const boundary = 'XBOUND';
        const upload = {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body:
            `--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="note.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\nhello upload\r\n--${boundary}--\r\n`,
        };

        // Nothing for a path with no route
        expect((await h2cRequest(port, '/no-such-route', upload)).status).toBe(404);
        expect((await h2cRequest(port, '/store-then-fail', upload)).status).toBe(500);
        await waitFor(() => fs.readdirSync(dest).length === 0, {
          timeout: 2000,
          description: 'the file of the failed request to be removed',
        });

        const ok = await h2cRequest(port, '/store', upload);
        expect(ok.status).toBe(200);
        await delay(80);
        expect(fs.readdirSync(dest)).toEqual([JSON.parse(ok.text).stored]);
      } finally {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    });
  });

  describe('request intake (h2c)', () => {
    const echo = (a: any) => {
      a.post('/echo', (req: any) => ({ body: req.body }));
      a.get('/q', (req: any) => ({ query: req.query }));
      a.get('/host', (req: any) => ({ host: req.headers.host ?? null }));
    };
    const post = (port: number, type: string, body: string | Buffer) =>
      h2cExchange(port, '/echo', { method: 'POST', headers: { 'content-type': type }, body });

    it('answers 400 to JSON that does not parse and reads an empty JSON body as null', async () => {
      const port = await bootWith(echo);

      const malformed = await post(port, 'application/json', '{"a":');
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.text)).toMatchObject({
        success: false,
        error: 'Invalid request body',
      });

      const empty = await post(port, 'application/json', '');
      expect(empty.status).toBe(200);
      expect(JSON.parse(empty.text)).toEqual({ body: null });
    });

    it('answers 413 to a body over server.bodySizeLimit', async () => {
      const port = await bootWith(echo, {}, { engine: 'node', http2: true, bodySizeLimit: '64kb' });

      const res = await post(port, 'text/plain', 'x'.repeat(200000));
      expect(res.status).toBe(413);
      expect(JSON.parse(res.text)).toEqual({ success: false, error: 'Request entity too large' });

      const small = await post(port, 'text/plain', 'x'.repeat(1000));
      expect(small.status).toBe(200);
    });

    it('answers 413 to a multipart body over a multipart limit', async () => {
      const port = await bootWith(
        echo,
        {},
        { engine: 'node', http2: true, limits: { multipart: { maxParts: 2 } } }
      );
      const part = (name: string) =>
        `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nv\r\n`;

      const over = await post(
        port,
        'multipart/form-data; boundary=b',
        `${part('a')}${part('b')}${part('c')}--b--\r\n`
      );
      expect(over.status).toBe(413);

      const within = await post(
        port,
        'multipart/form-data; boundary=b',
        `${part('a')}${part('b')}--b--\r\n`
      );
      expect(within.status).toBe(200);
      expect(JSON.parse(within.text).body.fields).toEqual({ a: 'v', b: 'v' });
    });

    it('parses a urlencoded body whatever the case of the media type', async () => {
      const port = await bootWith(echo);
      const res = await post(port, 'Application/X-WWW-Form-Urlencoded', 'a=1&b=two');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ body: { a: '1', b: 'two' } });
    });

    it('keeps a query value that is not valid percent-encoding as received', async () => {
      const port = await bootWith(echo);

      const bad = await h2cExchange(port, '/q?a=%E0%A4%A&ok=%20x');
      expect(bad.status).toBe(200);
      expect(JSON.parse(bad.text)).toEqual({ query: { a: '%E0%A4%A', ok: ' x' } });

      // What decoded before decodes the same way
      const plain = await h2cExchange(port, '/q?b=x+y&c=caf%C3%A9&flag');
      expect(JSON.parse(plain.text)).toEqual({ query: { b: 'x+y', c: 'café', flag: '' } });
    });

    it('exposes :authority as req.headers.host when the client sends no Host', async () => {
      const port = await bootWith(echo);

      const fromAuthority = await h2cExchange(port, '/host', {
        headers: { ':authority': 'app.example:8443' },
      });
      expect(JSON.parse(fromAuthority.text)).toEqual({ host: 'app.example:8443' });
    });
  });

  describe('responses built with HTTP/1.1 habits (h2c)', () => {
    it('drops connection-specific headers instead of the whole response', async () => {
      const port = await bootWith(a => {
        a.get('/json', (_req: any, res: any) => {
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Keep-Alive', 'timeout=5');
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('X-Kept', 'yes');
          res.json({ ok: true });
        });
        a.get('/head-first', (_req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'keep-alive' });
          res.end('streamed');
        });
      });

      const json = await h2cExchange(port, '/json');
      expect(json.status).toBe(200);
      expect(JSON.parse(json.text)).toEqual({ ok: true });
      expect(json.headers['x-kept']).toBe('yes');
      expect(json.headers['connection']).toBeUndefined();

      const headFirst = await h2cExchange(port, '/head-first');
      expect(headFirst.status).toBe(200);
      expect(headFirst.text).toBe('streamed');
    });

    it('closes the stream after a body written in pieces and ended without a last chunk', async () => {
      let closed = 0;
      const port = await bootWith(a => {
        a.get('/pieces', (_req: any, res: any) => {
          res.on('close', () => closed++);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('one,');
          setImmediate(() => {
            res.write('two');
            setImmediate(() => res.end());
          });
        });
      });

      const res = await h2cExchange(port, '/pieces');
      expect(res.status).toBe(200);
      expect(res.text).toBe('one,two');
      // The server's side of the stream is released too, not only the client's
      await waitFor(() => closed === 1, { timeout: 2000, description: 'the stream to close' });
    });

    it('answers 500 and logs when the head a handler built cannot be sent', async () => {
      const port = await bootWith(a => {
        a.get('/status-99', (_req: any, res: any) => res.status(99).json({ ok: true }));
        a.get('/status-1000', (_req: any, res: any) => res.status(1000).send('x'));
        a.get('/bad-name', (_req: any, res: any) => {
          res.setHeader('X Bad Name', '1');
          res.json({ ok: true });
        });
      });
      const error = jest
        .spyOn((app as any).coreFramework.httpServer.logger, 'error')
        .mockImplementation(() => {});

      try {
        for (const urlPath of ['/status-99', '/status-1000', '/bad-name']) {
          const res = await h2cExchange(port, urlPath);
          expect({ urlPath, status: res.status }).toEqual({ urlPath, status: 500 });
          expect(JSON.parse(res.text)).toMatchObject({ success: false });
        }
        const logged = error.mock.calls.filter((call: any[]) =>
          String(call[0]).includes('could not be sent')
        );
        expect(logged).toHaveLength(3);
      } finally {
        error.mockRestore();
      }
    });

    it('sends a redirect target without line breaks and with non-ASCII percent-encoded', async () => {
      const port = await bootWith(a => {
        a.get('/crlf', (_req: any, res: any) => res.redirect('/a\r\nx-injected: 1'));
        a.get('/unicode', (_req: any, res: any) => res.redirect('/日本?q=é', 301));
        a.get('/ascii', (_req: any, res: any) => res.redirect('/plain?a=1&b=%20'));
      });

      const crlf = await h2cExchange(port, '/crlf');
      expect(crlf.status).toBe(302);
      expect(crlf.headers['location']).toBe('/ax-injected: 1');
      expect(crlf.headers['x-injected']).toBeUndefined();

      const unicode = await h2cExchange(port, '/unicode');
      expect(unicode.status).toBe(301);
      expect(unicode.headers['location']).toBe('/%E6%97%A5%E6%9C%AC?q=%C3%A9');

      const ascii = await h2cExchange(port, '/ascii');
      expect(ascii.headers['location']).toBe('/plain?a=1&b=%20');
    });
  });

  describe('a request that fails (h2c)', () => {
    it('resets the stream when the handler fails after the response has started', async () => {
      const port = await bootWith(a => {
        a.get('/late', async (_req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('partial');
          await delay(20);
          throw new Error('failed after the first chunk');
        });
        a.get('/ok', () => ({ ok: true }));
      });

      // Bounded: a stream left open would otherwise only show as a test timeout
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stillOpen = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), 3000);
      });
      const late = await Promise.race([h2cExchange(port, '/late'), stillOpen]);
      clearTimeout(timer);
      expect(late).not.toBeNull();
      expect(late?.status).toBe(200);
      expect(late?.text).toBe('partial');
      expect(late?.rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);

      // Only that stream: the server goes on serving
      expect((await h2cRequest(port, '/ok')).status).toBe(200);
    });

    it('does not put the headers of the body that never came on the default 500', async () => {
      const port = await bootWith(a => {
        a.get('/boom', (_req: any, res: any) => {
          res.setHeader('Cache-Control', 'public, max-age=31536000');
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('ETag', '"abc"');
          res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
          res.setHeader('Access-Control-Allow-Origin', '*');
          throw new Error('boom');
        });
        a.get('/boom-private', (_req: any, res: any) => {
          res.setHeader('Cache-Control', 'no-store');
          throw new Error('boom');
        });
      });

      const res = await h2cExchange(port, '/boom');
      expect(res.status).toBe(500);
      expect(JSON.parse(res.text)).toMatchObject({ error: 'Internal server error' });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers['etag']).toBeUndefined();
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['access-control-allow-origin']).toBe('*');

      const kept = await h2cExchange(port, '/boom-private');
      expect(kept.status).toBe(500);
      expect(kept.headers['cache-control']).toBe('no-store');
    });

    it('offers what a module route throws to app.setErrorHandler()', async () => {
      const port = await bootWith(async a => {
        a.setErrorHandler((error: any, _req: any, res: any) => {
          res.status(error.status ?? 500).json({ problem: error.message });
        });
        await a.loadModule(
          defineModule({
            name: 'h2-orders',
            version: '1.0.0',
            routes: [
              {
                method: 'GET',
                path: '/:id',
                handler: () => {
                  throw Object.assign(new Error('no such order'), { status: 404 });
                },
              },
            ],
          } as any)
        );
      });

      const missing = await h2cRequest(port, '/api/v1.0.0/h2-orders/7');
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.text)).toEqual({ problem: 'no such order' });
    });
  });

  // What request logging, metrics and a rate limit's refund wait for: every
  // completed response emits 'finish' once and then 'close'; one that was
  // abandoned emits 'close' alone.
  describe('response events (h2c)', () => {
    const smallFile = path.join(os.tmpdir(), `moro-h2-events-${process.pid}.txt`);
    beforeAll(() => fs.writeFileSync(smallFile, 'a small file\n'));
    afterAll(() => fs.rmSync(smallFile, { force: true }));

    // Every response's events, in order, under "METHOD path"
    const recordEvents = (a: any) => {
      const seen: Record<string, string[]> = {};
      a.use((req: any, res: any, next: () => void) => {
        const events: string[] = (seen[`${req.method} ${req.path}`] = []);
        res.on('finish', () => events.push('finish'));
        res.once('finish', () => events.push('finish (once)'));
        res.on('close', () => events.push('close'));
        next();
      });
      return seen;
    };
    const closed = (seen: Record<string, string[]>, key: string) =>
      waitFor(() => seen[key]?.includes('close') === true, {
        description: `the response to ${key} to close`,
      });

    it("emits 'finish' once, before 'close', however the response was ended", async () => {
      let seen: Record<string, string[]> = {};
      const port = await bootWith(a => {
        seen = recordEvents(a);
        a.get('/json', () => ({ ok: true }));
        a.post('/json', (req: any) => ({ received: req.body }));
        a.put('/json', (req: any, res: any) => res.status(201).json({ received: req.body }));
        a.get('/send', (_req: any, res: any) => res.send('text'));
        a.post('/send', (_req: any, res: any) => res.send('text'));
        a.get('/end', (_req: any, res: any) => res.end('ended'));
        a.post('/end', (_req: any, res: any) => res.end('ended'));
        a.get('/no-content', (_req: any, res: any) => res.status(204).end());
        a.post('/redirect', (_req: any, res: any) => res.redirect('/json'));
        a.get('/redirect', (_req: any, res: any) => res.redirect('/json'));
        a.get('/file', (_req: any, res: any) => res.sendFile(smallFile));
        a.post('/file', (_req: any, res: any) => res.sendFile(smallFile));
        a.get('/pieces', (_req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('one ');
          setTimeout(() => res.end('two'), 10);
        });
      });

      const exchanges: Array<[string, string, number]> = [
        ['GET', '/json', 200],
        ['POST', '/json', 200],
        ['PUT', '/json', 201],
        ['HEAD', '/json', 200], // answered from the GET route, without its body
        ['GET', '/send', 200],
        ['POST', '/send', 200],
        ['GET', '/end', 200],
        ['POST', '/end', 200],
        ['GET', '/no-content', 204],
        ['GET', '/redirect', 302],
        ['POST', '/redirect', 302],
        ['GET', '/file', 200],
        ['POST', '/file', 200],
        ['GET', '/pieces', 200],
        ['GET', '/no-such-route', 404],
        ['POST', '/no-such-route', 404],
      ];
      for (const [method, target, status] of exchanges) {
        const sendsBody = method === 'POST' || method === 'PUT';
        const reply = await h2cExchange(port, target, {
          method,
          ...(sendsBody && {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ n: 1 }),
          }),
        });
        expect([method, target, reply.status]).toEqual([method, target, status]);
        await closed(seen, `${method} ${target}`);
        expect([method, target, seen[`${method} ${target}`]]).toEqual([
          method,
          target,
          ['finish', 'finish (once)', 'close'],
        ]);
      }
    });

    it("emits 'close' without 'finish' for a response that was destroyed", async () => {
      let seen: Record<string, string[]> = {};
      const port = await bootWith(a => {
        seen = recordEvents(a);
        a.get('/abandoned', (_req: any, res: any) => {
          res.destroy();
        });
        a.post('/abandoned', (_req: any, res: any) => {
          res.destroy();
        });
        a.get('/abandoned-midway', (_req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('partial');
          setTimeout(() => res.destroy(), 10);
        });
        a.get('/ok', () => ({ ok: true }));
      });

      for (const [method, target] of [
        ['GET', '/abandoned'],
        ['POST', '/abandoned'],
        ['GET', '/abandoned-midway'],
      ]) {
        const reply = await h2cExchange(port, target as string, {
          method,
          ...(method === 'POST' && {
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
        });
        expect(reply.rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
        await closed(seen, `${method} ${target}`);
        expect(seen[`${method} ${target}`]).toEqual(['close']);
      }
      expect((await h2cRequest(port, '/ok')).status).toBe(200);
    });

    it('logs a request that carried a body, as it logs one that did not', async () => {
      const lines: string[] = [];
      logger.addOutput({
        name: 'h2-request-log',
        write: (entry: any) => lines.push(String(entry.message)),
      } as any);
      try {
        const port = await bootWith(
          a => {
            a.get('/items', () => ({ items: [] }));
            a.post('/items', (_req: any, res: any) => res.status(201).json({ id: 1 }));
          },
          { logger: { level: 'info' } },
          { engine: 'node', http2: true, requestLogging: { enabled: true } }
        );

        expect((await h2cRequest(port, '/items')).status).toBe(200);
        const created = await h2cRequest(port, '/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'first' }),
        });
        expect(created.status).toBe(201);

        const logged = (pattern: RegExp) => lines.filter(line => pattern.test(line));
        await waitFor(() => logged(/^POST \/items - 201 - \d+ms/).length > 0, {
          description: 'the log line of the POST',
        });
        expect(logged(/^GET \/items - 200 - \d+ms/)).toHaveLength(1);
        expect(logged(/^POST \/items - 201 - \d+ms/)).toHaveLength(1);
      } finally {
        logger.removeOutput('h2-request-log');
        logger.setLevel('error');
      }
    });

    it('gives a successful POST back to a limit that skips successful requests', async () => {
      let finished = 0;
      const port = await bootWith(async a => {
        a.use((_req: any, res: any, next: () => void) => {
          res.on('finish', () => finished++);
          next();
        });
        a.post('/h2/orders')
          .rateLimit({ requests: 1, window: 60000, skipSuccessfulRequests: true })
          .handler((req: any, res: any) => {
            if (req.body?.fail) return res.status(422).json({ error: 'refused' });
            return { stored: true };
          });
      });
      const order = (body: Record<string, unknown>) =>
        h2cRequest(port, '/h2/orders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      // Successful requests are given back once they have finished, so they
      // never use the allowance up
      for (let sent = 1; sent <= 3; sent++) {
        expect((await order({})).status).toBe(200);
        await waitFor(() => finished === sent, { description: `request ${sent} to finish` });
      }
      // A failed one is kept, and it is the whole allowance
      expect((await order({ fail: true })).status).toBe(422);
      await waitFor(() => finished === 4, { description: 'the failed request to finish' });
      expect((await order({})).status).toBe(429);
    });
  });

  describe('request and response helpers match the Node http server', () => {
    const files = createHelperFiles();
    const { dir, largePath, large } = files;

    afterAll(() => files.remove());

    async function collect(
      send: (port: number, urlPath: string, options: any) => Promise<H2cResponse>,
      hostHeader: string,
      server: Record<string, unknown>
    ) {
      const port = await bootWith(a => registerHelpers(a, files), {}, server);
      const seen = await runHelperExchanges(send, hostHeader, port, files);
      const closedRequests = app.closedRequests;
      await closeApp(app);
      app = null;
      return { seen, closedRequests };
    }

    it('gives the same answer to every helper call on both servers', async () => {
      const node = await collect(http1Request, 'host', { engine: 'node' });
      const h2 = await collect(h2cRequest, ':authority', { engine: 'node', http2: true });

      // The Node server's answers are what the documentation describes
      expectDocumentedAnswers(node.seen, files);
      expect(node.closedRequests).toBe(1);

      // ... and the HTTP/2 server gives the same ones
      for (const [name] of EXCHANGES) {
        expect({ name, ...h2.seen[name] }).toEqual({ name, ...node.seen[name] });
      }
      expect(h2.closedRequests).toBe(1);
    });

    it('serves an event stream written the HTTP/1.1 way, until the client goes away', async () => {
      let closed = 0;
      const port = await bootWith(a => {
        a.get('/events', (req: any, res: any) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write('retry: 10000\n\n');
          let n = 0;
          const timer = setInterval(() => {
            res.write(`event: tick\ndata: ${JSON.stringify({ n: ++n })}\n\n`);
          }, 10);
          req.on('close', () => {
            clearInterval(timer);
            closed++;
          });
        });
      });

      const session = http2.connect(`http://localhost:${port}`);
      session.on('error', () => {});
      const req = session.request({ ':path': '/events', accept: 'text/event-stream' });
      req.on('error', () => {});
      let status = 0;
      let contentType = '';
      let text = '';
      req.on('response', h => {
        status = Number(h[':status']);
        contentType = String(h['content-type']);
      });
      req.on('data', c => (text += c.toString()));
      req.end();

      await waitFor(() => text.includes('"n":2'), { description: 'two events' });
      expect(status).toBe(200);
      expect(contentType).toContain('text/event-stream');
      expect(text.startsWith('retry: 10000\n\n')).toBe(true);
      expect(text).toContain('event: tick\ndata: {"n":1}\n\n');

      req.close();
      await waitFor(() => closed === 1, { description: "the request's close event" });
      session.destroy();
    });

    it('runs a handler that answers later from a callback once', async () => {
      let runs = 0;
      const port = await bootWith(a => {
        a.get('/later', (_req: any, res: any) => {
          runs++;
          setTimeout(() => res.json({ runs }), 20);
        });
      });

      const res = await h2cRequest(port, '/later');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toEqual({ runs: 1 });
      expect(runs).toBe(1);
    });

    it('issues a CSRF token (the middleware reads req.socket)', async () => {
      const port = await bootWith(async a => {
        await a.use(middleware.cookie());
        await a.use(middleware.csrf({ secret: 'csrf-test-secret' }));
        a.get('/token', async (req: any) => ({ token: await req.csrfToken() }));
      });

      const res = await h2cRequest(port, '/token');
      expect(res.status).toBe(200);
      const { token } = JSON.parse(res.text);
      expect(token).toMatch(/^[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/);
      expect(String(res.headers['set-cookie'])).toContain(`_csrf=${token}`);
    });

    it("carries helmet's headers on a response a hook answers", async () => {
      const port = await bootWith(async a => {
        await a.use(middleware.helmet());
        await a.use(middleware.rateLimit({ requests: 1, window: 60000 }));
        a.get('/limited', () => ({ ok: true }));
      });

      expect((await h2cRequest(port, '/limited')).status).toBe(200);
      const refused = await h2cRequest(port, '/limited');
      expect(refused.status).toBe(429);
      expect(refused.headers['x-content-type-options']).toBe('nosniff');
      expect(refused.headers['x-frame-options']).toBe('DENY');
    });

    it("carries the application's CORS headers on a configured 429 and CSRF 403", async () => {
      const origin = { origin: 'https://app.example' };
      const security = {
        cors: {
          enabled: true,
          origin: ['https://app.example'],
          credentials: true,
          exposedHeaders: ['Retry-After'],
        },
        helmet: { enabled: true },
        // OPTIONS is checked like any other method here
        csrf: { enabled: true, ignoreMethods: ['GET', 'HEAD'] },
        rateLimit: { global: { enabled: true, requests: 2, window: 60000 } },
      };
      const port = await bootWith(
        a => {
          a.get('/limited', () => ({ ok: true }));
        },
        { security }
      );
      const corsOf = (reply: H2cResponse) => ({
        allowOrigin: reply.headers['access-control-allow-origin'],
        credentials: reply.headers['access-control-allow-credentials'],
        exposed: reply.headers['access-control-expose-headers'],
      });
      const readable = {
        allowOrigin: 'https://app.example',
        credentials: 'true',
        exposed: 'Retry-After',
      };

      // A preflight is CORS's to answer: not counted, not asked for a token
      for (let i = 0; i < 4; i++) {
        const asked = await h2cRequest(port, '/limited', {
          method: 'OPTIONS',
          headers: { ...origin, 'access-control-request-method': 'POST' },
        });
        expect(`preflight ${i}: ${asked.status}`).toBe(`preflight ${i}: 204`);
        expect(corsOf(asked)).toEqual(readable);
      }

      const forbidden = await h2cRequest(port, '/limited', { method: 'POST', headers: origin });
      expect(forbidden.status).toBe(403);
      expect(JSON.parse(forbidden.text).code).toBe('CSRF_TOKEN_MISMATCH');
      expect(corsOf(forbidden)).toEqual(readable);
      expect(forbidden.headers['x-content-type-options']).toBe('nosniff');

      const served = await h2cRequest(port, '/limited', { headers: origin });
      expect(served.status).toBe(200);
      expect((await h2cRequest(port, '/limited', { headers: origin })).status).toBe(200);
      const refused = await h2cRequest(port, '/limited', { headers: origin });
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('60');
      expect(corsOf(refused)).toEqual(corsOf(served));
      expect(corsOf(refused)).toEqual(readable);
      expect(refused.headers['x-content-type-options']).toBe('nosniff');

      // An origin the application does not allow is named none
      const foreign = await h2cRequest(port, '/limited', {
        headers: { origin: 'https://evil.example' },
      });
      expect(foreign.status).toBe(429);
      expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('keeps serving static files and ranges from memory, joined to compression', async () => {
      const publicDir = path.join(dir, 'public');
      fs.mkdirSync(publicDir, { recursive: true });
      // Over the size the Node server starts streaming static files at
      const script = Buffer.from(`// ${'a compressible line of script\n'.repeat(30000)}`);
      fs.writeFileSync(path.join(publicDir, 'app.js'), script);
      fs.writeFileSync(path.join(publicDir, 'data.bin'), large);

      const port = await bootWith(async a => {
        await a.use(middleware.compression());
        await a.use(middleware.staticFiles({ root: publicDir }));
        await a.use(middleware.range({ maxRanges: 4 }));
        a.get('/ranged', (_req: any, res: any) => res.sendRange(largePath));
      });

      const compressed = await h2cRequest(port, '/app.js', {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(compressed.status).toBe(200);
      expect(compressed.headers['content-encoding']).toBe('gzip');
      expect(zlib.gunzipSync(compressed.body).equals(script)).toBe(true);

      const binary = await h2cRequest(port, '/data.bin');
      expect(binary.status).toBe(200);
      expect(binary.body.equals(large)).toBe(true);

      const single = await h2cRequest(port, '/ranged', { headers: { range: 'bytes=10-19' } });
      expect(single.status).toBe(206);
      expect(single.headers['content-range']).toBe(`bytes 10-19/${large.length}`);
      expect(single.body.equals(large.subarray(10, 20))).toBe(true);

      const multi = await h2cRequest(port, '/ranged', {
        headers: { range: 'bytes=0-4,100-104' },
      });
      expect(multi.status).toBe(206);
      expect(String(multi.headers['content-type'])).toContain('multipart/byteranges');
      expect(multi.headers['content-length']).toBe(String(multi.body.length));
      expect(multi.body.includes(large.subarray(100, 105))).toBe(true);
    });
  });

  describe('TLS (h2 via ALPN)', () => {
    it('negotiates h2 and answers over the same unified ssl config', async () => {
      const port = createTestPort();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node', http2: true, ssl: inlineSSL() },
      });
      expect(app.engine.server).toBe('http2');
      registerRoutes(app);
      await listen(app, port);

      expect(app.engine.protocols).toEqual(['h2']);

      const res = await h2Request(port, '/sum?a=20&b=22');
      expect(res.alpnProtocol).toBe('h2');
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ sum: 42 });

      const text = await h2Request(port, '/text');
      expect(String(text.headers['content-type'])).toContain('text/plain');
      expect(text.text).toBe('55');
    });

    it('refuses an HTTP/1.1 client with a 505 instead of leaving it unanswered', async () => {
      const port = createTestPort();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node', http2: true, ssl: inlineSSL() },
      });
      let handled = 0;
      app.get('/ok', () => {
        handled++;
        return { ok: true };
      });
      await listen(app, port);

      // A client that offers only http/1.1 in ALPN, as curl --http1.1 does
      const reply = await new Promise<{ alpn: string | false; text: string; closed: boolean }>(
        resolve => {
          const socket = tls.connect({
            host: '127.0.0.1',
            port,
            servername: 'localhost',
            ca: testCA(),
            ALPNProtocols: ['http/1.1'],
          });
          let text = '';
          let alpn: string | false = false;
          const finish = (closed: boolean) => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ alpn, text, closed });
          };
          const timer = setTimeout(() => finish(false), 3000);
          socket.on('secureConnect', () => {
            alpn = socket.alpnProtocol;
            socket.write('GET /ok HTTP/1.1\r\nHost: localhost\r\n\r\n');
          });
          socket.on('data', d => (text += d.toString()));
          socket.on('error', () => finish(true));
          socket.on('close', () => finish(true));
        }
      );

      expect(reply.alpn).toBe('http/1.1');
      expect(reply.text).toMatch(/^HTTP\/1\.1 505 /);
      expect(reply.text).toMatch(/connection: close/i);
      expect(reply.text).toContain('HTTP/2');
      expect(reply.closed).toBe(true);
      // The application is not served over HTTP/1.1
      expect(handled).toBe(0);

      // HTTP/2 clients are served as before, each stream handled once
      const res = await h2Request(port, '/ok');
      expect(res.alpnProtocol).toBe('h2');
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(handled).toBe(1);
      const server = (app as any).coreFramework.httpServer.getServer();
      expect(server.listenerCount('stream')).toBe(1);
    });
  });
});
