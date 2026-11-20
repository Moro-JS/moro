// @ts-nocheck
// Integration - the unified server.ssl config flows to whichever runtime
// serves. One config (inline PEM and file-path variants) is driven over HTTPS
// against the native engine and the Node https server, asserting parity, that
// req.secure/protocol report https, and that a plain HTTP request to the TLS
// port is rejected. The engine leg self-skips when the engine is absent.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { loadConfigWithOptions, resetConfig } from '../../src/core/config/index.js';
import {
  normalizeSSLConfig,
  sslForEngine,
  sslForNode,
} from '../../src/core/http/utils/ssl-config.js';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine, engineLoadable } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { httpsRequest, tlsProbe, fixture, fixturePath } from '../utils/tls-client.js';
import * as http from 'http';

const testPort = () => createTestPort();
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

const inlineSSL = () => ({ key: fixture('localhost.key'), cert: fixture('localhost.pem') });
const fileSSL = () => ({
  keyFile: fixturePath('localhost.key'),
  certFile: fixturePath('localhost.pem'),
});
// The underscore spelling of the file-path shape, still accepted by server.ssl
const underscoreFileSSL = () => ({
  key_file_name: fixturePath('localhost.key'),
  cert_file_name: fixturePath('localhost.pem'),
});

function registerRoutes(app: any) {
  app.get('/who', (req: any) => ({ secure: req.secure, protocol: req.protocol }));
  app.post('/echo', (req: any) => ({ received: req.body }));
}

describeEngine('Unified SSL config on the native engine', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  for (const [label, ssl] of [
    ['inline PEM', inlineSSL],
    ['file paths', fileSSL],
    ['key_file_name/cert_file_name paths', underscoreFileSSL],
  ] as const) {
    it(`serves HTTPS with ${label} ssl config ON THE ENGINE (no silent Node fallback)`, async () => {
      const port = testPort();
      app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro', ssl: ssl() } });
      registerRoutes(app);
      await listen(app, port);

      // A TLS misconfiguration makes the engine's serve() throw, and the
      // framework then boots Node https - which still answers HTTPS, so the
      // request below alone cannot tell the two apart. Pin the server kind.
      const kind = app.getServerKind();
      expect(kind.fallbackReason).toBeUndefined();
      expect(kind.server).toBe('engine');

      const res = await httpsRequest(port, '/who');
      expect(res.status).toBe(200);
      const body = res.json();
      expect(body.secure).toBe(true);
      expect(body.protocol).toBe('https');
    });
  }

  it('round-trips a POST body over TLS', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', ssl: inlineSSL() },
    });
    registerRoutes(app);
    await listen(app, port);

    const res = await httpsRequest(port, '/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 'two' }),
    });
    expect(res.status).toBe(200);
    expect(res.json().received).toEqual({ a: 1, b: 'two' });
  });

  it('rejects a plain HTTP request to the TLS port', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', ssl: inlineSSL() },
    });
    registerRoutes(app);
    await listen(app, port);

    const closedWithoutResponse = await new Promise<boolean>(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/who' }, res => {
        res.resume();
        resolve(false); // got an HTTP response - TLS port answered plaintext (bad)
      });
      req.on('error', () => resolve(true)); // connection reset / parse error (expected)
      req.setTimeout(3000, () => {
        req.destroy();
        resolve(true);
      });
    });
    expect(closedWithoutResponse).toBe(true);
  });
});

// The Node https server is ABI-independent (no addon), so this always runs.
describe('Unified SSL config on the Node https server', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('serves HTTPS via engine: node with the same config shape', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node', ssl: inlineSSL() },
    });
    registerRoutes(app);
    await listen(app, port);

    const res = await httpsRequest(port, '/who');
    expect(res.status).toBe(200);
    expect(res.json().secure).toBe(true);
  });

  it('boots with file-path ssl on the Node server too', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node', ssl: fileSSL() },
    });
    registerRoutes(app);
    await listen(app, port);
    const res = await httpsRequest(port, '/who');
    expect(res.status).toBe(200);
  });
});

