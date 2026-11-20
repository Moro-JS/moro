// Integration - the `ws` adapter's behaviour over a real http server:
// same-origin default, lifecycle events that a client cannot dispatch,
// namespace middleware that can refuse a connection, random connection ids
// and the 1 MiB default message size.
import { describe, it, expect, afterEach } from '@jest/globals';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { logger } from '../../src/core/logger/index.js';
import { WSAdapter } from '../../src/core/networking/adapters/index.js';
import type {
  WebSocketAdapterOptions,
  WebSocketConnection,
} from '../../src/core/networking/websocket-adapter.js';
import { closeApp, createTestPort, waitFor } from '../setup.js';

let server: http.Server | undefined;
let adapter: WSAdapter | undefined;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  if (adapter) await adapter.close();
  adapter = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }
  server = undefined;
});

async function boot(options: WebSocketAdapterOptions = {}, prepare?: (a: WSAdapter) => void) {
  server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  adapter = new WSAdapter();
  prepare?.(adapter);
  await adapter.initialize(server, options);
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()));
  return { adapter, port: (server.address() as AddressInfo).port };
}

interface Client {
  ws: WebSocket;
  frames: string[];
  closed: Promise<{ code: number; reason: string }>;
}

/** Open a client; rejects with the HTTP status when the upgrade is refused. */
function connect(
  port: number,
  path = '/ws',
  headers: Record<string, string> = {}
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    clients.push(ws);
    const frames: string[] = [];
    ws.on('message', data => frames.push(data.toString()));
    const closed = new Promise<{ code: number; reason: string }>(done => {
      ws.on('close', (code, reason) => done({ code, reason: reason.toString() }));
    });
    ws.once('open', () => resolve({ ws, frames, closed }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      reject(new Error(`upgrade refused: ${res.statusCode}`));
    });
    ws.once('error', reject);
  });
}

const refused = (port: number, headers: Record<string, string>) =>
  connect(port, '/ws', headers).then(
    () => 'accepted',
    (error: Error) => error.message
  );

/** Record the adapter's info-level log lines. */
function captureInfo(a: WSAdapter, into: string[]): void {
  const logger = (a as any).wsLogger;
  const original = logger.info.bind(logger);
  logger.info = (message: unknown, ...rest: unknown[]) => {
    into.push(String(message));
    return original(message, ...rest);
  };
}

const send = (client: Client, event: string, data?: unknown) =>
  client.ws.send(JSON.stringify({ event, data }));

describe('ws adapter: origin check', () => {
  it('is same-origin when cors.origin is not configured, and says so once at startup', async () => {
    const notices: string[] = [];
    const { port } = await boot({ cors: {} }, a => captureInfo(a, notices));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('websocket.options.cors.origin');
    expect(notices[0]).toContain('same origin');

    // non-browser client: no Origin header
    await expect(connect(port)).resolves.toBeDefined();
    // a page served from this host
    await expect(
      connect(port, '/ws', { Origin: `http://127.0.0.1:${port}` })
    ).resolves.toBeDefined();
    // a page on another origin, with the victim's cookie
    expect(await refused(port, { Origin: 'https://evil.example', Cookie: 'session=victim' })).toBe(
      'upgrade refused: 401'
    );
    expect(await refused(port, { Origin: `http://127.0.0.1:${port + 1}` })).toBe(
      'upgrade refused: 401'
    );
    expect(adapter?.getConnectionCount()).toBe(2);
  });

  it('keeps a configured cors.origin and verifyClient working, without the startup notice', async () => {
    const notices: string[] = [];
    const { port } = await boot(
      {
        cors: { origin: 'https://app.example' },
        verifyClient: verify => verify.req.headers['x-token'] === 'good',
      },
      a => captureInfo(a, notices)
    );
    expect(notices).toHaveLength(0);

    await expect(
      connect(port, '/ws', { Origin: 'https://app.example', 'X-Token': 'good' })
    ).resolves.toBeDefined();
    expect(await refused(port, { Origin: 'https://app.example', 'X-Token': 'bad' })).toBe(
      'upgrade refused: 401'
    );
    expect(await refused(port, { Origin: 'https://evil.example', 'X-Token': 'good' })).toBe(
      'upgrade refused: 401'
    );
  });

  it('decides a verifyClient hook that returns a promise by its resolved value', async () => {
    const hook = (async (info: { req: http.IncomingMessage }) => {
      if (info.req.headers['x-token'] === 'explode') throw new Error('auth backend down');
      return info.req.headers['x-token'] === 'good';
    }) as unknown as NonNullable<WebSocketAdapterOptions['verifyClient']>;
    const { port } = await boot({ verifyClient: hook });
    await expect(connect(port, '/ws', { 'X-Token': 'good' })).resolves.toBeDefined();
    expect(await refused(port, { 'X-Token': 'bad' })).toBe('upgrade refused: 401');
    expect(await refused(port, { 'X-Token': 'explode' })).toBe('upgrade refused: 401');
  });

  it("accepts any origin when cors.origin is '*'", async () => {
    const { port } = await boot({ cors: { origin: '*' } });
    await expect(
      connect(port, '/ws', { Origin: 'https://anything.example' })
    ).resolves.toBeDefined();
  });
});

