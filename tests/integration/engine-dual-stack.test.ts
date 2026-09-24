// @ts-nocheck
// Integration - app.listen(port) on the native engine binds dual-stack like
// Node's server.listen(port): both 127.0.0.1 and ::1 reach it, so a client
// that resolves `localhost` to ::1 first is not refused.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import * as net from 'net';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

const ipv6Available = () =>
  new Promise<boolean>(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::1', () => s.close(() => resolve(true)));
  });

describeEngine('Native engine dual-stack listen', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('answers on both 127.0.0.1 and ::1 when no host is given', async () => {
    const port = createTestPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/ping', () => ({ ok: true }));
    await listen(app, port);

    const v4 = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(v4.status).toBe(200);
    if (await ipv6Available()) {
      const v6 = await fetch(`http://[::1]:${port}/ping`);
      expect(v6.status).toBe(200);
      const addr = app.getHttpServer?.()?.getServer?.()?.address?.() ?? null;
      if (addr) expect(addr.family).toBe('IPv6');
    }
  });

  it('honours an explicit IPv4 host', async () => {
    const port = createTestPort();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.get('/ping', () => ({ ok: true }));
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(200);
    if (await ipv6Available()) {
      await expect(fetch(`http://[::1]:${port}/ping`)).rejects.toThrow();
    }
  });
});
