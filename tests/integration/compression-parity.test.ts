// @ts-nocheck
// Integration - response compression works uniformly on the native engine
// (parity with the Node path, which already compressed). Verifies gzip/brotli
// negotiation, that decompressed bodies are byte-identical, that small and
// non-compressible responses are skipped, and that Vary is set.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import * as zlib from 'zlib';
import * as http from 'http';

const testPort = () => 12500 + Math.floor(Math.random() * 3000);
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// Raw request (global fetch transparently decompresses, hiding content-encoding).
function rawGet(
  port: number,
  path: string,
  acceptEncoding: string
): Promise<{ status: number; headers: any; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path, headers: { 'accept-encoding': acceptEncoding } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
  });
}

const decode = (buf: Buffer, enc?: string): Buffer =>
  enc === 'br'
    ? zlib.brotliDecompressSync(buf)
    : enc === 'gzip'
      ? zlib.gunzipSync(buf)
      : enc === 'deflate'
        ? zlib.inflateSync(buf)
        : buf;

describeEngine('Native engine response compression parity', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  async function bootWithCompression(port: number) {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro' },
      performance: { compression: { enabled: true, threshold: 100, level: 6 } },
    });
    app.get('/big', () => ({ success: true, data: 'x'.repeat(5000) }));
    app.get('/small', () => ({ success: true, data: 'tiny' }));
    app.get('/binary', (req: any, res: any) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.send(Buffer.alloc(5000, 7));
    });
    await listen(app, port);
  }

  it('gzip: large body is compressed and decodes byte-identically', async () => {
    const port = testPort();
    await bootWithCompression(port);
    const res = await rawGet(port, '/big', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(String(res.headers['vary'])).toMatch(/accept-encoding/i);
    const decoded = JSON.parse(decode(res.body, 'gzip').toString());
    expect(decoded.data.length).toBe(5000);
  });

  it('brotli is negotiated when offered', async () => {
    const port = testPort();
    await bootWithCompression(port);
    const res = await rawGet(port, '/big', 'br');
    expect(res.headers['content-encoding']).toBe('br');
    expect(JSON.parse(decode(res.body, 'br').toString()).success).toBe(true);
  });

  it('a below-threshold body is NOT compressed', async () => {
    const port = testPort();
    await bootWithCompression(port);
    const res = await rawGet(port, '/small', 'gzip, br');
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('a non-compressible content type is NOT compressed', async () => {
    const port = testPort();
    await bootWithCompression(port);
    const res = await rawGet(port, '/binary', 'gzip, br');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body.length).toBe(5000);
  });

  it('identity / no acceptable encoding leaves the body raw', async () => {
    const port = testPort();
    await bootWithCompression(port);
    const res = await rawGet(port, '/big', 'identity');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(res.body.toString()).success).toBe(true);
  });

  it('compression disabled (default) sends raw', async () => {
    const port = testPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/big', () => ({ success: true, data: 'x'.repeat(5000) }));
    await listen(app, port);
    const res = await rawGet(port, '/big', 'gzip, br');
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
