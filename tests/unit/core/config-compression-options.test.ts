// The encoder options under performance.compression survive validation: the
// types declare gzip, brotli and reuseEncoders, and the servers read them
// from the resolved config.
import { describe, it, expect, beforeEach } from '@jest/globals';
import * as zlib from 'zlib';
import { loadConfigWithOptions, resetConfig } from '../../../src/core/config/index.js';

describe('performance.compression encoder options', () => {
  beforeEach(() => resetConfig());

  it('keeps gzip, brotli and reuseEncoders', () => {
    const q = zlib.constants.BROTLI_PARAM_QUALITY;
    const config = loadConfigWithOptions({
      performance: {
        compression: {
          enabled: true,
          level: 3,
          threshold: 512,
          encodings: ['br', 'gzip'],
          gzip: { level: 3 },
          brotli: { params: { [q]: 3 } },
          reuseEncoders: false,
        },
      },
    } as any);
    const c = config.performance.compression;
    expect(c.enabled).toBe(true);
    expect(c.level).toBe(3);
    expect(c.threshold).toBe(512);
    expect(c.encodings).toEqual(['br', 'gzip']);
    expect(c.gzip).toEqual({ level: 3 });
    expect(c.brotli).toEqual({ params: { [q]: 3 } });
    expect(c.reuseEncoders).toBe(false);
  });

  it('leaves them out when not given', () => {
    const config = loadConfigWithOptions({
      performance: { compression: { enabled: true, level: 6, threshold: 1024 } },
    } as any);
    const c = config.performance.compression;
    expect(c.gzip).toBeUndefined();
    expect(c.brotli).toBeUndefined();
    expect(c.reuseEncoders).toBeUndefined();
  });

  it('rejects a non-object encoder option', () => {
    expect(() =>
      loadConfigWithOptions({
        performance: { compression: { enabled: true, level: 6, threshold: 1024, brotli: 3 } },
      } as any)
    ).toThrow(/brotli/);
  });
});
