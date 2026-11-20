/* eslint-disable */
// @ts-nocheck
// Integration Tests - integrated WebSocket support on the native engine path.
// WebSocket upgrades are served on the HTTP port itself, by the engine.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
// The global WebSocket client only exists on Node >= 21; use the ws package so this test runs on the full CI matrix (Node 20+). Its client supports the same onopen/onerror handler style.
import { WebSocket } from 'ws';
import net from 'node:net';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { logger } from '../../src/core/logger/index.js';
import { EngineWebSocketAdapter } from '../../src/core/networking/adapters/engine-adapter.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { closeApp, createTestPort, waitFor } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const testPort = () => createTestPort();

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// Resolves true on open, false on error/close-before-open, times out otherwise.
// Both call sites assert the positive outcome, so a generous timeout only ever
// helps: it costs nothing on a green run and absorbs the CPU contention of a
// loaded coverage run rather than reporting a false negative.
const tryConnect = (url: string, timeoutMs = 15000): Promise<boolean> =>
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
const roundtrip = (url: string, out: any, timeoutMs = 15000): Promise<any> =>
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

// A client that records what it is sent: every { event, data } envelope, and
// the close code once the server (or the client) closes.
const openClient = (url: string, options: any = {}) => {
  const ws = new WebSocket(url, options);
  const frames: any[] = [];
  ws.on('message', (data: any) => frames.push(JSON.parse(data.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const closed = new Promise<number>(resolve => ws.once('close', (code: number) => resolve(code)));
  return { ws, frames, opened, closed };
};

// Log entries written while a test runs, read from an output added to the
// global logger (framework loggers share its outputs). The app under test
// sets the level it needs through its `logger` option.
const CAPTURE = 'engine-websocket-capture';
const captureLogs = () => {
  const entries: { level: string; message: string }[] = [];
  logger.addOutput({
    name: CAPTURE,
    write: (entry: any) => {
      entries.push({ level: entry.level, message: String(entry.message) });
    },
  } as any);
  return {
    entries,
    matching: (pattern: RegExp, level?: string) =>
      entries.filter(e => pattern.test(e.message) && (!level || e.level === level)),
  };
};
const stopCapture = () => {
  logger.removeOutput(CAPTURE);
  logger.setLevel('error');
};

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

  it('names the websocket option when app.websocket() is used without enabling WebSockets', async () => {
    // No `websocket` option: WebSockets are off and no adapter is set up.
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });
    app.websocket('/chat', { message: () => 'ok' });

    const failure = await new Promise<Error>((resolve, reject) => {
      app.on('error', resolve);
      app.listen(testPort(), () => reject(new Error('listen() succeeded')));
    });

    // The first line is the documented one; the rest says why and what to set.
    expect(failure.message).toMatch(/^WebSocket features require a WebSocket adapter\./);
    expect(failure.message).toContain("'/chat'");
    expect(failure.message).toContain('WebSockets are not enabled');
    expect(failure.message).toContain('createApp({ websocket: { enabled: true } })');
    // It must not send the reader off to install a package they do not need
    expect(failure.message).not.toContain('npm install');
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

  it('a handler that throws synchronously answers with the error envelope and keeps the socket', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro' },
      websocket: {},
    });
    const errors: any[] = [];
    app.on('websocket:error', (e: any) => errors.push(e));
    app.websocket('/', {
      boom: () => {
        throw new Error('sync failure');
      },
      ping: (_socket: any, data: any) => ({ echo: data }),
    });
    const port = testPort();
    await listen(app, port);

    // The throw takes the same path as a rejection: websocket:error fires
    // and the peer gets the error envelope (there is no callback here, so it
    // arrives as the 'error' event).
    const res = await roundtrip(`ws://localhost:${port}/`, {
      event: 'boom',
      data: 1,
      callback: true,
    });
    expect(res.event).toBe('boom:response');
    expect(res.data).toEqual({ success: false, error: 'sync failure' });
    expect(errors).toHaveLength(1);
    expect(errors[0].error.message).toBe('sync failure');

    // A synchronous return value is the response, settled without a tick.
    const ok = await roundtrip(`ws://localhost:${port}/`, {
      event: 'ping',
      data: 'z',
      callback: true,
    });
    expect(ok.event).toBe('ping:response');
    expect(ok.data).toEqual({ echo: 'z' });
  });

  it('runs the connection hook before the handler of a frame that arrives with the handshake', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro' },
      websocket: {},
    });
    const order: string[] = [];
    app.websocket('/secure', {
      connection: (socket: any) => {
        order.push('connection');
        if (socket.handshake?.query?.token !== 'ok') socket.disconnect();
      },
      secret: () => {
        order.push('secret');
        return { secret: 'classified' };
      },
    });
    const port = testPort();
    await listen(app, port);

    // A client need not wait for the 101: the handshake and its first frame
    // leave in one write, so the server reads them together.
    const payload = Buffer.from(JSON.stringify({ event: 'secret', data: null }));
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4])),
    ]);
    const handshake =
      'GET /secure HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';
    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let seen = Buffer.alloc(0);
      const finish = () => {
        socket.destroy();
        resolve(seen.toString('latin1'));
      };
      socket.on('connect', () => socket.write(Buffer.concat([Buffer.from(handshake), frame])));
      socket.on('data', chunk => {
        seen = Buffer.concat([seen, chunk]);
      });
      socket.on('close', finish);
      socket.on('error', reject);
      setTimeout(finish, 500);
    });

    expect(received).toContain('101');
    expect(order[0]).toBe('connection');
    // The socket the hook refused got no answer from a handler.
    expect(received).not.toContain('classified');
  });
});