describe('ws adapter: lifecycle events are not client-sendable', () => {
  it('a frame named connection / disconnect / close / error runs no handler', async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/chat');
    const fired: string[] = [];
    let serverSocket: WebSocketConnection | undefined;
    ns.on('connection', socket => {
      serverSocket = socket;
      fired.push('connection-hook');
      socket.on('connection', () => fired.push('connection'));
      socket.on('disconnect', () => fired.push('disconnect'));
      socket.on('close', () => fired.push('close'));
      socket.on('error', () => fired.push('error'));
      socket.onAny(event => fired.push(`any:${event}`));
      socket.on('chat', (data: any, callback?: (response?: any) => void) => {
        fired.push(`chat:${data}`);
        callback?.('ack');
      });
    });

    const client = await connect(port, '/ws/chat');
    await waitFor(() => fired.includes('connection-hook'), { description: 'connection hook' });

    for (const event of ['disconnect', 'disconnect', 'close', 'error', 'connection']) {
      send(client, event, { forged: true });
    }
    // an ordinary event after them proves the forged frames were processed
    client.ws.send(JSON.stringify({ event: 'chat', data: 'hello', callback: 'c1' }));
    await waitFor(() => client.frames.length === 1, { description: 'the chat acknowledgement' });

    expect(fired).toEqual(['connection-hook', 'any:chat', 'chat:hello']);
    expect(JSON.parse(client.frames[0] as string)).toEqual({
      event: 'callback',
      data: { id: 'c1', data: 'ack' },
    });
    // still connected and still a member of the namespace
    expect(serverSocket?.connected).toBe(true);
    expect(ns.getConnectionCount()).toBe(1);

    // the real close runs the hooks exactly once
    client.ws.close(1000, 'bye');
    await waitFor(() => fired.includes('disconnect'), { description: 'the disconnect hook' });
    expect(fired.slice(3)).toEqual(['close', 'disconnect']);
    expect(ns.getConnectionCount()).toBe(0);
  });

  it("socket.emit('error') is an event for the client; a socket error runs the server's handlers", async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/chat');
    const seen: unknown[] = [];
    let serverSocket: WebSocketConnection | undefined;
    ns.on('connection', socket => {
      serverSocket = socket;
      socket.on('error', (error: unknown) => seen.push(error));
    });

    const client = await connect(port, '/ws/chat');
    await waitFor(() => serverSocket !== undefined, { description: 'the connection' });

    serverSocket?.emit('error', { success: false, error: 'not allowed' });
    await waitFor(() => client.frames.length === 1, { description: 'the error event' });
    expect(JSON.parse(client.frames[0] as string)).toEqual({
      event: 'error',
      data: { success: false, error: 'not allowed' },
    });
    expect(seen).toEqual([]);

    // The underlying socket failing is the server's own 'error' event
    const failure = new Error('read ECONNRESET');
    (serverSocket as any).ws.emit('error', failure);
    expect(seen).toEqual([failure]);
    expect(client.frames).toHaveLength(1);
  });

  it("socket.emit('close') is an event for the client too, and leaves the socket where it is", async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/chat');
    const fired: string[] = [];
    let serverSocket: WebSocketConnection | undefined;
    ns.on('connection', socket => {
      serverSocket = socket;
      socket.on('close', () => fired.push('close'));
      socket.on('disconnect', () => fired.push('disconnect'));
    });

    const client = await connect(port, '/ws/chat');
    await waitFor(() => serverSocket !== undefined, { description: 'the connection' });

    serverSocket?.emit('close', { reason: 'maintenance at 02:00' });
    await waitFor(() => client.frames.length === 1, { description: 'the close event' });
    expect(JSON.parse(client.frames[0] as string)).toEqual({
      event: 'close',
      data: { reason: 'maintenance at 02:00' },
    });
    // Nothing closed: no handler ran, and the socket is still a member of its
    // namespace, so broadcasts go on reaching it
    expect(fired).toEqual([]);
    expect(serverSocket?.connected).toBe(true);
    expect(ns.getConnectionCount()).toBe(1);
    ns.emit('news', 'still here');
    await waitFor(() => client.frames.length === 2, { description: 'a broadcast' });

    // The socket closing is the server's own 'close' event
    client.ws.close(1000, 'bye');
    await waitFor(() => fired.includes('disconnect'), { description: 'the disconnect hook' });
    expect(fired).toEqual(['close', 'disconnect']);
    expect(ns.getConnectionCount()).toBe(0);
  });
});

