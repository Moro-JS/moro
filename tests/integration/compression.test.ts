// Integration Tests - compression middleware.
//
// Covers correctness (large responses compress and still decode, small responses are
// left alone, status codes survive) and a regression guard for the async-gzip vs
// not-found race: a middleware that serves a response synchronously (like the Swagger
// docs page) must not be 404'd while compression is still gzipping in the background.
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import * as http from 'http';
import * as zlib from 'zlib';
import { createApp } from '../../src/index.js';
import { compression } from '../../src/core/middleware/built-in/compression/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { createTestPort, delay, closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

describe('compression middleware', () => {
  let app: any;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    // Disable the framework's auto-injected compression so the explicit middleware below
    // is the only one active (avoids double-compression in the assertions).
    app = await createApp({
      logger: { level: 'error' },
      performance: { compression: { enabled: false } },
    } as any);
    port = createTestPort();
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await closeApp(app);
    await delay(100);
  });

  const listen = () =>
    new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

  it('compresses large responses and the body still decodes correctly', async () => {
    await app.use(compression({ threshold: 100 }));
    app.get('/big', () => ({ items: Array.from({ length: 300 }, (_, i) => ({ id: i })) }));
    await listen();
    await delay(100);

    const res = await request(baseUrl).get('/big').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    // supertest transparently gunzips — the decoded JSON must be intact.
    expect(res.body.items).toHaveLength(300);
    expect(res.body.items[0]).toEqual({ id: 0 });
  });

  it('attaches to a single route through .before() (the documented per-route form)', async () => {
    const big = () => ({ items: Array.from({ length: 300 }, (_, i) => ({ id: i })) });
    app
      .get('/per-route')
      .before(compression({ threshold: 100 }))
      .handler(big);
    app.get('/plain').handler(big);
    await listen();
    await delay(100);

    const zipped = await request(baseUrl)
      .get('/per-route')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.body.items).toHaveLength(300);

    const plain = await request(baseUrl).get('/plain').set('Accept-Encoding', 'gzip').expect(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.items).toHaveLength(300);
  });

  it('leaves responses below the threshold uncompressed', async () => {
    await app.use(compression({ threshold: 1024 }));
    app.get('/small', () => ({ ok: true }));
    await listen();
    await delay(100);

    const res = await request(baseUrl).get('/small').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.ok).toBe(true);
  });

  it('preserves the response status code through compression', async () => {
    await app.use(compression({ threshold: 100 }));
    app.post('/create', (_req: any, res: any) => {
      res.status(201);
      return { created: true, blob: 'y'.repeat(2000) };
    });
    await listen();
    await delay(100);

    const res = await request(baseUrl).post('/create').set('Accept-Encoding', 'gzip').expect(201);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.created).toBe(true);
  });

  it('compresses a small body inline, with a Content-Length and no chunked framing', async () => {
    await app.use(compression({ threshold: 100 }));
    app.get('/inline', () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })) }));
    await listen();
    await delay(100);

    const res = await request(baseUrl).get('/inline').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/);
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(res.body.items).toHaveLength(50);
  });

  it('compresses a small brotli body inline and it decodes to the same bytes', async () => {
    await app.use(compression({ threshold: 100, encodings: ['br'] }));
    const payload = { text: 'brotli '.repeat(400) };
    app.get('/inline-br', () => payload);
    await listen();
    await delay(100);

    // Read the socket directly: superagent decodes and rewrites the headers of a
    // compressed response, which is exactly what this test needs to see raw.
    const http = await import('node:http');
    const zlib = await import('node:zlib');
    const raw = await new Promise<{ headers: any; body: Buffer }>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port, path: '/inline-br', headers: { 'accept-encoding': 'br' } },
          res => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          }
        )
        .on('error', reject);
    });
    expect(raw.headers['content-encoding']).toBe('br');
    expect(raw.headers['transfer-encoding']).toBeUndefined();
    expect(Number(raw.headers['content-length'])).toBe(raw.body.length);
    expect(JSON.parse(zlib.brotliDecompressSync(raw.body).toString('utf8'))).toEqual(payload);
  });

  it('streams a body above maxInlineBytes through the threadpool, still compressed', async () => {
    await app.use(compression({ threshold: 100, maxInlineBytes: 1024 }));
    app.get('/streamed', () => ({ items: Array.from({ length: 300 }, (_, i) => ({ id: i })) }));
    await listen();
    await delay(100);

    const res = await request(baseUrl).get('/streamed').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.items).toHaveLength(300);
  });

  it('sends every body through the threadpool when maxInlineBytes is 0', async () => {
    await app.use(compression({ threshold: 100, maxInlineBytes: 0 }));
    app.get('/pooled', () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })) }));
    await listen();
    await delay(100);

    const res = await request(baseUrl).get('/pooled').set('Accept-Encoding', 'gzip').expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.items).toHaveLength(50);
  });

  it('serves a middleware response under compression without a not-found race', async () => {
    // A middleware that serves a large response synchronously then stops the chain (no
    // next()) — exactly how the Swagger docs middleware behaves. Compression gzips
    // res.send asynchronously, so the response headers must be committed synchronously;
    // otherwise headersSent is still false when the request falls through and the
    // "no route matched" fallback 404s it before the gzip lands.
    await app.use(compression({ threshold: 100 }));
    await app.use((req: any, res: any, next: any) => {
      if (req.path === '/served-by-mw') {
        res.setHeader('Content-Type', 'text/html');
        res.send('<html><body>' + 'x'.repeat(5000) + '</body></html>');
        return;
      }
      next();
    });
    await listen();
    await delay(100);

    const res = await request(baseUrl)
      .get('/served-by-mw')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.text).toContain('<html><body>');
  });
});

