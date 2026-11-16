// Integration - middleware.range() over real HTTP, on every available backend.
// The request set is the reproduction from GitHub issue #36 (suffix ranges and
// last-pos clamping) plus the failure modes found alongside it: a malformed
// Range header, a missing file, and a multipart answer.
//
// UnifiedRouter is a process-wide singleton, so the backends are exercised one
// at a time (reset + create + listen + collect + close), never side by side.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createApp, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';

interface Result {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const get = (port: number, urlPath: string, headers: Record<string, string> = {}) =>
  new Promise<Result>((resolve, reject) => {
    http
      .get({ port, path: urlPath, headers, agent: false }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('latin1'),
          })
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });

const BACKENDS: Array<{ id: 'node' | 'moro'; label: string; available: boolean }> = [
  { id: 'node', label: 'node http', available: true },
  { id: 'moro', label: '@morojs/engine', available: engineLoadable },
];

describe('middleware.range() over HTTP', () => {
  let dir: string;
  let sample: string;

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moro-range-http-')));
    sample = path.join(dir, 'sample.bin');
    await fs.writeFile(sample, 'a'.repeat(990) + '0123456789');
    await fs.mkdir(path.join(dir, 'served'));
    await fs.writeFile(path.join(dir, 'served', 'clip.bin'), 'a'.repeat(990) + '0123456789');
    await fs.writeFile(path.join(dir, 'secret.bin'), 'TOP-SECRET');
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const backend of BACKENDS) {
    const describeBackend = backend.available ? describe : describe.skip;

    describeBackend(backend.label, () => {
      let app: any;
      let port: number;

      beforeAll(async () => {
        resetConfig();
        UnifiedRouter.reset();
        app = await createApp({
          logger: { level: 'fatal' },
          server: { engine: backend.id },
        } as any);
        app.use(middleware.range({ maxRanges: 3 }));
        app.get('/file', async (_req: any, res: any) => {
          res.setHeader('Content-Type', 'application/octet-stream');
          await res.sendRange(sample);
        });
        app.get('/missing', async (_req: any, res: any) => {
          await res.sendRange(path.join(dir, 'nope.bin'));
        });
        // Confined to `served/` - the param goes in as the client sent it
        app.get('/served/:file', async (req: any, res: any) => {
          await res.sendRange(req.params.file, { root: path.join(dir, 'served') });
        });
        port = createTestPort();
        await new Promise<void>(resolve => app.listen(port, () => resolve()));
      });

      afterAll(async () => {
        await closeApp(app);
      });

      it('sends the whole file without a Range header', async () => {
        const res = await get(port, '/file');
        expect(res.status).toBe(200);
        expect(res.headers['accept-ranges']).toBe('bytes');
        expect(res.headers['content-length']).toBe('1000');
        expect(res.body.length).toBe(1000);
      });

      it.each([
        ['bytes=-10', 'bytes 990-999/1000', '0123456789'],
        ['bytes=995-2000', 'bytes 995-999/1000', '56789'],
        ['bytes=990-994', 'bytes 990-994/1000', '01234'],
      ])('%s -> 206 %s', async (range, contentRange, body) => {
        const res = await get(port, '/file', { range });
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe(contentRange);
        expect(res.headers['content-length']).toBe(String(body.length));
        expect(res.body).toBe(body);
      });

      it.each(['bytes=-2000', 'bytes=0-1000'])('%s -> the whole file as a 206', async range => {
        const res = await get(port, '/file', { range });
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 0-999/1000');
        expect(res.body.length).toBe(1000);
      });

      it('answers 416 for a range past the end', async () => {
        const res = await get(port, '/file', { range: 'bytes=1000-' });
        expect(res.status).toBe(416);
        expect(res.headers['content-range']).toBe('bytes */1000');
      });

      it('ignores a malformed Range header instead of failing', async () => {
        const res = await get(port, '/file', { range: 'bytes=abc-def' });
        expect(res.status).toBe(200);
        expect(res.headers['content-range']).toBeUndefined();
        expect(res.body.length).toBe(1000);
      });

      it('answers multipart/byteranges for several ranges', async () => {
        const res = await get(port, '/file', { range: 'bytes=0-1,-3' });
        expect(res.status).toBe(206);
        const contentType = String(res.headers['content-type']);
        expect(contentType).toMatch(/^multipart\/byteranges; boundary=[0-9a-f]{24}$/);
        const boundary = contentType.split('boundary=')[1];
        expect(res.headers['content-length']).toBe(String(res.body.length));
        expect(res.body).toBe(
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n` +
            `Content-Range: bytes 0-1/1000\r\n\r\naa\r\n` +
            `--${boundary}\r\nContent-Type: application/octet-stream\r\n` +
            `Content-Range: bytes 997-999/1000\r\n\r\n789\r\n` +
            `--${boundary}--\r\n`
        );
      });

      it('answers 404 for a missing file without naming the path', async () => {
        const res = await get(port, '/missing', { range: 'bytes=0-9' });
        expect(res.status).toBe(404);
        expect(res.body).not.toContain(dir);
        expect(JSON.parse(res.body)).toEqual({ success: false, error: 'File not found' });
      });

      it('serves a file below the root', async () => {
        const res = await get(port, '/served/clip.bin', { range: 'bytes=-10' });
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 990-999/1000');
        expect(res.body).toBe('0123456789');
      });

      // Route params arrive percent-decoded, so `..%2F` is `../` in the handler
      it.each([
        '/served/..%2Fsecret.bin',
        '/served/%2E%2E%2Fsecret.bin',
        '/served/..%5Csecret.bin',
      ])('refuses %s with root set', async urlPath => {
        const res = await get(port, urlPath);
        expect(res.status).toBe(404);
        expect(res.body).not.toContain('TOP-SECRET');
      });

      it('keeps serving after the failures above', async () => {
        const res = await get(port, '/file', { range: 'bytes=0-0' });
        expect(res.status).toBe(206);
        expect(res.body).toBe('a');
      });
    });
  }
});