describe('ws adapter: app.websocket() hooks', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  it('a client cannot run the disconnect / connection hooks by sending their names', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node' },
      websocket: { adapter: new WSAdapter() },
    });
    const calls: string[] = [];
    app.websocket('/presence', {
      connection: () => calls.push('connection'),
      disconnect: () => calls.push('disconnect'),
      close: () => calls.push('close'),
      error: () => calls.push('error'),
      ping: (_socket: unknown, data: unknown) => ({ pong: data }),
    });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));

    const client = await connect(port, '/ws/presence');
    await waitFor(() => calls.includes('connection'), { description: 'the connection hook' });
    for (const event of ['disconnect', 'disconnect', 'close', 'error', 'connection']) {
      send(client, event);
    }
    send(client, 'ping', 7);
    await waitFor(() => client.frames.length === 1, { description: 'the ping reply' });
    expect(JSON.parse(client.frames[0] as string)).toEqual({
      event: 'ping:response',
      data: { pong: 7 },
    });
    expect(calls).toEqual(['connection']);

    client.ws.close();
    await waitFor(() => calls.includes('disconnect'), { description: 'the disconnect hook' });
    expect(calls.filter(c => c === 'disconnect')).toHaveLength(1);
    expect(calls.filter(c => c === 'connection')).toHaveLength(1);
  });

  it('tells the client what a handler threw outside production, and only that it failed in production', async () => {
    app = await createApp({
      logger: { level: 'error' },
      server: { engine: 'node' },
      websocket: { adapter: new WSAdapter() },
    });
    const reported: string[] = [];
    app.on('websocket:error', (e: any) => reported.push(e.error.message));
    app.websocket('/orders', {
      load: () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      },
      save: async () => {
        throw new Error('duplicate key value violates "orders_pkey"');
      },
    });
    const logged: string[] = [];
    logger.addOutput({
      name: 'ws-handler-errors',
      write: (entry: any) => {
        if (entry.message === 'WebSocket handler error') logged.push(entry.metadata?.error);
      },
    } as any);
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));

    const client = await connect(port, '/ws/orders');
    const reply = async (event: string) => {
      const before = client.frames.length;
      // Asked for with a callback id, the answer comes back under that id
      client.ws.send(JSON.stringify({ event, callback: 'answer' }));
      await waitFor(() => client.frames.length === before + 1, {
        description: `the reply to ${event}`,
      });
      return JSON.parse(client.frames[before] as string);
    };
    const answer = (error: string) => ({
      event: 'callback',
      data: { id: 'answer', data: { success: false, error } },
    });

    const environment = process.env.NODE_ENV;
    try {
      expect(await reply('load')).toEqual(answer('connect ECONNREFUSED 10.0.0.5:5432'));

      process.env.NODE_ENV = 'production';
      expect(await reply('load')).toEqual(answer('Internal server error'));
      expect(await reply('save')).toEqual(answer('Internal server error'));
    } finally {
      process.env.NODE_ENV = environment;
      logger.removeOutput('ws-handler-errors');
    }

    // The application still gets the error itself, and so does the log
    const thrown = [
      'connect ECONNREFUSED 10.0.0.5:5432',
      'connect ECONNREFUSED 10.0.0.5:5432',
      'duplicate key value violates "orders_pkey"',
    ];
    expect(reported).toEqual(thrown);
    expect(logged).toEqual(thrown);
  });

  it('answers a failed handler with an error event when the message asked for no reply', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node' },
      websocket: { adapter: new WSAdapter() },
    });
    const hookCalls: unknown[] = [];
    app.websocket('/orders', {
      load: () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      },
      save: async () => {
        throw new Error('duplicate key value violates "orders_pkey"');
      },
      // The server-side hook is for socket errors; a failed handler is not one
      error: (_socket: unknown, detail: unknown) => {
        hookCalls.push(detail);
      },
    });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));

    const client = await connect(port, '/ws/orders');
    const failed = async (event: string) => {
      const before = client.frames.length;
      // No callback id: there is no reply to carry the failure
      send(client, event);
      await waitFor(() => client.frames.length === before + 1, {
        description: `the error event for ${event}`,
      });
      return JSON.parse(client.frames[before] as string);
    };
    const errorEvent = (error: string) => ({ event: 'error', data: { success: false, error } });

    const environment = process.env.NODE_ENV;
    try {
      expect(await failed('load')).toEqual(errorEvent('connect ECONNREFUSED 10.0.0.5:5432'));

      process.env.NODE_ENV = 'production';
      expect(await failed('load')).toEqual(errorEvent('Internal server error'));
      expect(await failed('save')).toEqual(errorEvent('Internal server error'));
    } finally {
      process.env.NODE_ENV = environment;
    }
    expect(client.frames).toHaveLength(3);
    expect(hookCalls).toEqual([]);
  });

  // What a connection and a request from the same client report, with the
  // proxy's X-Forwarded-For on both
  async function addressesWith(server: Record<string, unknown>) {
    resetConfig();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node', ...server },
      websocket: { adapter: new WSAdapter() },
    });
    const seen: { atOpen?: unknown; atClose?: unknown; firstReadAtClose?: unknown } = {};
    app.get('/ip', (req: any) => ({ ip: req.ip }));
    app.websocket('/who', {
      connection: (socket: WebSocketConnection) => {
        // The second client's address is not looked at before it has gone
        if (socket.headers?.['x-ask'] === 'late') {
          socket.on('disconnect', () => {
            seen.firstReadAtClose = socket.ip;
          });
          return;
        }
        seen.atOpen = socket.ip;
        socket.on('disconnect', () => {
          seen.atClose = socket.ip;
        });
      },
    });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

    const forwarded = { 'X-Forwarded-For': '203.0.113.7, 198.51.100.4' };
    const reply = await fetch(`http://127.0.0.1:${port}/ip`, { headers: forwarded });
    const requestIp = ((await reply.json()) as { ip: string }).ip;
    const client = await connect(port, '/ws/who', forwarded);
    await waitFor(() => seen.atOpen !== undefined, { description: 'the connection hook' });
    client.ws.close();
    await waitFor(() => 'atClose' in seen, { description: 'the disconnect handler' });
    const late = await connect(port, '/ws/who', { ...forwarded, 'X-Ask': 'late' });
    late.ws.close();
    await waitFor(() => 'firstReadAtClose' in seen, { description: 'the late disconnect handler' });
    await closeApp(app);
    app = null;
    return { requestIp, ...seen };
  }

  it('socket.ip is the client req.ip names once server.trustProxy is set, and the peer without it', async () => {
    // One trusted proxy: the client is the last X-Forwarded-For entry
    const behindProxy = await addressesWith({ trustProxy: 1 });
    expect(behindProxy.requestIp).toBe('198.51.100.4');
    expect(behindProxy.atOpen).toBe('198.51.100.4');
    // and stays that once the socket has closed
    expect(behindProxy.atClose).toBe('198.51.100.4');

    // Every hop trusted: the first entry
    expect((await addressesWith({ trustProxy: true })).atOpen).toBe('203.0.113.7');

    // No proxy trusted, and the setting left out: the connected peer
    const untrusted = await addressesWith({ trustProxy: false });
    expect(untrusted.atOpen).toBe('127.0.0.1');
    expect(untrusted.atOpen).toBe(untrusted.requestIp);
    const unset = await addressesWith({});
    expect(unset.atOpen).toBe('127.0.0.1');
    expect(unset.atOpen).toBe(unset.requestIp);
    // ... also once the socket has closed: X-Forwarded-For is the client's
    // own word, and is read only where server.trustProxy says whose to take
    expect(unset.atClose).toBe('127.0.0.1');
    expect(unset.firstReadAtClose).toBe('127.0.0.1');
    expect(untrusted.firstReadAtClose).toBe('127.0.0.1');
    expect(behindProxy.firstReadAtClose).toBe('198.51.100.4');
  });
});

