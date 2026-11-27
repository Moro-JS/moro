/* eslint-disable */
// @ts-nocheck
// Integration - configurable server limits enforced over the wire on the
// native engine. Boundaries are tested at the CONFIGURED value (not just the
// default), including a raised body limit that accepts a body the default
// would reject. Node parity is checked where the limit applies to both.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import * as net from 'net';

// limits.responseBackpressureLimit is handed to engines that advertise
// responseLimits; an older engine has no such limit to enforce.
const responseLimits = loadNativeEngine()?.capabilities?.responseLimits === true;
const itResponseLimits = responseLimits ? it : it.skip;

const testPort = () => createTestPort();
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

describeEngine('Native engine configurable limits (over the wire)', () => {
  let app: any;
  afterEach(async () => {
    jest.restoreAllMocks();
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('body over the configured bodySizeLimit is 413; at the limit is served', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', bodySizeLimit: '2kb', maxUploadSize: '2kb' },
    });
    app.post('/echo', (req: any) => ({ len: JSON.stringify(req.body ?? '').length }));
    await listen(app, port);
    const base = `http://127.0.0.1:${port}/echo`;

    const under = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(1000),
    });
    expect(under.status).toBe(200);

    const over = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(4096),
    });
    expect(over.status).toBe(413);
  });

  it('raised bodySizeLimit accepts a body larger than the 10mb default', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', bodySizeLimit: '12mb', maxUploadSize: '12mb' },
    });
    app.post('/upload', (req: any) => ({ bytes: (req.body ?? '').length }));
    await listen(app, port);

    const body = 'y'.repeat(11 * 1024 * 1024); // 11MB > default 10MB
    const res = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bytes).toBe(body.length);
  }, 30000);

  itResponseLimits(
    'limits.responseBackpressureLimit closes a connection with more than that queued unsent; without it the response waits for the client',
    async () => {
      const megabyte = 1024 * 1024;
      const small = Buffer.alloc(megabyte, 0x61);
      const large = Buffer.alloc(8 * megabyte, 0x62);

      // One request for the 8 MiB response from a client that starts reading late
      const largeToSlowClient = async (limits: any) => {
        if (app) {
          await closeApp(app);
          resetConfig();
        }
        const port = testPort();
        app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro', limits } });
        app.get('/small', (_req: any, res: any) => res.send(small));
        app.get('/large', (_req: any, res: any) => res.send(large));
        await listen(app, port);

        // A response under the limit is delivered whole
        const read = await fetch(`http://127.0.0.1:${port}/small`);
        expect((await read.arrayBuffer()).byteLength).toBe(megabyte);

        const socket = net.connect({ host: '127.0.0.1', port });
        await new Promise(resolve => socket.once('connect', resolve));
        socket.pause();
        socket.on('error', () => {});
        let received = 0;
        let closed = false;
        socket.on('data', chunk => (received += chunk.length));
        socket.on('close', () => (closed = true));
        socket.write('GET /large HTTP/1.1\r\nHost: t\r\n\r\n');
        await new Promise(resolve => setTimeout(resolve, 300));
        socket.resume();
        const deadline = Date.now() + 5000;
        while (!closed && received < large.length && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        socket.destroy();
        return { received, closed };
      };

      // 8 MiB written at once is more than may wait: the connection is closed
      const limited = await largeToSlowClient({ responseBackpressureLimit: '3mb' });
      expect(limited.closed).toBe(true);
      expect(limited.received).toBeLessThan(large.length);

      // Not set: nothing bounds the queue, and the client gets all of it
      const unlimited = await largeToSlowClient({});
      expect(unlimited.received).toBeGreaterThan(large.length);
      expect(unlimited.closed).toBe(false);
    }
  );

  // limits.memoryBudget is the engine's to enforce, and only an engine that
  // advertises bufferBudget is handed it. What it is handed is read off
  // serve(), with the capability set either way, so this holds on whichever
  // engine is installed (one that does not know the option ignores it).
  it('limits.memoryBudget is handed to an engine that keeps a buffer budget: bytes for a size, Infinity for false, nothing when not set', async () => {
    const engine = loadNativeEngine()!;
    const capabilities = engine.capabilities as any;
    const advertised = capabilities.bufferBudget;
    const serve = jest.spyOn(engine.module, 'serve');
    const handedWith = async (limits: any) => {
      if (app) {
        await closeApp(app);
        resetConfig();
      }
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine: 'moro', limits },
      });
      return serve.mock.calls[serve.mock.calls.length - 1]?.[1] as any;
    };

    try {
      capabilities.bufferBudget = true;
      expect((await handedWith({ memoryBudget: '2gb' })).memoryBudget).toBe(2 * 1024 * 1024 * 1024);
      expect((await handedWith({ memoryBudget: 64 * 1024 * 1024 })).memoryBudget).toBe(
        64 * 1024 * 1024
      );
      expect((await handedWith({ memoryBudget: false })).memoryBudget).toBe(Infinity);
      expect('memoryBudget' in (await handedWith({}))).toBe(false);

      capabilities.bufferBudget = false;
      expect('memoryBudget' in (await handedWith({ memoryBudget: '2gb' }))).toBe(false);
      expect('memoryBudget' in (await handedWith({ memoryBudget: false }))).toBe(false);
    } finally {
      capabilities.bufferBudget = advertised;
    }
  });

  it('multipart maxFiles is enforced (413 over the limit)', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', limits: { multipart: { maxFiles: 1 } } },
    });
    app.post('/up', (req: any) => ({ ok: true, files: Object.keys(req.body?.files ?? {}).length }));
    await listen(app, port);

    const form = new FormData();
    form.append('a', new Blob(['file-a'], { type: 'text/plain' }), 'a.txt');
    form.append('b', new Blob(['file-b'], { type: 'text/plain' }), 'b.txt');
    const res = await fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: form });
    expect(res.status).toBe(413);
  });

  it('multipart within maxFiles succeeds', async () => {
    const port = testPort();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', limits: { multipart: { maxFiles: 3 } } },
    });
    app.post('/up', (req: any) => ({ files: Object.keys(req.body?.files ?? {}).length }));
    await listen(app, port);

    const form = new FormData();
    form.append('a', new Blob(['aaa'], { type: 'text/plain' }), 'a.txt');
    form.append('b', new Blob(['bbb'], { type: 'text/plain' }), 'b.txt');
    const res = await fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).files).toBe(2);
  });
});
