 
// @ts-nocheck
// Integration - the unified server.ssl config flows to whichever runtime
// serves. One config (inline PEM and file-path variants) is driven over HTTPS
// against the native engine and the Node https server, asserting parity, that
// req.secure/protocol report https, and that a plain HTTP request to the TLS
// port is rejected. uWS and http2 legs self-skip when their engine is absent.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import { httpsRequest, fixture, fixturePath } from '../utils/tls-client.js';
import * as http from 'http';

const testPort = () => 11000 + Math.floor(Math.random() * 4000);
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

const inlineSSL = () => ({ key: fixture('localhost.key'), cert: fixture('localhost.pem') });
const fileSSL = () => ({
  keyFile: fixturePath('localhost.key'),
  certFile: fixturePath('localhost.pem'),
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
  ] as const) {
    it(`serves HTTPS with ${label} ssl config`, async () => {
      const port = testPort();
      app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro', ssl: ssl() } });
      registerRoutes(app);
      await listen(app, port);

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