describe('ws adapter: namespace middleware', () => {
  it('next(err) closes the socket with 1008 and the connection never joins the namespace', async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/secure');
    let handlerRuns = 0;
    ns.use((socket, next) => {
      if (socket.headers?.['x-token'] === 'good') next();
      else next(new Error('not authorised'));
    });
    ns.on('connection', () => {
      handlerRuns++;
    });

    const rejected = await connect(port, '/ws/secure', { 'X-Token': 'bad' });
    const close = await rejected.closed;
    expect(close.code).toBe(1008);
    expect(handlerRuns).toBe(0);
    expect(ns.getConnectionCount()).toBe(0);
    await waitFor(() => a.getConnectionCount() === 0, { description: 'adapter cleanup' });

    const accepted = await connect(port, '/ws/secure', { 'X-Token': 'good' });
    await waitFor(() => handlerRuns === 1, { description: 'the connection handler' });
    ns.emit('secret-broadcast', { account: 'balance 42' });
    await waitFor(() => accepted.frames.length === 1, { description: 'the broadcast' });
    expect(rejected.frames).toEqual([]);
    expect(ns.getConnectionCount()).toBe(1);
  });

  it('a connection receives no broadcast while middleware is still deciding', async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/slow');
    const decisions: Array<(err?: Error) => void> = [];
    let handlerRuns = 0;
    ns.use((_socket, next) => {
      decisions.push(next);
    });
    ns.on('connection', () => {
      handlerRuns++;
    });

    const pending = await connect(port, '/ws/slow');
    await waitFor(() => decisions.length === 1, { description: 'middleware to be called' });
    expect(ns.getConnectionCount()).toBe(0);
    ns.emit('early', 1);

    decisions[0]?.();
    expect(ns.getConnectionCount()).toBe(1);
    expect(handlerRuns).toBe(1);
    ns.emit('late', 2);
    await waitFor(() => pending.frames.length === 1, { description: 'the later broadcast' });
    expect(JSON.parse(pending.frames[0] as string)).toEqual({ event: 'late', data: 2 });

    // a second connection, refused after a delay
    const second = await connect(port, '/ws/slow');
    await waitFor(() => decisions.length === 2, { description: 'middleware to be called again' });
    decisions[1]?.(new Error('no'));
    expect((await second.closed).code).toBe(1008);
    expect(ns.getConnectionCount()).toBe(1);
    expect(handlerRuns).toBe(1);
  });

  it('a middleware that throws or rejects refuses the connection instead of crashing', async () => {
    const { adapter: a, port } = await boot();
    const thrown = a.createNamespace('/throws');
    thrown.use(() => {
      throw new Error('boom');
    });
    const rejecting = a.createNamespace('/rejects');
    rejecting.use((async () => {
      throw new Error('async boom');
    }) as unknown as Parameters<typeof rejecting.use>[0]);

    expect((await (await connect(port, '/ws/throws')).closed).code).toBe(1008);
    expect((await (await connect(port, '/ws/rejects')).closed).code).toBe(1008);
    expect(thrown.getConnectionCount()).toBe(0);
    expect(rejecting.getConnectionCount()).toBe(0);
  });

  it('does not run connection handlers for a client that left while middleware was deciding', async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/gone');
    const decisions: Array<(err?: Error) => void> = [];
    let handlerRuns = 0;
    ns.use((_socket, next) => {
      decisions.push(next);
    });
    ns.on('connection', () => {
      handlerRuns++;
    });
    const client = await connect(port, '/ws/gone');
    await waitFor(() => decisions.length === 1, { description: 'middleware to be called' });
    client.ws.close();
    await waitFor(() => a.getConnectionCount() === 0, {
      description: 'the server to see the close',
    });
    decisions[0]?.();
    expect(handlerRuns).toBe(0);
    expect(ns.getConnectionCount()).toBe(0);
  });
});

