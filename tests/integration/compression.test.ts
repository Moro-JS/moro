// Integration Tests - compression middleware.
//
// Covers correctness (large responses compress and still decode, small responses are
// left alone, status codes survive) and a regression guard for the async-gzip vs
// not-found race: a middleware that serves a response synchronously (like the Swagger
// docs page) must not be 404'd while compression is still gzipping in the background.
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/index.js';
import { compression } from '../../src/core/middleware/built-in/compression/index.js';
import { createTestPort, delay, closeApp } from '../setup.js';

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
