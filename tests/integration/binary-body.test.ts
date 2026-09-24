// @ts-nocheck
// Integration - binary request bodies reach the handler byte-exact as a
// Buffer (Content-Length and chunked), while text bodies remain strings.
// Runs on the Node http server (always) and the native engine (when built);
// the uWS backend shares the same classifier and self-skips here.
import { describe, it, expect, afterEach } from '@jest/globals';
import * as http from 'http';
import * as crypto from 'crypto';
import { createApp, raw, text } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

function post(
  port: number,
  path: string,
  body: Buffer | string,
  headers: Record<string, string>,
  chunked = false
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { ...headers };
    if (!chunked) h['Content-Length'] = String(Buffer.byteLength(body));
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: h }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers })
      );
    });
    req.on('error', reject);
    if (chunked && Buffer.isBuffer(body) && body.length > 1) {
      // Two writes so the wire carries more than one chunk
      const mid = Math.floor(body.length / 2);
      req.write(body.subarray(0, mid));
      req.write(body.subarray(mid));
      req.end();
    } else {
      req.end(body);
    }
  });
}

function registerRoutes(app: any) {
  app.post('/echo').handler((req: any, res: any) => {
    const b = req.body;
    res.setHeader('X-Body-Type', Buffer.isBuffer(b) ? 'buffer' : typeof b);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? '')));
  });
  // Webhook-style HMAC over the wire bytes of a JSON body
  app.post('/signed').handler((req: any) => {
    const raw = req.rawBody;
    const mac = crypto
      .createHmac('sha256', 'secret')
      .update(raw ?? Buffer.alloc(0))
      .digest('hex');
    return { parsed: req.body, rawLength: raw ? raw.length : null, mac };
  });
  app
    .post('/raw-parser')
    .before(raw({ type: 'text/plain' }))
    .handler((req: any, res: any) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Body-Type', Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body);
      res.send(req.body);
    });
  app
    .post('/text-parser')
    .before(text({ type: 'application/octet-stream' }))
    .handler((req: any, res: any) => {
      res.setHeader('X-Body-Type', Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body);
      res.send(String(req.body));
    });
}

function suite(engine: 'node' | 'moro') {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const boot = async () => {
    const port = createTestPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    registerRoutes(app);
    await listen(app, port);
    return port;
  };

  for (const size of [1, 1024, 10 * 1024, 100 * 1024]) {
    for (const chunked of [false, true]) {
      it(`echoes ${size} random bytes byte-exact (${chunked ? 'chunked' : 'Content-Length'})`, async () => {
        const port = await boot();
        const payload = crypto.randomBytes(size);
        const res = await post(
          port,
          '/echo',
          payload,
          { 'Content-Type': 'application/octet-stream' },
          chunked
        );
        expect(res.status).toBe(200);
        expect(res.headers['x-body-type']).toBe('buffer');
        expect(res.body.length).toBe(size);
        expect(Buffer.compare(res.body, payload)).toBe(0);
      });
    }
  }

  it('keeps image/* and application/pdf bodies as Buffers', async () => {
    const port = await boot();
    for (const ct of ['image/png', 'application/pdf']) {
      const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);
      const res = await post(port, '/echo', payload, { 'Content-Type': ct });
      expect(res.headers['x-body-type']).toBe('buffer');
      expect(Buffer.compare(res.body, payload)).toBe(0);
    }
  });

  it('still hands text bodies to the handler as strings', async () => {
    const port = await boot();
    for (const headers of [
      { 'Content-Type': 'text/plain' },
      { 'Content-Type': 'application/xml' },
      { 'Content-Type': 'application/vnd.api+json' },
      {},
    ]) {
      const res = await post(port, '/echo', 'héllo <x/>', headers);
      expect(res.status).toBe(200);
      expect(res.headers['x-body-type']).toBe('string');
      expect(res.body.toString('utf8')).toBe('héllo <x/>');
    }
  });

  it('req.rawBody carries the exact wire bytes of a parsed JSON body (HMAC use case)', async () => {
    const port = await boot();
    const wire = '{"amount": 10,   "note":"héllo"}'; // spacing survives only in the raw bytes
    const res = await post(port, '/signed', wire, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body.parsed).toEqual({ amount: 10, note: 'héllo' });
    expect(body.rawLength).toBe(Buffer.byteLength(wire));
    expect(body.mac).toBe(crypto.createHmac('sha256', 'secret').update(wire).digest('hex'));
  });

  it('raw() and text() parser idioms convert the body for their content types', async () => {
    const port = await boot();
    const asBuffer = await post(port, '/raw-parser', 'plain words', {
      'Content-Type': 'text/plain',
    });
    expect(asBuffer.headers['x-body-type']).toBe('buffer');
    expect(asBuffer.body.toString()).toBe('plain words');

    const asText = await post(port, '/text-parser', Buffer.from('bytes as text'), {
      'Content-Type': 'application/octet-stream',
    });
    expect(asText.headers['x-body-type']).toBe('string');
    expect(asText.body.toString()).toBe('bytes as text');
  });

  it('answers an empty binary POST with 200', async () => {
    const port = await boot();
    const res = await post(port, '/echo', Buffer.alloc(0), {
      'Content-Type': 'application/octet-stream',
    });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });
}

describe('binary request bodies on the Node http server', () => suite('node'));
describeEngine('binary request bodies on the native engine', () => suite('moro'));