describe('ws adapter: socket.broadcast and socket.to(room)', () => {
  // One set of handlers for every socket of a namespace: announce
  // (socket.broadcast), join, tell (socket.to(room)) and a ping that is
  // answered to the sender alone.
  const serve = (ns: ReturnType<WSAdapter['createNamespace']>) =>
    ns.on('connection', (socket: WebSocketConnection) => {
      socket.on('announce', data => socket.broadcast.emit('announcement', data));
      socket.on('join', room => {
        socket.join(room);
        socket.emit('joined', room);
      });
      socket.on('tell', ({ room, text }) => socket.to(room).emit('room-message', text));
      socket.on('ping', data => socket.emit('pong', data));
    });

  // Frames on one socket arrive in order: once a client has its pong,
  // everything emitted to it before the ping has arrived as well.
  const settle = async (...all: Client[]) => {
    for (const client of all) {
      const from = client.frames.length;
      send(client, 'ping', 0);
      await waitFor(() => client.frames.slice(from).some(f => JSON.parse(f).event === 'pong'), {
        description: 'the pong',
      });
    }
  };
  const join = async (client: Client, room: string) => {
    const from = client.frames.length;
    send(client, 'join', room);
    await waitFor(() => client.frames.slice(from).some(f => JSON.parse(f).event === 'joined'), {
      description: 'the join',
    });
  };
  // What a client was sent, apart from the answers to its own ping and join.
  const heard = (client: Client) =>
    client.frames.map(f => JSON.parse(f)).filter(f => f.event !== 'pong' && f.event !== 'joined');

  it('socket.broadcast reaches every other socket of the same namespace, and no other', async () => {
    const { adapter: a, port } = await boot();
    serve(a.createNamespace('/chat'));
    serve(a.createNamespace('/other'));
    serve(a.getDefaultNamespace());

    const sender = await connect(port, '/ws/chat');
    const peer1 = await connect(port, '/ws/chat');
    const peer2 = await connect(port, '/ws/chat');
    const elsewhere = await connect(port, '/ws/other');
    const root = await connect(port, '/ws');
    await waitFor(() => a.getConnectionCount() === 5, { description: 'five connections' });

    send(sender, 'announce', 'rota');
    await settle(sender, peer1, peer2, elsewhere, root);
    const announcement = { event: 'announcement', data: 'rota' };
    expect(heard(peer1)).toEqual([announcement]);
    expect(heard(peer2)).toEqual([announcement]);
    expect(heard(sender)).toEqual([]);
    expect(heard(elsewhere)).toEqual([]);
    expect(heard(root)).toEqual([]);

    // A socket that has left is no longer reached, and the rest still are
    peer2.ws.close();
    await peer2.closed;
    await waitFor(() => a.createNamespace('/chat').getConnectionCount() === 2, {
      description: 'the close',
    });
    send(peer1, 'announce', 'again');
    await settle(sender, peer1);
    expect(heard(sender)).toEqual([{ event: 'announcement', data: 'again' }]);
    expect(heard(peer1)).toEqual([announcement]);
  });

  it("socket.to(room) reaches the room's members in the same namespace, the sender included when it is one", async () => {
    const { adapter: a, port } = await boot();
    serve(a.createNamespace('/chat'));
    serve(a.createNamespace('/other'));

    const sender = await connect(port, '/ws/chat');
    const member = await connect(port, '/ws/chat');
    const outsider = await connect(port, '/ws/chat');
    const elsewhere = await connect(port, '/ws/other');
    await waitFor(() => a.getConnectionCount() === 4, { description: 'four connections' });
    await join(member, 'ops');
    // The same room name in another namespace is another room
    await join(elsewhere, 'ops');

    send(sender, 'tell', { room: 'ops', text: 'pager' });
    await settle(sender, member, outsider, elsewhere);
    expect(heard(member)).toEqual([{ event: 'room-message', data: 'pager' }]);
    expect(heard(sender)).toEqual([]);
    expect(heard(outsider)).toEqual([]);
    expect(heard(elsewhere)).toEqual([]);

    // As on the native engine adapter, a sender that is in the room gets it too
    await join(sender, 'ops');
    send(sender, 'tell', { room: 'ops', text: 'second' });
    await settle(sender, member, outsider);
    expect(heard(sender)).toEqual([{ event: 'room-message', data: 'second' }]);
    expect(heard(member)).toEqual([
      { event: 'room-message', data: 'pager' },
      { event: 'room-message', data: 'second' },
    ]);
    expect(heard(outsider)).toEqual([]);
  });

  it('neither reaches a socket whose middleware has not finished', async () => {
    const { adapter: a, port } = await boot();
    const ns = a.createNamespace('/gated');
    const decisions: Array<(err?: Error) => void> = [];
    ns.use((socket, next) => {
      // A room joined before the verdict does not make the socket a member
      socket.join('ops');
      decisions.push(next);
    });
    serve(ns);

    const member = await connect(port, '/ws/gated');
    await waitFor(() => decisions.length === 1, { description: 'the first middleware call' });
    decisions[0]?.();
    const pending = await connect(port, '/ws/gated');
    await waitFor(() => decisions.length === 2, { description: 'the second middleware call' });

    send(member, 'announce', 'early');
    send(member, 'tell', { room: 'ops', text: 'early' });
    await settle(member);
    expect(heard(member)).toEqual([{ event: 'room-message', data: 'early' }]);
    expect(pending.frames).toEqual([]);

    // Once it has joined, both reach it
    decisions[1]?.();
    send(member, 'announce', 'late');
    send(member, 'tell', { room: 'ops', text: 'late' });
    await settle(member, pending);
    expect(heard(pending)).toEqual([
      { event: 'announcement', data: 'late' },
      { event: 'room-message', data: 'late' },
    ]);
  });
});