describeEngine('Native engine WebSockets: socket.ip behind a proxy', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  // What a connection and a request from the same client report, with the
  // proxy's X-Forwarded-For on both
  async function addressesWith(server: any, options?: any) {
    resetConfig();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro', ...server },
      websocket: { enabled: true, ...(options ? { options } : {}) },
    });
    const seen: any = {};
    app.get('/ip', (req: any) => ({ ip: req.ip }));
    app.websocket('/who', {
      connection: (socket: any) => {
        seen.socketIp = socket.ip;
        seen.handshakeAddress = socket.handshake.address;
      },
    });
    const port = testPort();
    await listen(app, port);

    const forwarded = { 'X-Forwarded-For': '203.0.113.7, 198.51.100.4' };
    const reply = await fetch(`http://127.0.0.1:${port}/ip`, { headers: forwarded });
    seen.requestIp = (await reply.json()).ip;
    const client = openClient(`ws://127.0.0.1:${port}/who`, { headers: forwarded });
    await client.opened;
    await waitFor(() => seen.socketIp !== undefined, { description: 'the connection hook' });
    client.ws.terminate();
    await closeApp(app);
    app = null;
    return seen;
  }

  it('is the client req.ip names once server.trustProxy is set, and the peer without it', async () => {
    // The setting left out, and no proxy trusted: the connected peer
    const unset = await addressesWith({});
    expect(unset.socketIp).toBe(unset.requestIp);
    expect(unset.socketIp).not.toBe('198.51.100.4');
    expect(unset.socketIp).not.toBe('203.0.113.7');
    const peer = unset.socketIp;
    expect((await addressesWith({ trustProxy: false })).socketIp).toBe(peer);

    // One trusted proxy: the client is the last X-Forwarded-For entry
    const behindProxy = await addressesWith({ trustProxy: 1 });
    expect(behindProxy.requestIp).toBe('198.51.100.4');
    expect(behindProxy.socketIp).toBe('198.51.100.4');
    expect(behindProxy.handshakeAddress).toBe('198.51.100.4');

    // With a handshake check the server makes the upgrade itself, and
    // verifyClient is told the same client; the socket is still the peer's
    const told: any = {};
    const checked = await addressesWith(
      { trustProxy: 1 },
      {
        verifyClient: (info: any) => {
          told.ip = info.req.ip;
          told.remoteAddress = info.req.socket.remoteAddress;
          return true;
        },
      }
    );
    expect(checked.socketIp).toBe('198.51.100.4');
    expect(told).toEqual({ ip: '198.51.100.4', remoteAddress: peer });
  });
});

