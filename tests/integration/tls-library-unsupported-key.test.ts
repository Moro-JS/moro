// @ts-nocheck
// Integration - an app whose certificate BoringSSL has no support for (an
// Ed448 key here; DSA keys, brainpool curves and the like behave the same)
// keeps running on the native engine after the engine starts bundling
// BoringSSL: with no library named, the engine checks the configuration when
// it is loaded and serves it on Node's OpenSSL, as every engine up to 1.1.19
// did. It must not fall over to the Node https server, and must not fail to
// start. Needs @morojs/engine 1.1.20+ (older engines skip).
import { describe, it, expect, afterEach } from '@jest/globals';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { fixturePath, httpsRequest } from '../utils/tls-client.js';
import { bootTlsApp, engineHasTlsLibraries } from '../utils/engine-tls.js';

const suite = engineHasTlsLibraries() ? describe : describe.skip;

suite('engine TLS library: a certificate BoringSSL does not support', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  it('is served by the engine on OpenSSL, with nothing configured', async () => {
    const booted = await bootTlsApp({
      keyFile: fixturePath('ed448.key'),
      certFile: fixturePath('ed448.pem'),
    });
    app = booted.app;
    expect(app.engine.server).toBe('engine');
    expect(app.engine.fallbackReason).toBeUndefined();
    expect(app.engine.tls).toMatchObject({ library: 'openssl', reason: 'fallback' });
    expect(app.engine.tls.fallbackReason).toMatch(/BoringSSL did not accept the TLS configuration/);

    const res = await httpsRequest(booted.port, '/who', { rejectUnauthorized: false });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ secure: true });
  });
});
