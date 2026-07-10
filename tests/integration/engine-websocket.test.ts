/* eslint-disable */
// @ts-nocheck
// Integration Tests - integrated WebSocket support on the native engine path.
// Regression test: the uws adapter used to register its .ws() routes on a
// second, never-listening uWS App, so upgrades on the real HTTP port failed.
import { describe, it, expect, afterEach } from '@jest/globals';
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
});
