// @ts-nocheck
// Integration - the TLS library the native engine terminates TLS with, when
// the app says nothing about it: the engine's bundled BoringSSL, reported on
// app.engine.tls. Needs @morojs/engine 1.1.20+ (older engines skip).
import { describe, it, expect, afterEach } from '@jest/globals';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { fixturePath, httpsRequest } from '../utils/tls-client.js';
import { bootTlsApp, engineHasTlsLibraries } from '../utils/engine-tls.js';

const suite = engineHasTlsLibraries() ? describe : describe.skip;

suite('engine TLS library: default', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  it('serves TLS on the bundled BoringSSL and says so on app.engine.tls', async () => {
    const booted = await bootTlsApp({
      keyFile: fixturePath('localhost.key'),
      certFile: fixturePath('localhost.pem'),
    });
    app = booted.app;
    expect(app.engine.server).toBe('engine');
    expect(app.engine.tls).toMatchObject({ library: 'boringssl', reason: 'default' });
    expect(app.engine.tls.version).toMatch(/^0\.\d{8}\.\d+$/);
    expect(app.engine.tls.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const res = await httpsRequest(booted.port, '/who');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ secure: true });
  });

  it("'auto' is the same thing", async () => {
    const booted = await bootTlsApp({
      keyFile: fixturePath('localhost.key'),
      certFile: fixturePath('localhost.pem'),
      library: 'auto',
    });
    app = booted.app;
    expect(app.engine.tls).toMatchObject({ library: 'boringssl' });
    expect((await httpsRequest(booted.port, '/who')).status).toBe(200);
  });
});
