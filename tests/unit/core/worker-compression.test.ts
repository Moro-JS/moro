import { describe, it, expect } from '@jest/globals';
import * as zlib from 'zlib';
import { handleDataCompress, handleDataDecompress } from '../../../src/core/workers/worker.js';

// Direct handler tests (no thread spawning — the worker entry is stubbed
// under jest). Real on-thread execution is covered by the dist smoke script.
describe('Worker compression handlers', () => {
  const payload = 'moro '.repeat(1000);

  it.each(['gzip', 'deflate', 'brotli'] as const)('round-trips %s', async format => {
    const compressed = await handleDataCompress({ input: payload, format });
    expect(compressed.length).toBeLessThan(Buffer.byteLength(payload));

    const decompressed = await handleDataDecompress({ input: compressed, format });
    expect(decompressed.toString('utf8')).toBe(payload);
  });

  it('defaults to gzip', async () => {
    const compressed = await handleDataCompress({ input: payload });
    // gzip magic bytes
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
    expect(zlib.gunzipSync(compressed).toString('utf8')).toBe(payload);
  });

  it('accepts Buffer and Uint8Array input', async () => {
    const fromBuffer = await handleDataCompress({ input: Buffer.from(payload) });
    const fromUint8 = await handleDataCompress({
      input: new Uint8Array(Buffer.from(payload)),
    });
    expect(zlib.gunzipSync(fromBuffer).toString('utf8')).toBe(payload);
    expect(zlib.gunzipSync(fromUint8).toString('utf8')).toBe(payload);
  });

  it('rejects unknown formats', async () => {
    await expect(handleDataCompress({ input: payload, format: 'zip' as any })).rejects.toThrow(
      /Unknown compression format/
    );
  });
});
