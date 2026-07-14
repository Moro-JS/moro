/* eslint-disable */
// @ts-nocheck
// Integration Tests - integrated WebSocket support on the native engine path.
// Regression test: the uws adapter used to register its .ws() routes on a second, never-listening uWS App, so upgrades on the real HTTP port failed.
import { describe, it, expect, afterEach } from '@jest/globals';
// The global WebSocket client only exists on Node >= 21; use the ws package so this test runs on the full CI matrix (Node 20+). Its client supports the same onopen/onerror handler style.
import { WebSocket } from 'ws';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const testPort = () => 10100 + Math.floor(Math.random() * 5000);

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// Resolves true on open, false on error/close-before-open, times out otherwise
const tryConnect = (url: string, timeoutMs = 3000): Promise<boolean> =>
  new Promise(resolve => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve(false);
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });

// Connect, send one { event, data } envelope, resolve with the first reply parsed.
const roundtrip = (url: string, out: any, timeoutMs = 3000): Promise<any> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('timeout'));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(out));
    ws.onmessage = (ev: any) => {
      clearTimeout(timer);
      ws.close();
      const text = typeof ev.data === 'string' ? ev.data : ev.data.toString();
      resolve(JSON.parse(text));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });

describeEngine('Native engine integrated WebSockets', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('accepts WebSocket upgrades on the HTTP listen port', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro' },
      websocket: {},
    });
    expect(app.engine.server).toBe('engine');

    // HTTP routes must coexist with WS upgrades on the same port
    app.get('/health', () => ({ success: true }));

    const port = testPort();
    await listen(app, port);

    const httpResponse = await fetch(`http://localhost:${port}/health`);
    expect(httpResponse.status).toBe(200);

    const connected = await tryConnect(`ws://localhost:${port}/`);
    expect(connected).toBe(true);
  });

  it('routes upgrades by URL path to the matching app.websocket() namespace', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro' },
      websocket: {},
    });
    expect(app.engine.server).toBe('engine');

    app.websocket('/command-center', {
      ping: (socket: any, data: any) =>
        socket.emit('pong', {
          ns: 'command-center',
          echo: data,
          org: socket.handshake?.query?.orgId, // handshake query exposed on the engine
        }),
    });
    app.websocket('/', {
      ping: (socket: any, data: any) => socket.emit('pong', { ns: 'root', echo: data }),
    });

    const port = testPort();
    await listen(app, port);

    // A connection to /command-center must reach the /command-center handlers,
    // not the default namespace (the engine adapter used to route every upgrade
    // to '/').
    const nsRes = await roundtrip(`ws://localhost:${port}/command-center?orgId=abc`, {
      event: 'ping',
      data: 'x',
    });
    expect(nsRes.event).toBe('pong');
    expect(nsRes.data.ns).toBe('command-center');
    expect(nsRes.data.echo).toBe('x');
    expect(nsRes.data.org).toBe('abc'); // handshake.query.orgId reached the handler

    // Isolation: '/' still routes to the default namespace's handlers.
    const rootRes = await roundtrip(`ws://localhost:${port}/`, { event: 'ping', data: 'y' });
    expect(rootRes.data.ns).toBe('root');
  });
});
