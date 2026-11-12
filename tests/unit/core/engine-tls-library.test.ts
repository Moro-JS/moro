// server.ssl.library: which TLS library the native engine terminates TLS with
// (@morojs/engine 1.1.20 ships a binary with BoringSSL inside and one on
// Node's OpenSSL). The framework's part is small: carry the setting through
// validation, hand it to the engine before its binary is loaded, and report
// what the engine says it loaded - never fail a boot over it.
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { loadConfigWithOptions, resetConfig } from '../../../src/core/config/index.js';
import {
  applyTlsPreference,
  getEngineTlsInfo,
  getNativeEngineTlsNote,
  setNativeEngineTlsLibrary,
} from '../../../src/core/utilities/package-utils.js';

describe('server.ssl.library in the config', () => {
  beforeEach(() => resetConfig());

  for (const library of ['boringssl', 'openssl', 'auto'] as const) {
    it(`keeps '${library}'`, () => {
      const config = loadConfigWithOptions({
        server: { ssl: { keyFile: 'k.pem', certFile: 'c.pem', library } },
      } as any);
      expect(config.server.ssl?.library).toBe(library);
    });
  }

  it('is absent when not given', () => {
    const config = loadConfigWithOptions({
      server: { ssl: { keyFile: 'k.pem', certFile: 'c.pem' } },
    } as any);
    expect(config.server.ssl?.library).toBeUndefined();
  });

  it('rejects a library that does not exist', () => {
    expect(() =>
      loadConfigWithOptions({
        server: { ssl: { keyFile: 'k.pem', certFile: 'c.pem', library: 'libressl' } },
      } as any)
    ).toThrow(/library/);
  });
});

describe('handing the choice to the engine', () => {
  afterEach(() => setNativeEngineTlsLibrary(undefined));

  const engineWith = (selectTls?: (library: string) => string) => {
    const calls: string[] = [];
    const surface: any = { serve() {}, respond() {} };
    if (selectTls) {
      surface.selectTls = (library: string) => {
        calls.push(library);
        return selectTls(library);
      };
    }
    return { surface, calls };
  };

  it('never reads a native function off the module before choosing', () => {
    // The real module is a Proxy whose `get` of a native name loads the
    // binary; `in` does not. A choice made after that load would be refused.
    const touched: string[] = [];
    const surface = new Proxy({ selectTls: (l: string) => l } as any, {
      get(target, prop) {
        if (prop !== 'selectTls') touched.push(String(prop));
        return target[prop];
      },
    });
    setNativeEngineTlsLibrary('openssl');
    applyTlsPreference(surface);
    expect(touched).toEqual([]);
  });

  it('hands over the ssl options with no library named, so the engine can check them', () => {
    const seen: any[] = [];
    const surface: any = { selectTls: (...a: any[]) => (seen.push(a), a[0]) };
    const ssl = { key_file_name: 'k.pem', cert_file_name: 'c.pem' };
    setNativeEngineTlsLibrary(undefined, ssl);
    applyTlsPreference(surface);
    expect(seen).toEqual([['auto', ssl]]);

    seen.length = 0;
    setNativeEngineTlsLibrary('boringssl', ssl);
    applyTlsPreference(surface);
    expect(seen).toEqual([['boringssl', ssl]]);
  });

  it('does nothing when the app did not choose', () => {
    const { surface, calls } = engineWith(l => l);
    applyTlsPreference(surface);
    expect(calls).toEqual([]);
    expect(getNativeEngineTlsNote()).toBeUndefined();
  });

  it('passes the choice to selectTls() before anything else touches the engine', () => {
    for (const library of ['boringssl', 'openssl', 'auto'] as const) {
      const { surface, calls } = engineWith(l => l);
      setNativeEngineTlsLibrary(library);
      applyTlsPreference(surface);
      expect(calls).toEqual([library]);
      expect(getNativeEngineTlsNote()).toBeUndefined();
    }
  });

  it('an engine without selectTls() (before 1.1.20) is told apart, not broken', () => {
    const { surface } = engineWith();
    setNativeEngineTlsLibrary('boringssl');
    expect(() => applyTlsPreference(surface)).not.toThrow();
    expect(getNativeEngineTlsNote()).toMatch(/needs @morojs\/engine 1\.1\.20 or later/);

    // 'auto' asks for nothing an old engine cannot give.
    setNativeEngineTlsLibrary('auto');
    applyTlsPreference(surface);
    expect(getNativeEngineTlsNote()).toBeUndefined();
  });

  it('a refusal from the engine becomes a note, never an exception', () => {
    const { surface } = engineWith(() => {
      throw new Error(
        "@morojs/engine: selectTls('openssl') came after the binding was loaded with boringssl.\nmore detail"
      );
    });
    setNativeEngineTlsLibrary('openssl');
    expect(() => applyTlsPreference(surface)).not.toThrow();
    expect(getNativeEngineTlsNote()).toBe(
      "@morojs/engine: selectTls('openssl') came after the binding was loaded with boringssl."
    );
  });

  it('the note of an earlier app does not stick to the next one', () => {
    const { surface: old } = engineWith();
    setNativeEngineTlsLibrary('openssl');
    applyTlsPreference(old);
    expect(getNativeEngineTlsNote()).toBeDefined();

    const { surface } = engineWith(l => l);
    applyTlsPreference(surface);
    expect(getNativeEngineTlsNote()).toBeUndefined();
  });
});

describe('what the engine reports', () => {
  it('reads probe().tls', () => {
    const module = {
      probe: () => ({
        ok: true,
        tls: {
          library: 'boringssl',
          version: '0.20261105.0',
          date: '2026-11-05',
          reason: 'default',
        },
      }),
    };
    expect(getEngineTlsInfo(module)).toEqual({
      library: 'boringssl',
      version: '0.20261105.0',
      date: '2026-11-05',
      reason: 'default',
    });
  });

  it('keeps the fallback reason, and reads through a default export', () => {
    const module = {
      default: {
        probe: () => ({
          tls: {
            library: 'openssl',
            version: '3.5.4',
            reason: 'fallback',
            fallbackReason: 'moro_engine_linux_x64_gnu_137_boringssl.node: not present',
          },
        }),
      },
    };
    expect(getEngineTlsInfo(module)).toEqual({
      library: 'openssl',
      version: '3.5.4',
      reason: 'fallback',
      fallbackReason: 'moro_engine_linux_x64_gnu_137_boringssl.node: not present',
    });
  });

  it('reports nothing for an engine that says nothing, or cannot be probed', () => {
    expect(getEngineTlsInfo({ probe: () => ({ ok: true }) })).toBeUndefined();
    expect(
      getEngineTlsInfo({ probe: () => ({ tls: { library: 'gnutls', version: '1' } }) })
    ).toBeUndefined();
    expect(
      getEngineTlsInfo({
        probe: () => {
          throw new Error('no binary');
        },
      })
    ).toBeUndefined();
    expect(getEngineTlsInfo({})).toBeUndefined();
    expect(getEngineTlsInfo(undefined)).toBeUndefined();
  });
});