describeEngine('Native engine WebSockets: namespace middleware', () => {
  let app: any;
  let port: number;
  let adapter: any;
  const clients: any[] = [];

  const boot = async (level = 'fatal') => {
    app = await createApp({
      logger: { level },
      server: { engine: 'moro' },
      websocket: { enabled: true },
    });
    port = testPort();
    await listen(app, port);
    adapter = app.core.getWebSocketAdapter();
    expect(adapter.getAdapterName()).toBe('@morojs/engine');
  };
  const connect = async (path: string, options?: any) => {
    const client = openClient(`ws://localhost:${port}${path}`, options);
    clients.push(client);
    await client.opened;
    return client;
  };

  afterEach(async () => {
    stopCapture();
    for (const client of clients.splice(0)) {
      try {
        client.ws.terminate();
      } catch {}
    }
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('a socket whose middleware has not finished gets no broadcast and is not listed', async () => {
    await boot();
    const ns = adapter.createNamespace('/members');
    let release: any;
    let joined = 0;
    ns.use((_socket: any, next: any) => {
      release = next;
    });
    ns.on('connection', () => {
      joined++;
    });

    // The handshake is answered before the middleware runs, so the client is
    // open while the verdict is still outstanding.
    const client = await connect('/members');
    await waitFor(() => release !== undefined, { description: 'the middleware call' });

    ns.emit('members-only', { n: 1 });
    ns.to('lobby').emit('members-only', { n: 2 });
    expect(ns.getSockets()).toHaveLength(0);
    expect(ns.getConnectionCount()).toBe(0);
    expect(adapter.getConnectionCount()).toBe(0);
    expect(joined).toBe(0);

    release();
    expect(joined).toBe(1);
    expect(ns.getSockets()).toHaveLength(1);
    expect(adapter.getConnectionCount()).toBe(1);
    ns.emit('after-joining', { n: 3 });
    await waitFor(() => client.frames.length > 0, { description: 'the broadcast after joining' });
    // The first frame the client ever received is the one sent after it joined
    expect(client.frames).toEqual([{ event: 'after-joining', data: { n: 3 } }]);
  });

  it('a middleware that throws, or whose promise rejects, closes the socket as next(err) does', async () => {
    const logs = captureLogs();
    await boot('error');
    const kinds: Record<string, any> = {
      '/refuses': (_socket: any, next: any) => next(new Error('not allowed')),
      '/throws': () => {
        throw new Error('token parser failed');
      },
      '/rejects': async () => {
        throw new Error('token service down');
      },
    };
    const joined: string[] = [];
    for (const [path, middleware] of Object.entries(kinds)) {
      const ns = adapter.createNamespace(path);
      ns.use(middleware);
      ns.on('connection', () => joined.push(path));
    }

    const codes: Record<string, number> = {};
    for (const path of Object.keys(kinds)) {
      const client = await connect(path);
      codes[path] = await client.closed;
      adapter.createNamespace(path).emit('members-only', { n: 1 });
      expect(client.frames).toEqual([]);
    }
    // One close code for all three ways of refusing
    expect(codes['/refuses']).toBe(1000);
    expect(codes).toEqual({ '/refuses': 1000, '/throws': 1000, '/rejects': 1000 });
    expect(joined).toEqual([]);
    await waitFor(() => adapter.getConnectionCount() === 0, { description: 'adapter cleanup' });
    expect(adapter.createNamespace('/throws').getSockets()).toHaveLength(0);

    // A middleware that fails is reported once per namespace as an error;
    // a refusal through next(err) is not an error.
    const again = await connect('/throws');
    expect(await again.closed).toBe(1000);
    expect(logs.matching(/refused by namespace middleware \(\/throws\)/, 'error')).toHaveLength(1);
    expect(logs.matching(/refused by namespace middleware \(\/rejects\)/, 'error')).toHaveLength(1);
    expect(logs.matching(/refused by namespace middleware \(\/refuses\)/)).toHaveLength(0);
  });

  it('a socket that closes while its middleware is running never joins', async () => {
    await boot();
    const ns = adapter.createNamespace('/slow');
    let release: any;
    let joined = 0;
    let disconnected = false;
    ns.use((socket: any, next: any) => {
      socket.on('disconnect', () => {
        disconnected = true;
      });
      release = next;
    });
    ns.on('connection', () => {
      joined++;
    });

    const client = await connect('/slow');
    await waitFor(() => release !== undefined, { description: 'the middleware call' });
    client.ws.close();
    await waitFor(() => disconnected, { description: 'the close reaching the server' });

    release();
    expect(joined).toBe(0);
    expect(ns.getSockets()).toHaveLength(0);
    expect(adapter.getConnectionCount()).toBe(0);
  });

  it('a middleware that calls next() twice lets the socket join once', async () => {
    await boot();
    const ns = adapter.createNamespace('/twice');
    const order: string[] = [];
    ns.use((_socket: any, next: any) => {
      next();
      next();
    });
    ns.use((_socket: any, next: any) => {
      order.push('second middleware');
      next();
    });
    ns.on('connection', () => order.push('connection'));

    await connect('/twice');
    await waitFor(() => order.includes('connection'), { description: 'the connection handler' });
    expect(order).toEqual(['second middleware', 'connection']);
    expect(ns.getSockets()).toHaveLength(1);
  });
});

describeEngine('Native engine WebSockets: each namespace has its own sockets and rooms', () => {
  let app: any;
  let port: number;
  let adapter: any;
  const clients: any[] = [];

  // The same handlers on /staff, /public and the default namespace '/'.
  const boot = async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'moro' },
      websocket: { enabled: true },
    });
    for (const name of ['/staff', '/public', '/']) {
      app.websocket(name, {
        'join-room': (socket: any, data: any) => {
          socket.join(data.room);
          return { joined: data.room };
        },
        announce: (socket: any, data: any) => {
          socket.broadcast.emit('announcement', { from: name, text: data });
          return { sent: true };
        },
        'tell-room': (socket: any, data: any) => {
          socket.to(data.room).emit('room-message', { from: name, text: data.text });
          return { sent: true };
        },
        ping: (_socket: any, data: any) => ({ pong: data }),
      });
    }
    port = testPort();
    await listen(app, port);
    adapter = app.core.getWebSocketAdapter();
    expect(adapter.getAdapterName()).toBe('@morojs/engine');
  };
  const connect = async (path: string) => {
    const client = openClient(`ws://localhost:${port}${path}`);
    clients.push(client);
    await client.opened;
    return client;
  };
  // Two sockets on /staff, one on /public, one on '/', and one on a path no
  // namespace is registered for.
  const connectAll = async () => {
    const staffA = await connect('/staff');
    const staffB = await connect('/staff');
    const visitor = await connect('/public');
    const root = await connect('/');
    const stray = await connect('/no-such-namespace');
    await waitFor(() => adapter.getConnectionCount() === 5, { description: 'five sockets joined' });
    return { staffA, staffB, visitor, root, stray };
  };
  // Send one envelope and wait for the handler's reply.
  const call = async (client: any, event: string, data: any) => {
    const from = client.frames.length;
    client.ws.send(JSON.stringify({ event, data }));
    await waitFor(
      () => client.frames.slice(from).some((f: any) => f.event === `${event}:response`),
      { description: `the reply to ${event}` }
    );
  };
  // Frames on one socket arrive in order, so once every client has had the
  // reply to a ping, anything emitted to it before that has arrived too.
  const settle = (all: Record<string, any>) =>
    Promise.all(Object.values(all).map(client => call(client, 'ping', 0)));
  // What each client was sent, apart from replies to its own calls.
  const heard = (all: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(all).map(([name, client]) => [
        name,
        client.frames.filter((f: any) => !f.event.endsWith(':response')),
      ])
    );
  const nobody = { staffA: [], staffB: [], visitor: [], root: [], stray: [] };

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        client.ws.terminate();
      } catch {}
    }
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('namespace.emit() reaches the sockets of that namespace only', async () => {
    await boot();
    const all = await connectAll();

    adapter.createNamespace('/staff').emit('tick', 1);
    await settle(all);
    const tick = { event: 'tick', data: 1 };
    expect(heard(all)).toEqual({ ...nobody, staffA: [tick], staffB: [tick] });

    // A path with no namespace of its own is served by the default namespace:
    // its socket is a member of '/', and of nothing else.
    adapter.getDefaultNamespace().emit('root-tick', 2);
    await settle(all);
    const rootTick = { event: 'root-tick', data: 2 };
    expect(heard(all)).toEqual({
      ...nobody,
      staffA: [tick],
      staffB: [tick],
      root: [rootTick],
      stray: [rootTick],
    });
  });

  it('namespace.to(room) and except(room): a room belongs to its namespace, whatever its name', async () => {
    await boot();
    const all = await connectAll();
    // The same room name joined in three namespaces
    await call(all.staffA, 'join-room', { room: 'ops' });
    await call(all.visitor, 'join-room', { room: 'ops' });
    await call(all.root, 'join-room', { room: 'ops' });

    adapter.createNamespace('/staff').to('ops').emit('staff-ops', 1);
    adapter.createNamespace('/public').to('ops').emit('public-ops', 2);
    adapter.createNamespace('/staff').except('ops').emit('staff-rest', 3);
    await settle(all);
    expect(heard(all)).toEqual({
      ...nobody,
      staffA: [{ event: 'staff-ops', data: 1 }],
      staffB: [{ event: 'staff-rest', data: 3 }],
      visitor: [{ event: 'public-ops', data: 2 }],
    });
  });

  it('getSockets() and getConnectionCount() cover one namespace; the adapter count covers all', async () => {
    await boot();
    await connectAll();
    const paths = (name: string) =>
      adapter
        .createNamespace(name)
        .getSockets()
        .map((s: any) => s.path)
        .sort();

    expect(paths('/staff')).toEqual(['/staff', '/staff']);
    expect(paths('/public')).toEqual(['/public']);
    expect(paths('/')).toEqual(['/', '/no-such-namespace']);
    expect(adapter.createNamespace('/staff').getConnectionCount()).toBe(2);
    expect(adapter.createNamespace('/public').getConnectionCount()).toBe(1);
    expect(adapter.getDefaultNamespace().getConnectionCount()).toBe(2);
    expect(adapter.getConnectionCount()).toBe(5);

    // A socket that leaves is gone from its own namespace's list
    clients[0].ws.close();
    await waitFor(() => adapter.getConnectionCount() === 4, { description: 'the close' });
    expect(paths('/staff')).toEqual(['/staff']);
    expect(paths('/')).toEqual(['/', '/no-such-namespace']);
  });

  it("socket.broadcast reaches the other sockets of the sender's namespace only", async () => {
    await boot();
    const all = await connectAll();

    await call(all.staffA, 'announce', 'rota');
    await settle(all);
    expect(heard(all)).toEqual({
      ...nobody,
      staffB: [{ event: 'announcement', data: { from: '/staff', text: 'rota' } }],
    });

    // From the socket on the unregistered path: it is in '/', so '/' hears it
    await call(all.stray, 'announce', 'hello');
    await settle(all);
    expect(heard(all).root).toEqual([
      { event: 'announcement', data: { from: '/', text: 'hello' } },
    ]);
    expect(heard(all).visitor).toEqual([]);
    expect(heard(all).staffA).toEqual([]);
  });

  it("socket.to(room) reaches the room's members in the sender's namespace only", async () => {
    await boot();
    const all = await connectAll();
    await call(all.staffB, 'join-room', { room: 'ops' });
    await call(all.visitor, 'join-room', { room: 'ops' });
    await call(all.root, 'join-room', { room: 'ops' });
    await call(all.stray, 'join-room', { room: 'ops' });

    await call(all.staffA, 'tell-room', { room: 'ops', text: 'pager' });
    await settle(all);
    expect(heard(all)).toEqual({
      ...nobody,
      staffB: [{ event: 'room-message', data: { from: '/staff', text: 'pager' } }],
    });
  });
});

