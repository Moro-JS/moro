// @ts-nocheck
// Integration - MoroHttp2Server answers real HTTP/2 clients, cleartext
// (prior knowledge, what h2load and `curl --http2-prior-knowledge` speak) and
// over TLS with ALPN. Until 1.8.15 no test drove this server with an h2 client:
// it advertised SETTINGS_ENABLE_PUSH=1, which RFC 9113 §6.5.2 forbids a server
// to send, and nghttp2-based clients (curl, Node, browsers) answered with a
// connection-level PROTOCOL_ERROR before any response could be read. A request
// completing at all is therefore the assertion these tests exist for.
import { describe, it, expect, afterEach } from '@jest/globals';
import * as http2 from 'http2';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { h2Request, fixture } from '../utils/tls-client.js';

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
      resolve({ status, headers, text: Buffer.concat(chunks).toString('utf8') });
    });
    if (options.body !== undefined) req.end(options.body);
    else req.end();
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

      const res = await h2Request(port, '/sum?a=20&b=22');
      expect(res.alpnProtocol).toBe('h2');
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ sum: 42 });

      const text = await h2Request(port, '/text');
      expect(String(text.headers['content-type'])).toContain('text/plain');
      expect(text.text).toBe('55');
    });
  });
});