// A handler that sends a body it has already encoded (and says so with
// Content-Encoding) must have it delivered as is: encoding it a second time
// would leave the client unable to decode it. Same outcome on both servers.
function alreadyEncodedSuite(engine: 'node' | 'moro') {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('does not compress a body that already carries a Content-Encoding', async () => {
    const original = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i })) });
    const precompressed = zlib.gzipSync(original);

    // Configuration is cached per process: start from a clean one, or the
    // server asked for here is not the one that boots
    resetConfig();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine },
      performance: { compression: { enabled: false } },
    } as any);
    await app.use(compression({ threshold: 100 }));
    app.get('/precompressed', (_req: any, res: any) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Encoding', 'gzip');
      res.send(precompressed);
    });
    app.get('/plain', () => ({ text: 'x'.repeat(5000) }));
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));
    expect(app.engine?.server).toBe(engine === 'node' ? 'node' : 'engine');

    // Raw requests: the bytes on the wire, not what a client decodes them to
    const get = (path: string) =>
      new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        http
          .get(
            { host: '127.0.0.1', port, path, headers: { 'accept-encoding': 'br, gzip' } },
            res => {
              const chunks: Buffer[] = [];
              res.on('data', chunk => chunks.push(chunk));
              res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            }
          )
          .on('error', reject);
      });

    const raw = await get('/precompressed');
    expect(raw.headers['content-encoding']).toBe('gzip');
    expect(raw.body.equals(precompressed)).toBe(true);
    expect(zlib.gunzipSync(raw.body).toString()).toBe(original);

    // and the middleware is active: a body without an encoding is compressed
    expect((await get('/plain')).headers['content-encoding']).toBe('br');
  });
}

describe('compression of an already encoded body (Node http server)', () =>
  alreadyEncodedSuite('node'));
describeEngine('compression of an already encoded body (native engine)', () =>
  alreadyEncodedSuite('moro')
);

describe('compression and a 204 answered through res.json() (Node http server)', () => {
  let app: any;

  afterEach(async () => {
    await closeApp(app);
    resetConfig();
    await delay(100);
  });

  it('declares no Content-Length', async () => {
    resetConfig();
    app = await createApp({
      logger: { level: 'error' },
      server: { engine: 'node' },
      performance: { compression: { enabled: true } },
    } as any);
    app.delete('/item', (_req: any, res: any) => {
      res.status(204).json({ gone: true });
    });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));
    await delay(100);

    const seen = await new Promise<{ status: number; length: string | undefined }>(
      (resolve, reject) => {
        const req = http.request(
          {
            port,
            path: '/item',
            method: 'DELETE',
            headers: { 'Accept-Encoding': 'gzip' },
          },
          res => {
            res.resume();
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, length: res.headers['content-length'] })
            );
          }
        );
        req.on('error', reject);
        req.end();
      }
    );
    expect(seen.status).toBe(204);
    expect(seen.length).toBeUndefined();
  });
});