describeEngine('Native engine WebSockets: options this adapter does not apply', () => {
  let app: any;
  const NOT_APPLIED = /is set but is not applied by the native engine WebSocket adapter/;

  afterEach(async () => {
    stopCapture();
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('says so once at start-up for each one that is set, and goes on accepting the connection', async () => {
    const logs = captureLogs();
    app = await createApp({
      logger: { level: 'warn' },
      server: { engine: 'moro' },
      websocket: {
        enabled: true,
        options: {
          maxPayloadLength: 2048,
          idleTimeout: 30,
          path: '/ws',
        },
      },
    });
    app.websocket('/chat', { size: (_socket: any, data: any) => ({ size: data.length }) });
    const port = testPort();
    await listen(app, port);
    const adapter = app.core.getWebSocketAdapter();
    expect(adapter.getAdapterName()).toBe('@morojs/engine');

    const warned = (option: RegExp) =>
      logs.matching(NOT_APPLIED, 'warn').filter(e => option.test(e.message));
    expect(warned(/^websocket\.options\.maxPayloadLength \(2048\) /)).toHaveLength(1);
    expect(warned(/^websocket\.options\.idleTimeout /)).toHaveLength(1);
    expect(warned(/^websocket\.options\.path /)).toHaveLength(1);
    expect(logs.matching(NOT_APPLIED)).toHaveLength(3);
    expect(warned(/maxPayloadLength/)[0].message).toContain('server.limits.wsMaxMessageSize');

    // Nothing about the connection changed: another origin is upgraded, a
    // message over maxPayloadLength is answered, and the namespace is at its
    // own path.
    const res = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/chat`, { origin: 'https://other.example' });
      ws.onopen = () => ws.send(JSON.stringify({ event: 'size', data: 'x'.repeat(4096) }));
      ws.onmessage = (ev: any) => {
        ws.close();
        resolve(JSON.parse(ev.data.toString()));
      };
      ws.onerror = () => reject(new Error('ws error'));
    });
    expect(res).toEqual({ event: 'size:response', data: { size: 4096 } });
  });

  it('says nothing when none is set, or when the message size limit is in force', async () => {
    // Closing an app drops the logger's outputs: each app gets its own capture
    let logs = captureLogs();
    const closeAndCaptureAgain = async () => {
      await closeApp(app);
      resetConfig();
      stopCapture();
      logs = captureLogs();
    };
    // No handshake check is registered either: wherever the engine can
    // answer handshakes by itself it still does, and any origin is upgraded.
    const unchecked = async (port: number) => {
      const server = app.core.httpServer;
      expect(server._wsBridge.verifyUpgrade).toBeUndefined();
      expect(server._wsAutoOn).toBe(typeof server._setWsAutoUpgrade === 'function');
      const client = openClient(`ws://localhost:${port}/`, { origin: 'https://other.example' });
      await client.opened;
      client.ws.terminate();
      expect(logs.entries.filter(e => e.level === 'warn')).toEqual([]);
    };

    app = await createApp({
      logger: { level: 'warn' },
      server: { engine: 'moro' },
      websocket: { enabled: true },
    });
    let quietPort = testPort();
    await listen(app, quietPort);
    expect(logs.matching(NOT_APPLIED)).toEqual([]);
    await unchecked(quietPort);
    await closeAndCaptureAgain();

    // An allow-all origin asks for what the adapter does anyway, and
    // enforceHandshakeChecks has nothing to act on
    for (const options of [
      { cors: { origin: '*' } },
      { cors: { origin: true }, enforceHandshakeChecks: false },
    ]) {
      app = await createApp({
        logger: { level: 'warn' },
        server: { engine: 'moro' },
        websocket: { enabled: true, options },
      });
      quietPort = testPort();
      await listen(app, quietPort);
      expect(logs.matching(NOT_APPLIED)).toEqual([]);
      await unchecked(quietPort);
      await closeAndCaptureAgain();
    }

    // The engine's own limit set to the same value: the cap is applied, so
    // there is nothing to report.
    app = await createApp({
      logger: { level: 'warn' },
      server: { engine: 'moro', limits: { wsMaxMessageSize: 2048 } },
      websocket: { enabled: true, options: { maxPayloadLength: 2048 } },
    });
    app.websocket('/chat', { size: (_socket: any, data: any) => ({ size: data.length }) });
    const port = testPort();
    await listen(app, port);
    expect(logs.matching(NOT_APPLIED)).toEqual([]);

    const client = openClient(`ws://localhost:${port}/chat`);
    await client.opened;
    client.ws.send(JSON.stringify({ event: 'size', data: 'x'.repeat(4096) }));
    expect(await client.closed).toBe(1009);
  });
});

describeEngine('Native engine WebSockets: websocket.compression', () => {
  let app: any;
  let port: number;
  const clients: any[] = [];
  const engine: any = loadNativeEngine();
  const NOT_APPLIED =
    /^websocket\.compression is set but is not applied by the native engine WebSocket adapter/;
  // About 230 KB of JSON that deflates to a few percent of its size
  const rows = Array.from({ length: 4000 }, (_, i) => ({
    id: i,
    name: 'subscriber',
    active: true,
    tags: ['alpha', 'beta'],
  }));
  const rowsBytes = Buffer.byteLength(JSON.stringify(rows));

  // Whether the loaded engine compresses with one stream shared by all its
  // connections: @morojs/engine 1.1.2 and later do, when handed
  // sharedCompressor; 1.1.0 and 1.1.1 have no such option, ignore it and keep
  // a compressor per connection. undefined when the version is not known.
  const sharesCompressor = (): boolean | undefined => {
    const version = app.engine?.engineVersion ?? engine.module.probe?.()?.version;
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
    if (!parts) return undefined;
    const [major, minor, patch] = parts.slice(1).map(Number);
    return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 2)));
  };

  // The options object the engine's serve() was last called with.
  const watchServeOptions = () => {
    const serve = jest.spyOn(engine.module, 'serve');
    return () => serve.mock.calls[serve.mock.calls.length - 1]?.[1] as any;
  };
  const boot = async (websocket: any, server: any = {}, level = 'fatal') => {
    app = await createApp({
      logger: { level },
      server: { engine: 'moro', ...server },
      websocket: { enabled: true, ...websocket },
    });
    app.websocket('/echo', { echo: (_socket: any, data: any) => data });
    port = testPort();
    await listen(app, port);
    expect(app.core.getWebSocketAdapter().getAdapterName()).toBe('@morojs/engine');
  };
  const shutdown = async () => {
    for (const client of clients.splice(0)) {
      try {
        client.ws.terminate();
      } catch {}
    }
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  };
  // `offer` is whether the client's handshake carries permessage-deflate;
  // `accepted` is the Sec-WebSocket-Extensions header of the server's answer.
  const connect = async (offer: boolean) => {
    const client: any = openClient(`ws://localhost:${port}/echo`, { perMessageDeflate: offer });
    client.ws.once('upgrade', (res: any) => {
      client.accepted = res.headers['sec-websocket-extensions'];
    });
    clients.push(client);
    await client.opened;
    return client;
  };
  // Send `data` to the echo handler; resolves with the reply and the bytes
  // the exchange put on the connection in each direction.
  const echo = async (client: any, data: any) => {
    const socket = client.ws._socket;
    const before = { sent: socket.bytesWritten, received: socket.bytesRead };
    const from = client.frames.length;
    client.ws.send(JSON.stringify({ event: 'echo', data }));
    await waitFor(() => client.frames.length > from, { description: 'the echo' });
    return {
      reply: client.frames[from],
      sent: socket.bytesWritten - before.sent,
      received: socket.bytesRead - before.received,
    };
  };

  afterEach(async () => {
    jest.restoreAllMocks();
    stopCapture();
    await shutdown();
  });

  it('negotiates permessage-deflate with a client that offers it, and with no other', async () => {
    const logs = captureLogs();
    const handed = watchServeOptions();
    await boot({ compression: true }, {}, 'warn');
    // No message limit is configured: the engine applies its own to an
    // inflated message, and nothing is said about the option at start-up.
    expect(handed().wsDeflate).toEqual({ sharedCompressor: true });
    expect(logs.matching(NOT_APPLIED)).toEqual([]);

    const offering = await connect(true);
    expect(offering.ws.extensions).toBe('permessage-deflate');
    expect(offering.accepted).toMatch(/^permessage-deflate\b/);
    // Where the engine has the shared compressor, the server compresses each
    // message by itself (one compressor for the server, not one kept per
    // connection) and its answer says so; where it has not, the answer does not.
    const shared = sharesCompressor();
    if (shared !== undefined) {
      expect(/\bserver_no_context_takeover\b/.test(offering.accepted)).toBe(shared);
    }
    const compressed = await echo(offering, rows);
    expect(compressed.reply).toEqual({ event: 'echo:response', data: rows });
    // Compressed on the way in and on the way out
    expect(compressed.sent).toBeLessThan(rowsBytes / 5);
    expect(compressed.received).toBeLessThan(rowsBytes / 5);
    // A frame the server sends by itself is compressed like a reply
    const socket = offering.ws._socket;
    const receivedBefore = socket.bytesRead;
    app.core.getWebSocketAdapter().createNamespace('/echo').emit('rows', rows);
    await waitFor(() => offering.frames.length === 2, { description: 'the broadcast' });
    expect(offering.frames[1]).toEqual({ event: 'rows', data: rows });
    expect(socket.bytesRead - receivedBefore).toBeLessThan(rowsBytes / 5);
    // A short message goes through the same connection as it is
    expect((await echo(offering, { n: 1 })).reply).toEqual({
      event: 'echo:response',
      data: { n: 1 },
    });

    // The same server, a client that does not offer the extension: no
    // extension in the answer, and every byte of the message on the wire.
    const plain = await connect(false);
    expect(plain.ws.extensions).toBe('');
    expect(plain.accepted).toBeUndefined();
    const uncompressed = await echo(plain, rows);
    expect(uncompressed.reply).toEqual({ event: 'echo:response', data: rows });
    expect(uncompressed.sent).toBeGreaterThan(rowsBytes);
    expect(uncompressed.received).toBeGreaterThan(rowsBytes);
  });

  it('is off unless websocket.compression is true', async () => {
    const handed = watchServeOptions();
    for (const [websocket, negotiated] of [
      [{ compression: true }, true],
      [{}, false],
      [{ compression: false }, false],
      // Among the adapter options, where the Socket.IO and ws adapters read it
      [{ options: { compression: true } }, true],
    ] as Array<[any, boolean]>) {
      await boot(websocket);
      // The engine is asked for the extension only when the option is set
      expect('wsDeflate' in handed()).toBe(negotiated);
      const client = await connect(true);
      expect(client.ws.extensions).toBe(negotiated ? 'permessage-deflate' : '');
      expect(client.accepted === undefined).toBe(!negotiated);
      const { reply, received } = await echo(client, rows);
      expect(reply).toEqual({ event: 'echo:response', data: rows });
      expect(received > rowsBytes).toBe(!negotiated);
      await shutdown();
    }
  });

  it('closes with 1009 a connection whose message inflates past the message limit', async () => {
    const handed = watchServeOptions();
    const limit = 64 * 1024;
    await boot({ compression: true }, { limits: { wsMaxMessageSize: limit } });
    // One number is both the limit on a message as it arrives and the limit
    // on what it may inflate to
    expect(handed().wsMaxMessageSize).toBe(limit);
    expect(handed().wsDeflate).toEqual({ sharedCompressor: true, maxDecompressedSize: limit });

    // Under the limit once inflated: answered
    const client = await connect(true);
    expect(client.ws.extensions).toBe('permessage-deflate');
    const small = rows.slice(0, 500);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(limit);
    expect((await echo(client, small)).reply).toEqual({ event: 'echo:response', data: small });

    // A fraction of the limit on the wire, several times the limit inflated
    expect(rowsBytes).toBeGreaterThan(3 * limit);
    const socket = client.ws._socket;
    const sentBefore = socket.bytesWritten;
    client.ws.send(JSON.stringify({ event: 'echo', data: rows }));
    expect(await client.closed).toBe(1009);
    expect(socket.bytesWritten - sentBefore).toBeLessThan(limit / 2);
    expect(client.frames).toHaveLength(1);
  });

  it('warns that the option is not applied only where the engine cannot compress', async () => {
    // Closing an app drops the logger's outputs: each app gets its own capture
    let logs = captureLogs();
    const nextApp = async () => {
      await shutdown();
      stopCapture();
      logs = captureLogs();
    };
    const handed = watchServeOptions();
    const capabilities = engine.capabilities;
    const advertised = capabilities.wsDeflate;
    try {
      // An engine with permessage-deflate: applied, so there is nothing to say
      capabilities.wsDeflate = true;
      await boot({ compression: true }, {}, 'warn');
      expect(app.core.httpServer.wsCompression).toBe(true);
      expect(logs.matching(NOT_APPLIED)).toEqual([]);
      await nextApp();

      // An engine without it: served as before the option was wired
      capabilities.wsDeflate = false;
      await boot({ compression: true }, {}, 'warn');
      expect('wsDeflate' in handed()).toBe(false);
      expect(app.core.httpServer.wsCompression).toBe(false);
      // Asked for again later (WebSocketManager.enableCompression): still one line
      app.core.getWebSocketAdapter().setCompression(true);
      expect(logs.matching(NOT_APPLIED, 'warn').map(e => e.message)).toEqual([
        'websocket.compression is set but is not applied by the native engine WebSocket ' +
          'adapter: permessage-deflate is not negotiated and messages are sent uncompressed.',
      ]);
      const client = await connect(true);
      expect(client.ws.extensions).toBe('');
      expect((await echo(client, rows)).reply).toEqual({ event: 'echo:response', data: rows });
      await nextApp();

      // The engine has it, and compression is first asked for once the
      // server exists: too late for this server, and the line says where to
      // set it.
      capabilities.wsDeflate = true;
      await boot({}, {}, 'warn');
      expect(logs.matching(NOT_APPLIED)).toEqual([]);
      app.core.getWebSocketAdapter().setCompression(true);
      expect(logs.matching(NOT_APPLIED, 'warn').map(e => e.message)).toEqual([
        'websocket.compression is set but is not applied by the native engine WebSocket ' +
          'adapter: permessage-deflate is not negotiated and messages are sent uncompressed. ' +
          'It is turned on when the server is created: set websocket.compression in the ' +
          'app configuration.',
      ]);
    } finally {
      capabilities.wsDeflate = advertised;
    }
  });
});