// The same server.ssl gives the same TLS listener on every server: the Node
// https server, the HTTP/2 server and the native engine. Each case boots the
// servers one after another and holds every one of them to the same answers.
const TLS_BACKENDS: Array<{
  id: string;
  server: Record<string, unknown>;
  alpn: 'http/1.1' | 'h2';
}> = [
  { id: 'node', server: { engine: 'node' }, alpn: 'http/1.1' },
  { id: 'http2', server: { engine: 'node', http2: true }, alpn: 'h2' },
  ...(engineLoadable
    ? [{ id: 'engine', server: { engine: 'moro' }, alpn: 'http/1.1' as const }]
    : []),
];
// Engines that advertise tlsPolicy take `ciphers` and `ecdhCurve`. An older
// engine has no option for them: its listener runs without them, and the
// start-up warning names them with the other keys it does not apply.
const engineTlsPolicy = loadNativeEngine()?.capabilities?.tlsPolicy === true;

describe('server.ssl policy on every server', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  async function boot(backend: (typeof TLS_BACKENDS)[number], ssl: Record<string, unknown>) {
    resetConfig();
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      server: { ...backend.server, ssl: { ...inlineSSL(), ...ssl } },
    });
    app.get('/', () => ({ ok: true }));
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    expect(app.getServerKind().server).toBe(backend.id);
    return port;
  }

  async function shutdown() {
    await closeApp(app);
    app = null;
  }

  it('requires a client certificate that verifies when requestCert and rejectUnauthorized are set', async () => {
    // Two trusted issuers: the test CA, and a self-signed certificate that is
    // its own issuer. A client holding the second is trusted only when the
    // whole `ca` list reaches the listener.
    const mtls = {
      ca: [fixture('ca.pem'), fixture('selfsigned.pem')],
      requestCert: true,
      rejectUnauthorized: true,
    };
    const trusted = { key: fixture('selfsigned.key'), cert: fixture('selfsigned.pem') };
    const untrusted = { key: fixture('ed448.key'), cert: fixture('ed448.pem') };

    const seen: Record<string, unknown> = {};
    for (const backend of TLS_BACKENDS) {
      const port = await boot(backend, mtls);
      seen[backend.id] = {
        withoutCertificate: (await tlsProbe(port, { alpn: backend.alpn })).ok,
        withTrustedCertificate: (await tlsProbe(port, { alpn: backend.alpn, ...trusted })).ok,
        withUntrustedCertificate: (await tlsProbe(port, { alpn: backend.alpn, ...untrusted })).ok,
      };
      await shutdown();
    }

    for (const backend of TLS_BACKENDS) {
      expect({ backend: backend.id, ...(seen[backend.id] as object) }).toEqual({
        backend: backend.id,
        withoutCertificate: false,
        withTrustedCertificate: true,
        withUntrustedCertificate: false,
      });
    }
  });

  it('refuses TLS 1.2 when minVersion is TLSv1.3', async () => {
    const seen: Record<string, unknown> = {};
    for (const backend of TLS_BACKENDS) {
      const port = await boot(backend, { minVersion: 'TLSv1.3' });
      const tls12 = await tlsProbe(port, { alpn: backend.alpn, maxVersion: 'TLSv1.2' });
      const tls13 = await tlsProbe(port, { alpn: backend.alpn });
      seen[backend.id] = { tls12: tls12.ok, tls13: tls13.ok, protocol: tls13.protocol };
      await shutdown();
    }

    for (const backend of TLS_BACKENDS) {
      expect({ backend: backend.id, ...(seen[backend.id] as object) }).toEqual({
        backend: backend.id,
        tls12: false,
        tls13: true,
        protocol: 'TLSv1.3',
      });
    }
  });

  it('negotiates only the configured ciphers', async () => {
    // One TLS 1.2 cipher and one TLS 1.3 suite, neither the default choice
    const ciphers = 'ECDHE-ECDSA-AES256-GCM-SHA384:TLS_CHACHA20_POLY1305_SHA256';

    const backends = TLS_BACKENDS.filter(b => b.id !== 'engine' || engineTlsPolicy);
    const seen: Record<string, unknown> = {};
    for (const backend of backends) {
      const port = await boot(backend, { ciphers });
      const tls12 = await tlsProbe(port, { alpn: backend.alpn, maxVersion: 'TLSv1.2' });
      const tls13 = await tlsProbe(port, { alpn: backend.alpn, minVersion: 'TLSv1.3' });
      // A client that offers only a cipher outside the list has nothing in common
      const other = await tlsProbe(port, {
        alpn: backend.alpn,
        maxVersion: 'TLSv1.2',
        ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256',
      });
      seen[backend.id] = { tls12: tls12.cipher, tls13: tls13.cipher, outsideTheList: other.ok };
      await shutdown();
    }

    for (const backend of backends) {
      expect({ backend: backend.id, ...(seen[backend.id] as object) }).toEqual({
        backend: backend.id,
        tls12: 'ECDHE-ECDSA-AES256-GCM-SHA384',
        tls13: 'TLS_CHACHA20_POLY1305_SHA256',
        outsideTheList: false,
      });
    }
  });

  it('applies maxVersion on the Node.js servers', async () => {
    for (const backend of TLS_BACKENDS.filter(b => b.id !== 'engine')) {
      const port = await boot(backend, { maxVersion: 'TLSv1.2' });
      const tls13 = await tlsProbe(port, { alpn: backend.alpn, minVersion: 'TLSv1.3' });
      const tls12 = await tlsProbe(port, { alpn: backend.alpn });
      expect({
        backend: backend.id,
        tls13: tls13.ok,
        tls12: tls12.ok,
        protocol: tls12.protocol,
      }).toEqual({ backend: backend.id, tls13: false, tls12: true, protocol: 'TLSv1.2' });
      await shutdown();
    }
  });
});

