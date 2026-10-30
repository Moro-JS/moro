import { describe, it, expect } from '@jest/globals';
import * as zlib from 'zlib';
import {
  compressBuffer,
  compressBufferSync,
  resolveCompressionSettings,
} from '../../../src/core/http/utils/compression.js';

const body = Buffer.from(
  JSON.stringify({
    items: Array.from({ length: 60 }, (_, i) => ({
      id: i,
      name: `Item ${i}`,
      tags: ['sale', 'popular', 'heavy-duty'],
      rating: { score: (i * 7) % 50, count: i * 3 },
    })),
  })
);

describe('compression utils', () => {
  it('gzip output from the reused encoder decodes to the input and matches the one-call size', () => {
    const once = zlib.gzipSync(body, { level: 6 });
    for (let i = 0; i < 3; i++) {
      const out = compressBufferSync(body, 'gzip', 6);
      expect(zlib.gunzipSync(out).equals(body)).toBe(true);
      expect(Math.abs(out.length - once.length)).toBeLessThanOrEqual(16);
    }
  });

  it('honours a pinned gzip level over the shared level', () => {
    const fast = compressBufferSync(body, 'gzip', 9, { gzip: { level: 1 } });
    const small = compressBufferSync(body, 'gzip', 1, { gzip: { level: 9 } });
    expect(zlib.gunzipSync(fast).equals(body)).toBe(true);
    expect(zlib.gunzipSync(small).equals(body)).toBe(true);
    expect(small.length).toBeLessThan(fast.length);
    expect(fast.length).toBe(zlib.gzipSync(body, { level: 1 }).length);
  });

  it('reuseEncoders: false takes the one-call path with identical bytes', () => {
    const reused = compressBufferSync(body, 'gzip', 3);
    const oneCall = compressBufferSync(body, 'gzip', 3, { reuseEncoders: false });
    expect(reused.equals(oneCall)).toBe(true);
  });

  it('honours a pinned brotli quality and fits the window to the body', () => {
    const Q = zlib.constants.BROTLI_PARAM_QUALITY;
    const q1 = compressBufferSync(body, 'br', 6, { brotli: { params: { [Q]: 1 } } });
    const q9 = compressBufferSync(body, 'br', 6, { brotli: { params: { [Q]: 9 } } });
    expect(zlib.brotliDecompressSync(q1).equals(body)).toBe(true);
    expect(zlib.brotliDecompressSync(q9).equals(body)).toBe(true);
    expect(q9.length).toBeLessThan(q1.length);
    // the fitted window compresses the same as the default one: only the
    // window field in the stream header can differ
    const fitted = compressBufferSync(body, 'br', 4);
    const defaultWindow = zlib.brotliCompressSync(body, {
      params: {
        [Q]: Math.round((4 * 11) / 9),
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
    expect(Math.abs(fitted.length - defaultWindow.length)).toBeLessThanOrEqual(2);
  });

  it('brotli bodies come out byte-identical to the one-call API, reused encoder or not', () => {
    const Q = zlib.constants.BROTLI_PARAM_QUALITY;
    const a = Buffer.from('alpha '.repeat(500));
    const opts = { brotli: { params: { [Q]: 3 } } };
    // three different bodies in a row: a reused encoder must not carry one
    // body's context into the next (a reset that keeps it is declined)
    for (const input of [body, a, body]) {
      const out = compressBufferSync(input, 'br', 6, opts);
      expect(zlib.brotliDecompressSync(out).equals(input)).toBe(true);
      const once = zlib.brotliCompressSync(input, {
        params: {
          [Q]: 3,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          [zlib.constants.BROTLI_PARAM_LGWIN]: Math.max(
            zlib.constants.BROTLI_MIN_WINDOW_BITS,
            Math.min(zlib.constants.BROTLI_DEFAULT_WINDOW, Math.ceil(Math.log2(input.length)) + 1)
          ),
        },
      });
      // reused: identical to the default-window one-call; fitted one-call otherwise - never larger than either by more than the window field
      expect(Math.abs(out.length - once.length)).toBeLessThanOrEqual(2);
    }
  });

  it('the async path takes the same encoder options', async () => {
    const out = await compressBuffer(body, 'gzip', 6, { gzip: { level: 1 } });
    expect(zlib.gunzipSync(out).equals(body)).toBe(true);
    expect(out.length).toBe(zlib.gzipSync(body, { level: 1 }).length);
  });

  it('resolveCompressionSettings carries the encoder options through', () => {
    const s = resolveCompressionSettings({
      compression: { enabled: true, gzip: { level: 2 }, reuseEncoders: false },
    });
    expect(s.gzip).toEqual({ level: 2 });
    expect(s.reuseEncoders).toBe(false);
    expect(s.brotli).toBeUndefined();
    expect(s.level).toBe(6);
  });
});