describeEngine('Native engine WebSockets: handshake checks', () => {
  let app: any;
  let port: number;
  let adapter: any;
  let connections = 0;
  const sockets: any[] = [];
  const ALLOWED = 'https://app.example.com';
  const NOT_APPLIED = /is set but is not applied by the native engine WebSocket adapter/;
  const REPORT_ONLY = /^websocket\.options\.enforceHandshakeChecks is false: /;

  // The options reach the adapter as given: a test that wants
  // enforceHandshakeChecks names it, every other one runs on the default.
  const boot = async (options: any, level = 'fatal') => {
    connections = 0;
    app = await createApp({
      logger: { level },
      server: { engine: 'moro' },
      websocket: { enabled: true, options },
    });
    app.get('/plain', () => ({ plain: true }));
    app.websocket('/chat', {
      connection: () => {
        connections++;
      },
      ping: (_socket: any, data: any) => ({ pong: data }),
    });
    port = testPort();
    await listen(app, port);
    adapter = app.core.getWebSocketAdapter();
    expect(adapter.getAdapterName()).toBe('@morojs/engine');
  };

  // The answer to one handshake: 101 with the open socket, or the HTTP
  // status and body it was refused with.
  const attempt = (path: string, options: any = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`, options);
      sockets.push(ws);
      ws.once('open', () => resolve({ status: 101, ws }));
      ws.once('unexpected-response', (_req: any, res: any) => {
        let body = '';
        res.on('data', (chunk: any) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      ws.once('error', reject);
    });
  const ping = (ws: any): Promise<any> =>
    new Promise(resolve => {
      ws.once('message', (data: any) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ event: 'ping', data: 1 }));
    });

  afterEach(async () => {
    stopCapture();
    for (const ws of sockets.splice(0)) {
      try {
        ws.terminate();
      } catch {}
    }
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('upgrades an origin the rule allows, a same-origin request and a request without Origin', async () => {
    const logs = captureLogs();
    await boot({ cors: { origin: ALLOWED } }, 'warn');
    // Applied, so nothing is said about it at start-up
    expect(logs.matching(NOT_APPLIED)).toEqual([]);
    expect(logs.matching(REPORT_ONLY)).toEqual([]);
    expect(logs.matching(/cors\.origin|verifyClient/)).toEqual([]);

    const allowed = await attempt('/chat', { origin: ALLOWED });
    expect(allowed.status).toBe(101);
    expect(await ping(allowed.ws)).toEqual({ event: 'ping:response', data: { pong: 1 } });

    // The Origin's host is the Host header: the page was served by this server
    const sameOrigin = await attempt('/chat', { origin: `http://localhost:${port}` });
    expect(sameOrigin.status).toBe(101);
    // No Origin header: not a page in a browser
    const noOrigin = await attempt('/chat');
    expect(noOrigin.status).toBe(101);
    await waitFor(() => connections === 3, { description: 'three connection handlers' });
  });

  it('answers another origin 403 before the upgrade: it never becomes a WebSocket', async () => {
    const logs = captureLogs();
    let verifyCalls = 0;
    await boot(
      {
        cors: { origin: [ALLOWED, /\.trusted\.example$/] },
        verifyClient: () => {
          verifyCalls++;
          return true;
        },
      },
      'warn'
    );

    const refused = await attempt('/chat', { origin: 'https://other.example' });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ success: false, error: 'Forbidden' });
    expect(connections).toBe(0);
    expect(adapter.getConnectionCount()).toBe(0);
    // verifyClient is asked only about handshakes that passed the origin rule
    expect(verifyCalls).toBe(0);
    expect(
      logs.matching(
        /^Refused WebSocket handshake \(Origin not allowed; origin https:\/\/other\.example\)/,
        'warn'
      )
    ).toHaveLength(1);

    expect((await attempt('/chat', { origin: 'https://a.trusted.example' })).status).toBe(101);
    expect(verifyCalls).toBe(1);
    // The server goes on serving HTTP and WebSockets
    expect((await fetch(`http://localhost:${port}/plain`)).status).toBe(200);

    // enforceHandshakeChecks: true asks for the same thing
    await closeApp(app);
    resetConfig();
    await boot({ enforceHandshakeChecks: true, cors: { origin: ALLOWED } });
    expect((await attempt('/chat', { origin: 'https://other.example' })).status).toBe(403);
    expect((await attempt('/chat', { origin: ALLOWED })).status).toBe(101);
  });

  it('asks a function rule, which answers through its callback or its return value', async () => {
    await boot({
      cors: {
        origin: (origin: string, callback: any) => {
          if (origin.endsWith('.callback.example'))
            return callback(null, origin.startsWith('https://ok.'));
          return origin === ALLOWED;
        },
      },
    });
    expect((await attempt('/chat', { origin: 'https://ok.callback.example' })).status).toBe(101);
    expect((await attempt('/chat', { origin: 'https://no.callback.example' })).status).toBe(403);
    expect((await attempt('/chat', { origin: ALLOWED })).status).toBe(101);
    expect((await attempt('/chat', { origin: 'https://other.example' })).status).toBe(403);
  });

  it('lets verifyClient refuse with 401: false, a throw, a promise of false, a rejection', async () => {
    const seen: any[] = [];
    await boot({
      verifyClient: (info: any) => {
        seen.push({
          origin: info.origin,
          url: info.req.url,
          host: info.req.headers.host,
          token: info.req.headers['x-token'],
          address: typeof info.req.socket.remoteAddress,
          secure: info.secure,
        });
        const verdict = new URL(info.req.url, 'http://localhost').searchParams.get('v');
        if (verdict === 'false') return false;
        if (verdict === 'throw') throw new Error('token parser failed');
        if (verdict === 'later-true')
          return new Promise(resolve => setTimeout(() => resolve(true), 20));
        if (verdict === 'later-false')
          return new Promise(resolve => setTimeout(() => resolve(false), 20));
        if (verdict === 'reject') return Promise.reject(new Error('token service down'));
        return true;
      },
    });

    const accepted = await attempt('/chat?v=true', {
      origin: ALLOWED,
      headers: { 'X-Token': 't1' },
    });
    expect(accepted.status).toBe(101);
    // What a verifyClient written for the other adapters reads is there
    expect(seen).toEqual([
      {
        origin: ALLOWED,
        url: '/chat?v=true',
        host: `localhost:${port}`,
        token: 't1',
        address: 'string',
        secure: false,
      },
    ]);

    for (const verdict of ['false', 'throw', 'later-false', 'reject']) {
      const refused = await attempt(`/chat?v=${verdict}`);
      expect([verdict, refused.status]).toEqual([verdict, 401]);
      expect(JSON.parse(refused.body)).toEqual({ success: false, error: 'Unauthorized' });
    }
    expect(connections).toBe(1);
    expect(adapter.getConnectionCount()).toBe(1);

    // A verdict that arrives later still upgrades, and the socket works
    const later = await attempt('/chat?v=later-true');
    expect(later.status).toBe(101);
    expect(await ping(later.ws)).toEqual({ event: 'ping:response', data: { pong: 1 } });
    expect(seen).toHaveLength(6);
  });

  it('answers a refused handshake that arrives pipelined between two requests, in its place', async () => {
    await boot({
      cors: { origin: ALLOWED },
      verifyClient: (info: any) =>
        info.req.url.includes('later')
          ? new Promise(resolve => setTimeout(() => resolve(false), 20))
          : true,
    });
    const plain = `GET /plain HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`;
    const handshake = (path: string, origin: string) =>
      `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
      'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      `Sec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`;
    // One write, three requests; the statuses come back in request order.
    const statuses = (bytes: string): Promise<number[]> =>
      new Promise((resolve, reject) => {
        const socket = net.connect(port, 'localhost');
        let received = '';
        socket.on('connect', () => socket.write(bytes));
        socket.on('data', chunk => {
          received += chunk.toString('latin1');
          const found = [...received.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(m => Number(m[1]));
          if (found.length === 3) {
            socket.destroy();
            resolve(found);
          }
        });
        socket.on('error', reject);
      });

    // Refused by the origin rule at once
    expect(await statuses(plain + handshake('/chat', 'https://other.example') + plain)).toEqual([
      200, 403, 200,
    ]);
    // Refused by a verifyClient that answers later: the request behind it waits
    expect(await statuses(plain + handshake('/chat?later', ALLOWED) + plain)).toEqual([
      200, 401, 200,
    ]);
    expect(connections).toBe(0);
  });

  it('with enforceHandshakeChecks: false upgrades a handshake that fails, and reports it', async () => {
    const logs = captureLogs();
    let verifyCalls = 0;
    await boot(
      {
        enforceHandshakeChecks: false,
        cors: { origin: ALLOWED },
        verifyClient: (info: any) => {
          verifyCalls++;
          const verdict = new URL(info.req.url, 'http://localhost').searchParams.get('v');
          if (verdict === 'throw') throw new Error('token parser failed');
          if (verdict === 'later-false')
            return new Promise(resolve => setTimeout(() => resolve(false), 20));
          return verdict !== 'false';
        },
      },
      'warn'
    );
    // One line at start-up names the mode and the two checks it covers
    expect(logs.matching(REPORT_ONLY, 'warn').map(e => e.message)).toEqual([
      'websocket.options.enforceHandshakeChecks is false: a handshake that fails ' +
        'websocket.options.cors.origin and websocket.options.verifyClient is logged and ' +
        'allowed, not refused. Remove the option to have it refused.',
    ]);
    expect(logs.matching(NOT_APPLIED)).toEqual([]);

    // Another origin: upgraded, and the socket works. verifyClient is asked
    // only about a handshake that passed the origin rule, as when refusing.
    const foreign = await attempt('/chat', { origin: 'https://other.example' });
    expect(foreign.status).toBe(101);
    expect(await ping(foreign.ws)).toEqual({ event: 'ping:response', data: { pong: 1 } });
    expect(verifyCalls).toBe(0);
    for (const verdict of ['false', 'throw', 'later-false']) {
      const allowed = await attempt(`/chat?v=${verdict}`, { origin: ALLOWED });
      expect([verdict, allowed.status]).toEqual([verdict, 101]);
    }
    expect(verifyCalls).toBe(3);
    await waitFor(() => connections === 4, { description: 'four connection handlers' });

    const reported = logs
      .matching(/^WebSocket handshake failed a check but was ALLOWED /, 'warn')
      .map(e => e.message);
    const tail = ': websocket.options.enforceHandshakeChecks is false';
    expect(reported).toEqual([
      `WebSocket handshake failed a check but was ALLOWED (Origin not allowed; origin https://other.example)${tail}`,
      `WebSocket handshake failed a check but was ALLOWED (verifyClient refused the handshake; origin ${ALLOWED})${tail}`,
      `WebSocket handshake failed a check but was ALLOWED (verifyClient threw: token parser failed; origin ${ALLOWED})${tail}`,
      `WebSocket handshake failed a check but was ALLOWED (verifyClient refused the handshake; origin ${ALLOWED})${tail}`,
    ]);
    expect(logs.matching(/^Refused WebSocket handshake/)).toEqual([]);
  });
});