// Every server.ssl key reaches the TLS layer of the Node.js servers. The
// native engine has no option for some of them; those, and any key the
// framework does not read at all, are named in a start-up warning, so a
// policy that is configured but absent is never silent.
describe('server.ssl options and what applies them', () => {
  const POLICY = {
    maxVersion: 'TLSv1.3',
    ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
    honorCipherOrder: true,
    ecdhCurve: 'P-384',
    sigalgs: 'ecdsa_secp256r1_sha256',
    crl: '-----BEGIN X509 CRL-----',
  };
  const NOT_READ = { dhparam: 'x', sessionTimeout: 300, cipherz: 'typo' };

  // warn() is an instance property (a noop below the active level), so raise
  // the level and observe the shared private log(level, message) sink.
  const captureWarnings = () => {
    globalLogger.setLevel('warn');
    const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    return () => spy.mock.calls.filter(c => c[0] === 'warn').map(c => String(c[1]));
  };

  let app: any;
  afterEach(async () => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('keeps the handshake-policy keys in the configuration and hands them to Node as written', () => {
    const warnings = captureWarnings();

    const config = loadConfigWithOptions({
      server: { ssl: { ...fileSSL(), minVersion: 'TLSv1.2', ...POLICY } },
    } as any);

    expect(config.server.ssl).toMatchObject(POLICY);
    expect(warnings().filter(m => m.includes('NOT applied'))).toEqual([]);

    const normalized = normalizeSSLConfig(config.server.ssl, undefined, globalLogger);
    expect(sslForNode(normalized)).toMatchObject({ minVersion: 'TLSv1.2', ...POLICY });
    // The engine takes the cipher list and the curves
    expect(sslForEngine(normalized)).toMatchObject({
      ciphers: POLICY.ciphers,
      ecdhCurve: POLICY.ecdhCurve,
    });
  });

  it('rejects a maxVersion below minVersion', () => {
    expect(() =>
      loadConfigWithOptions({
        server: { ssl: { ...fileSSL(), minVersion: 'TLSv1.3', maxVersion: 'TLSv1.2' } },
      } as any)
    ).toThrow(/server\.ssl\.maxVersion/);
  });

  it('names every server.ssl key that is set but not read', () => {
    const warnings = captureWarnings();

    const config = loadConfigWithOptions({
      server: { ssl: { ...fileSSL(), minVersion: 'TLSv1.3', ...NOT_READ } },
    } as any);

    const hit = warnings().filter(m => m.includes('NOT applied'));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('server.ssl');
    for (const key of Object.keys(NOT_READ)) {
      expect(hit[0]).toContain(`'${key}'`);
    }
    expect(hit[0]).not.toContain("'minVersion'");
    expect(hit[0]).not.toContain("'keyFile'");

    // The options are reported, not passed through
    for (const key of Object.keys(NOT_READ)) {
      expect(config.server.ssl).not.toHaveProperty(key);
    }
    expect(config.server.ssl.minVersion).toBe('TLSv1.3');
  });

  it('says nothing for a config made of supported keys', () => {
    const warnings = captureWarnings();

    loadConfigWithOptions({
      server: {
        ssl: {
          ...fileSSL(),
          caFile: fixturePath('localhost.pem'),
          passphrase: 'x',
          minVersion: 'TLSv1.2',
          requestCert: true,
          rejectUnauthorized: false,
          library: 'auto',
          watch: { debounceMs: 500 },
        },
      },
    } as any);
    normalizeSSLConfig(underscoreFileSSL(), undefined, globalLogger);
    normalizeSSLConfig(null, { ...inlineSSL(), ciphers: undefined } as any, globalLogger);

    expect(warnings().filter(m => m.includes('NOT applied'))).toEqual([]);
  });

  it('names them for an ssl config handed over directly (options.https)', () => {
    const warn = jest.fn();

    const ssl = normalizeSSLConfig(
      null,
      { ...inlineSSL(), dhparam: NOT_READ.dhparam, cipherz: NOT_READ.cipherz } as any,
      { warn } as any
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('options.https');
    expect(message).toContain("'dhparam'");
    expect(message).toContain("'cipherz'");
    expect(message).toContain('NOT applied');
    expect(ssl).not.toHaveProperty('dhparam');
    expect(ssl).not.toHaveProperty('cipherz');
  });

  (engineLoadable ? it : it.skip)(
    'names the keys the native engine has no option for, and no others',
    async () => {
      const warnings = captureWarnings();

      const port = testPort();
      app = await createApp({
        logger: { level: 'warn' },
        autoDiscover: false,
        server: {
          engine: 'moro',
          ssl: {
            ...inlineSSL(),
            maxVersion: 'TLSv1.3',
            honorCipherOrder: true,
            sigalgs: 'ecdsa_secp256r1_sha256',
            ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384',
            ecdhCurve: 'P-384',
          },
        },
      });
      await listen(app, port);
      expect(app.getServerKind().server).toBe('engine');

      const hit = warnings().filter(m => m.includes('NOT applied by the native engine'));
      expect(hit).toHaveLength(1);
      expect(hit[0]).toContain('server.ssl.maxVersion');
      expect(hit[0]).toContain('server.ssl.honorCipherOrder');
      expect(hit[0]).toContain('server.ssl.sigalgs');
      if (engineTlsPolicy) {
        expect(hit[0]).not.toContain('ciphers');
        expect(hit[0]).not.toContain('ecdhCurve');
      } else {
        expect(hit[0]).toContain('server.ssl.ciphers');
        expect(hit[0]).toContain('server.ssl.ecdhCurve');
      }
    }
  );
});
