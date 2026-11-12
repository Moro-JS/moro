// @ts-nocheck
// Integration - server.ssl.library: 'openssl' makes the native engine
// terminate TLS with the OpenSSL of the running Node.js instead of its bundled
// BoringSSL. Needs @morojs/engine 1.1.20+ (older engines skip).
import { describe, it, expect, afterEach } from '@jest/globals';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { fixturePath, httpsRequest } from '../utils/tls-client.js';
import { bootTlsApp, engineHasTlsLibraries } from '../utils/engine-tls.js';

const suite = engineHasTlsLibraries() ? describe : describe.skip;

suite("engine TLS library: server.ssl.library 'openssl'", () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  it("serves TLS on Node's OpenSSL, still on the engine", async () => {
    const booted = await bootTlsApp({
      keyFile: fixturePath('localhost.key'),
      certFile: fixturePath('localhost.pem'),
      library: 'openssl',
    });
    app = booted.app;
    expect(app.engine.server).toBe('engine');
    expect(app.engine.tls).toMatchObject({ library: 'openssl', reason: 'selectTls()' });
    expect(app.engine.tls.version).toBe(process.versions.openssl.replace(/\+.*$/, ''));
    expect(app.engine.tls.date).toBeUndefined();

    const res = await httpsRequest(booted.port, '/who');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ secure: true });
  });
});