describe('ws adapter: connection ids', () => {
  it('are random UUIDs unless a generator is supplied', async () => {
    const { adapter: a, port } = await boot();
    const ids: string[] = [];
    a.getDefaultNamespace().on('connection', socket => {
      ids.push(socket.id);
    });
    await connect(port);
    await connect(port);
    await waitFor(() => ids.length === 2, { description: 'two connections' });
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(ids[0]).not.toBe(ids[1]);

    let n = 0;
    a.setCustomIdGenerator(() => `custom-${++n}`);
    await connect(port);
    await waitFor(() => ids.length === 3, { description: 'a third connection' });
    expect(ids[2]).toBe('custom-1');
  });
});

describe('ws adapter: websocket.compression', () => {
  let app: any;
  // About 150 KB of JSON that deflates to a few percent of its size
  const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, name: 'subscriber', on: true }));
  const rowsBytes = Buffer.byteLength(JSON.stringify(rows));
  const NEGOTIATED = 'permessage-deflate; server_no_context_takeover; server_max_window_bits=12';
  const NOT_APPLIED =
    'websocket.compression is set but is not applied by the ws adapter: ' +
    'permessage-deflate is not negotiated and messages are sent uncompressed. ' +
    'It is turned on when the adapter starts: set websocket.compression in the ' +
    'app configuration.';

  afterEach(async () => {
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  interface Peer {
    ws: WebSocket;
    /** the Sec-WebSocket-Extensions header of the server's answer, if any */
    accepted: string | undefined;
    frames: string[];
    closed: Promise<number>;
  }

  /**
   * `offer` is the client's permessage-deflate offer: true for the `ws`
   * client's own, false for none, or a Sec-WebSocket-Extensions value.
   */
  function open(port: number, path: string, offer: boolean | string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        perMessageDeflate: offer === true,
        ...(typeof offer === 'string' ? { headers: { 'Sec-WebSocket-Extensions': offer } } : {}),
      });
      clients.push(ws);
      const peer: Peer = {
        ws,
        accepted: undefined,
        frames: [],
        closed: new Promise<number>(done => ws.once('close', code => done(code))),
      };
      ws.once('upgrade', res => {
        const header = res.headers['sec-websocket-extensions'];
        peer.accepted = typeof header === 'string' ? header : undefined;
      });
      ws.on('message', data => peer.frames.push(data.toString()));
      ws.once('open', () => resolve(peer));
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`upgrade refused: ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }

  // Send one frame; resolves with the next frame the server sends and the
  // bytes the exchange put on the connection in each direction.
  async function exchange(peer: Peer, frame: string) {
    const socket = (peer.ws as any)._socket;
    const before = { sent: socket.bytesWritten, received: socket.bytesRead };
    const from = peer.frames.length;
    peer.ws.send(frame);
    await waitFor(() => peer.frames.length > from, { description: 'the answer' });
    return {
      reply: peer.frames[from] as string,
      sent: socket.bytesWritten - before.sent,
      received: socket.bytesRead - before.received,
    };
  }

  // Between two servers in one test (the file's afterEach stops the last one)
  async function stopServer() {
    await adapter?.close();
    adapter = undefined;
    server?.closeAllConnections();
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  }

  // A raw namespace at /ws/raw that answers each text frame with itself
  async function echoServer(options: WebSocketAdapterOptions, prepare?: (a: WSAdapter) => void) {
    const warnings: string[] = [];
    const booted = await boot(options, a => {
      const adapterLogger = (a as any).wsLogger;
      const original = adapterLogger.warn.bind(adapterLogger);
      adapterLogger.warn = (message: unknown, ...rest: unknown[]) => {
        warnings.push(String(message));
        return original(message, ...rest);
      };
      prepare?.(a);
    });
    booted.adapter.createNamespace('/raw', { raw: true }).on('connection', socket => {
      socket.on('message', (text: string) => socket.send?.(text));
    });
    return { ...booted, warnings };
  }

  it('negotiates permessage-deflate with a client that offers it, and with no other', async () => {
    // Through createApp(): websocket.compression is what turns it on
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node' },
      websocket: { adapter: new WSAdapter(), compression: true },
    });
    app.websocket('/echo', { echo: (_socket: unknown, data: unknown) => data });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));
    const echoed = (data: unknown) => ({ event: 'echo:response', data });
    const ask = (data: unknown) => JSON.stringify({ event: 'echo', data });

    const offering = await open(port, '/ws/echo', true);
    // Each message is compressed on its own, in a 4 KB window
    expect(offering.accepted).toBe(NEGOTIATED);
    const compressed = await exchange(offering, ask(rows));
    expect(JSON.parse(compressed.reply)).toEqual(echoed(rows));
    // Compressed on the way in and on the way out
    expect(compressed.sent).toBeLessThan(rowsBytes / 5);
    expect(compressed.received).toBeLessThan(rowsBytes / 5);
    // A short message goes through the same connection
    expect(JSON.parse((await exchange(offering, ask({ n: 1 }))).reply)).toEqual(echoed({ n: 1 }));

    // The same server, a client that does not offer the extension
    const plain = await open(port, '/ws/echo', false);
    expect(plain.accepted).toBeUndefined();
    const uncompressed = await exchange(plain, ask(rows));
    expect(JSON.parse(uncompressed.reply)).toEqual(echoed(rows));
    expect(uncompressed.sent).toBeGreaterThan(rowsBytes);
    expect(uncompressed.received).toBeGreaterThan(rowsBytes);

    // An offer the `ws` library would answer 400 to is declined instead: the
    // client connects as it does without compression, and is served uncompressed.
    for (const offer of [
      'permessage-deflate; server_max_window_bits=10',
      'permessage-deflate; no_such_parameter',
      'permessage-deflate; client_max_window_bits=20',
      'permessage-deflate; =;;',
    ]) {
      const declined = await open(port, '/ws/echo', offer);
      expect([offer, declined.accepted]).toEqual([offer, undefined]);
      expect(JSON.parse((await exchange(declined, ask('hi'))).reply)).toEqual(echoed('hi'));
    }
  });

  it('is off unless compression is true', async () => {
    for (const [options, negotiated] of [
      [{ compression: true }, true],
      [{}, false],
      [{ compression: false }, false],
    ] as Array<[WebSocketAdapterOptions, boolean]>) {
      const { port, adapter: a } = await echoServer({ cors: { origin: '*' }, ...options });
      // What the `ws` server was created with: off is the library's default
      expect(!!(a as any).wss.options.perMessageDeflate).toBe(negotiated);
      const peer = await open(port, '/ws/raw', true);
      expect(peer.accepted).toBe(negotiated ? NEGOTIATED : undefined);
      const { reply, received } = await exchange(peer, JSON.stringify(rows));
      expect(JSON.parse(reply)).toEqual(rows);
      expect(received > rowsBytes).toBe(!negotiated);
      peer.ws.terminate();
      await stopServer();
    }

    // Asked for on the adapter before it starts: the same as the option
    const early = await echoServer({ cors: { origin: '*' } }, a => a.setCompression(true));
    expect((await open(early.port, '/ws/raw', true)).accepted).toBe(NEGOTIATED);
    expect(early.warnings).toEqual([]);
  });

  it('closes with 1009 a connection whose message inflates past maxPayloadLength', async () => {
    const limit = 64 * 1024;
    const { port } = await echoServer({
      cors: { origin: '*' },
      compression: true,
      maxPayloadLength: limit,
    });
    const peer = await open(port, '/ws/raw', true);
    expect(peer.accepted).toBe(NEGOTIATED);
    // Under the limit once inflated: answered
    expect((await exchange(peer, 'x'.repeat(limit))).reply).toHaveLength(limit);

    // A fraction of the limit on the wire, three times the limit inflated
    const socket = (peer.ws as any)._socket;
    const sentBefore = socket.bytesWritten;
    peer.ws.send('x'.repeat(3 * limit));
    expect(await peer.closed).toBe(1009);
    expect(socket.bytesWritten - sentBefore).toBeLessThan(limit / 2);
    expect(peer.frames).toHaveLength(1);
  });

  it('says nothing when the option is applied, and says so once when it comes too late', async () => {
    const applied = await echoServer({ cors: { origin: '*' }, compression: true });
    // What the framework calls after initialize() for websocket.compression
    applied.adapter.setCompression(true);
    expect(applied.warnings).toEqual([]);
    await stopServer();

    // First asked for once the `ws` server exists: the line says where to set it
    const late = await echoServer({ cors: { origin: '*' } });
    late.adapter.setCompression(true);
    late.adapter.setCompression(true);
    expect(late.warnings).toEqual([NOT_APPLIED]);
    expect((await open(late.port, '/ws/raw', true)).accepted).toBeUndefined();
  });
});

describe('ws adapter: message size', () => {
  const MIB = 1024 * 1024;

  async function echo(options: WebSocketAdapterOptions) {
    const { adapter: a, port } = await boot(options);
    const sizes: number[] = [];
    a.createNamespace('/raw', { raw: true }).on('connection', socket => {
      socket.on('message', (text: string) => {
        sizes.push(text.length);
        socket.send?.('ok');
      });
    });
    return { port, sizes };
  }

  it('defaults to 1 MiB: a larger frame closes the connection with 1009', async () => {
    const { port, sizes } = await echo({});

    const within = await connect(port, '/ws/raw');
    within.ws.send('x'.repeat(MIB));
    await waitFor(() => within.frames.length === 1, {
      description: 'the 1 MiB frame to be answered',
    });
    expect(sizes).toEqual([MIB]);

    const over = await connect(port, '/ws/raw');
    over.ws.send('x'.repeat(MIB + 1));
    expect((await over.closed).code).toBe(1009);
    expect(sizes).toEqual([MIB]);
  });

  it('honours a configured maxPayloadLength', async () => {
    const { port, sizes } = await echo({ maxPayloadLength: 4 * MIB });
    const client = await connect(port, '/ws/raw');
    client.ws.send('x'.repeat(2 * MIB));
    await waitFor(() => client.frames.length === 1, {
      description: 'the 2 MiB frame to be answered',
    });
    expect(sizes).toEqual([2 * MIB]);
  });

  it('honours a smaller configured maxPayloadLength', async () => {
    const { port, sizes } = await echo({ maxPayloadLength: 16 });
    const tiny = await connect(port, '/ws/raw');
    tiny.ws.send('x'.repeat(17));
    expect((await tiny.closed).code).toBe(1009);
    expect(sizes).toEqual([]);
  });
});