describeEngine('Native engine WebSockets: repeated log lines', () => {
  let app: any;

  afterEach(async () => {
    stopCapture();
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('logs the first non-JSON text frame of a connection and the total when it closes', async () => {
    const logs = captureLogs();
    app = await createApp({
      logger: { level: 'warn' },
      server: { engine: 'moro' },
      websocket: { enabled: true },
    });
    app.websocket('/chat', { ping: (_socket: any, data: any) => ({ pong: data }) });
    const port = testPort();
    await listen(app, port);

    const client = openClient(`ws://localhost:${port}/chat`);
    await client.opened;
    for (let i = 0; i < 40; i++) client.ws.send('not json');
    client.ws.send(JSON.stringify({ event: 'ping', data: 1 }));
    await waitFor(() => client.frames.length === 1, {
      description: 'the reply after the bad frames',
    });
    // The bad frames are ignored and the connection keeps working, as before
    expect(client.frames).toEqual([{ event: 'ping:response', data: { pong: 1 } }]);

    const lines = () => logs.matching(/Non-JSON message/, 'warn');
    expect(lines()).toHaveLength(1);
    expect(lines()[0].message).toMatch(/^Non-JSON message from \S+ /);

    client.ws.close();
    await waitFor(() => lines().length === 2, { description: 'the total at close' });
    expect(lines()[1].message).toMatch(/^Non-JSON messages from \S+: 40 in total/);
  });
});

// The engine reports backpressure through the return value of wsSend(); a
// stand-in server that always reports it drives the adapter directly.
describe('Engine WebSocket adapter: sends under backpressure', () => {
  afterEach(() => stopCapture());

  it('logs the first one of a connection and the total when it closes', async () => {
    const logs = captureLogs();
    logger.setLevel('warn');
    let bridge: any;
    const sent: any[] = [];
    const server = {
      enableWebSocket: (b: any) => {
        bridge = b;
      },
      wsSend: (_wsId: number, data: any) => {
        sent.push(data);
        return false;
      },
      wsClose: () => {},
    };
    const adapter = new EngineWebSocketAdapter();
    await adapter.initialize(server);
    let socket: any;
    adapter.getDefaultNamespace().on('connection', (s: any) => {
      socket = s;
    });
    bridge.onOpen(1, '/', { ip: '127.0.0.1', flat: [], query: '' });

    for (let i = 0; i < 20; i++) socket.emit('tick', { i });
    for (let i = 0; i < 5; i++) socket.send('raw');
    // Every frame was still handed to the engine
    expect(sent).toHaveLength(25);

    const lines = () => logs.matching(/^Backpressure for connection /, 'warn');
    expect(lines()).toHaveLength(1);

    bridge.onClose(1, 1000);
    expect(lines()).toHaveLength(2);
    expect(lines()[1].message).toMatch(/: 25 sends in total$/);

    // A connection with a single such send gets its one line and no total
    bridge.onOpen(2, '/', { ip: '127.0.0.1', flat: [], query: '' });
    socket.emit('tick', {});
    bridge.onClose(2, 1000);
    expect(lines()).toHaveLength(3);
  });
});
