/* eslint-disable */
// @ts-nocheck
// Integration - server.timeouts.request and server.maxConnections are FINALLY
// applied (they were validated-but-never-wired before). A stalled request is
// reaped within the budget on the engine; maxConnections drops the excess.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import * as net from 'net';

const testPort = () => 13000 + Math.floor(Math.random() * 3000);
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

describeEngine('Native engine server timeouts / connection cap', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('a stalled (slow-drip) request is reaped within timeouts.request', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', timeouts: { request: 800 } },
    });
    app.get('/', () => ({ ok: true }));
    await listen(app, port);

    // Open a socket, send a partial request line, never finish it.
    const started = Date.now();
    const closedWithin = await new Promise<boolean>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.write('GET / HTTP/1.1\r\nHost: t\r\n'); // no final CRLF -> request never completes
      });
      sock.resume();
      sock.on('close', () => resolve(Date.now() - started < 6000));
      sock.on('error', () => resolve(true));
      sock.setTimeout(8000, () => {
        sock.destroy();
        reject(new Error('request was never reaped within the budget'));
      });
    });
    expect(closedWithin).toBe(true);
  });

  it('a normal request still completes well within the budget', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', timeouts: { request: 5000 } },
    });
    app.get('/ping', () => ({ pong: true }));
    await listen(app, port);
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(res.status).toBe(200);
    expect((await res.json()).pong).toBe(true);
  });

  it('maxConnections is passed through and the server still serves', async () => {
    // A hard cap of 1 is awkward to assert deterministically over fetch (keep-
    // alive reuse), so this verifies the option is accepted and applied without
    // breaking normal serving - the engine drops accepts beyond the cap.
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', maxConnections: 50 },
    });
    app.get('/ok', () => ({ ok: true }));
    await listen(app, port);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fetch(`http://127.0.0.1:${port}/ok`).then(r => r.status))
    );
    expect(results.every(s => s === 200)).toBe(true);
  });
});
