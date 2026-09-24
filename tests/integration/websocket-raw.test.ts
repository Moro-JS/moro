// @ts-nocheck
// Integration - raw WebSocket framing: app.websocket(path, handlers, { raw: true })
// exchanges plain text/binary frames with a non-Moro peer (no JSON envelope),
// while an envelope namespace on another path keeps working. Runs on the
// native engine adapter and on the ws adapter over the Node http server.
import { describe, it, expect, afterEach } from '@jest/globals';
import { WebSocket } from 'ws';
import * as crypto from 'crypto';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import { WSAdapter } from '../../src/core/networking/adapters/index.js';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

/** Open a socket and collect frames as they arrive (Buffers stay Buffers). */
function open(
  url: string
): Promise<{ ws: WebSocket; next: () => Promise<any>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: any[] = [];
    const waiters: Array<(v: any) => void> = [];
    ws.on('message', (data: any, isBinary: boolean) => {
      const frame = isBinary ? Buffer.from(data) : data.toString();
      const w = waiters.shift();
      if (w) w(frame);
      else queue.push(frame);
    });
    ws.once('open', () =>
      resolve({
        ws,
        next: () =>
          new Promise(res => {
            if (queue.length) res(queue.shift());
            else waiters.push(res);
          }),
        close: () => ws.close(),
      })
    );
    ws.once('error', reject);
  });
}

// The ws adapter mounts its upgrade handler under /ws (path option), and maps
// /ws/<name> to the '<name>' namespace; the engine upgrades on the raw path.
function suite(makeApp: () => Promise<any>, prefix = '') {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const boot = async () => {
    app = await makeApp();
    const opened: string[] = [];
    const closed: string[] = [];
    app.websocket(
      '/echo',
      {
        connection: (socket: any) => opened.push(socket.id),
        message: (socket: any, text: string) => socket.send(text),
        binary: (socket: any, bytes: Buffer) => socket.send(bytes, true),
        disconnect: (socket: any) => closed.push(socket.id),
      },
      { raw: true }
    );
    // A handler's return value is the reply frame
    app.websocket(
      '/shout',
      { message: (_s: any, text: string) => text.toUpperCase() },
      { raw: true }
    );
    // Envelope framing on another namespace is unaffected
    app.websocket('/rpc', { ping: (_s: any, data: any) => ({ pong: data }) });
    const port = createTestPort();
    await listen(app, port);
    return { port, opened, closed };
  };

  it('echoes a text frame verbatim (no envelope, no JSON)', async () => {
    const { port } = await boot();
    const c = await open(`ws://127.0.0.1:${port}${prefix}/echo`);
    c.ws.send('hello');
    expect(await c.next()).toBe('hello');
    c.ws.send('{"not":"an envelope"}');
    expect(await c.next()).toBe('{"not":"an envelope"}');
    c.close();
  });

  it('echoes a 256-byte binary frame byte-exact', async () => {
    const { port } = await boot();
    const c = await open(`ws://127.0.0.1:${port}${prefix}/echo`);
    const bytes = crypto.randomBytes(256);
    c.ws.send(bytes, { binary: true });
    const back = await c.next();
    expect(Buffer.isBuffer(back)).toBe(true);
    expect(Buffer.compare(back, bytes)).toBe(0);
    c.close();
  });

  it('keeps order across five back-to-back frames', async () => {
    const { port } = await boot();
    const c = await open(`ws://127.0.0.1:${port}${prefix}/echo`);
    for (let i = 0; i < 5; i++) c.ws.send(`m${i}`);
    for (let i = 0; i < 5; i++) expect(await c.next()).toBe(`m${i}`);
    c.close();
  });

  it('sends a string returned from the handler as the reply frame', async () => {
    const { port } = await boot();
    const c = await open(`ws://127.0.0.1:${port}${prefix}/shout`);
    c.ws.send('quiet');
    expect(await c.next()).toBe('QUIET');
    c.close();
  });

  it('runs the connection and disconnect hooks once per socket', async () => {
    const { port, opened, closed } = await boot();
    const c = await open(`ws://127.0.0.1:${port}${prefix}/echo`);
    c.ws.send('x');
    await c.next();
    expect(opened).toHaveLength(1);
    c.close();
    const deadline = Date.now() + 3000;
    while (closed.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(closed).toEqual(opened);
  });

  it('leaves envelope namespaces on other paths unchanged', async () => {
    const { port } = await boot();
    const c = await open(`ws://127.0.0.1:${port}${prefix}/rpc`);
    c.ws.send(JSON.stringify({ event: 'ping', data: 7 }));
    const reply = JSON.parse(await c.next());
    expect(reply).toEqual({ event: 'ping:response', data: { pong: 7 } });
    c.close();
  });
}

describeEngine('Raw WebSocket frames on the native engine', () =>
  suite(() => createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' }, websocket: {} }))
);

describe('Raw WebSocket frames on the ws adapter (Node http server)', () =>
  suite(
    () =>
      createApp({
        logger: { level: 'fatal' },
        server: { engine: 'node' },
        // An explicit instance: auto-detection prefers socket.io when it is
        // installed, and Socket.IO clients do not speak plain frames.
        websocket: { adapter: new WSAdapter() },
      }),
    '/ws'
  ));
