// @ts-nocheck
// Unit Tests - the compression middleware on the native engine.
//
// On the engine the middleware hands its settings to the response
// (_useCompression) and the reply goes through the server's own buffered
// compression: json/send keep their prototype shapes, the body goes out
// encoded when the client accepts an encoding and as it is otherwise. A
// custom filter keeps the wrapping path, as every other server does.
import { describe, it, expect } from '@jest/globals';
import * as zlib from 'zlib';
import { MoroEngineServer, EngineResponse } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine, foldFlat } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';
import { createCompressionMiddleware } from '../../../src/core/middleware/built-in/compression/middleware.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const big = {
  items: Array.from({ length: 80 }, (_, i) => ({
    id: i,
    name: `Item ${i}`,
    tags: ['sale', 'popular'],
    rating: { score: (i * 7) % 50, count: i * 3 },
  })),
};
const bigJson = JSON.stringify(big);

// One request through `middleware` then `handler`; the ops the engine saw.
async function run(middleware, handler, simulate = {}) {
  const engine = createFakeEngine();
  const server = new MoroEngineServer({
    engineModule: engine,
    capabilities: getEngineCapabilities(engine),
  });
  server.setRouterHandler((req, res) => {
    middleware(req, res, () => handler(req, res));
    return true;
  });
  const reqId = engine.simulate(simulate);
  await tick();
  await tick();
  return engine.requests.get(reqId).ops;
}

function respondOp(ops) {
  const terminal = ops.filter(op => op.type === 'respond');
  expect(terminal).toHaveLength(1);
  const op = terminal[0];
  return { ...op, headers: foldFlat(op.headersFlat) };
}

describe('compression middleware on the engine', () => {
  it('hands its settings to the response: json goes out gzip-encoded with json/send untouched', async () => {
    const mw = createCompressionMiddleware({ encodings: ['gzip'], level: 3 });
    let shapes;
    const ops = await run(
      mw,
      (req, res) => {
        shapes = [
          res.json === EngineResponse.prototype.json,
          res.send === EngineResponse.prototype.send,
        ];
        res.json(big);
      },
      { path: '/json', headers: { 'accept-encoding': 'gzip, br' } }
    );
    expect(shapes).toEqual([true, true]);
    const op = respondOp(ops);
    expect(op.status).toBe(200);
    expect(op.headers['content-type']).toEqual(['application/json']);
    expect(op.headers['content-encoding']).toEqual(['gzip']);
    expect(op.headers['vary']).toEqual(['Accept-Encoding']);
    expect(Buffer.isBuffer(op.body)).toBe(true);
    expect(zlib.gunzipSync(op.body).toString()).toBe(bigJson);
  });

  it('takes the brotli options as they are', async () => {
    const q = zlib.constants.BROTLI_PARAM_QUALITY;
    const mw = createCompressionMiddleware({ encodings: ['br'], brotli: { params: { [q]: 3 } } });
    const ops = await run(mw, (_req, res) => res.json(big), {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toEqual(['br']);
    expect(zlib.brotliDecompressSync(op.body).toString()).toBe(bigJson);
    // Quality 3 reached the encoder: the one-call API at quality 3 lands
    // within the window field of the stream header (the kept encoder runs a
    // 256 KiB window, the one-call fallback on an older Node a fitted one).
    const input = Buffer.from(bigJson);
    const once = zlib.brotliCompressSync(input, {
      params: { [q]: 3, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length },
    });
    expect(Math.abs(op.body.length - once.length)).toBeLessThanOrEqual(2);
    const q11 = zlib.brotliCompressSync(input, { params: { [q]: 11 } });
    expect(op.body.length).toBeGreaterThan(q11.length);
  });

  it('sends the body as it is when the client accepts no encoding', async () => {
    const mw = createCompressionMiddleware({ encodings: ['gzip'] });
    const ops = await run(mw, (_req, res) => res.json(big), { headers: {} });
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toBeUndefined();
    expect(op.headers['content-type']).toEqual(['application/json']);
    expect(String(op.body)).toBe(bigJson);
  });

  it('sends a body under the threshold as it is', async () => {
    const mw = createCompressionMiddleware({ encodings: ['gzip'], threshold: 1024 });
    const ops = await run(mw, (_req, res) => res.json({ ok: true }), {
      headers: { 'accept-encoding': 'gzip' },
    });
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toBeUndefined();
    expect(String(op.body)).toBe('{"ok":true}');
  });

  it('send() of text takes the same path', async () => {
    const mw = createCompressionMiddleware({ encodings: ['gzip'] });
    const text = 'moro '.repeat(600);
    const ops = await run(mw, (_req, res) => res.send(text), {
      headers: { 'accept-encoding': 'gzip' },
    });
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toEqual(['gzip']);
    expect(op.headers['content-type']?.[0]).toMatch(/^text\/plain/);
    expect(zlib.gunzipSync(op.body).toString()).toBe(text);
  });

  it('leaves a Buffer body alone: octet-stream is not compressible', async () => {
    const mw = createCompressionMiddleware({ encodings: ['gzip'] });
    const bytes = Buffer.alloc(4096, 7);
    const ops = await run(mw, (_req, res) => res.send(bytes), {
      headers: { 'accept-encoding': 'gzip' },
    });
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toBeUndefined();
    expect(Buffer.from(op.body).equals(bytes)).toBe(true);
  });

  it('a filter keeps the wrapping path', async () => {
    const mw = createCompressionMiddleware({ encodings: ['gzip'], filter: () => true });
    let wrapped;
    const ops = await run(
      mw,
      (_req, res) => {
        wrapped = res.json !== EngineResponse.prototype.json;
        res.json(big);
      },
      { headers: { 'accept-encoding': 'gzip' } }
    );
    expect(wrapped).toBe(true);
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toEqual(['gzip']);
    expect(zlib.gunzipSync(op.body).toString()).toBe(bigJson);
  });

  it('a response without the middleware is not compressed', async () => {
    const pass = (_req, _res, next) => next();
    const ops = await run(pass, (_req, res) => res.json(big), {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    const op = respondOp(ops);
    expect(op.headers['content-encoding']).toBeUndefined();
    expect(String(op.body)).toBe(bigJson);
  });
});
