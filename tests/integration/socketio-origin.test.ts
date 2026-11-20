// Integration - Socket.IO adapter: the configured origin allow-list and
// `verifyClient` decide the handshake on EVERY transport, and the message
// size limit is Socket.IO's own unless the application sets one.
//
// Socket.IO's `cors` option only shapes CORS headers for long-polling; a page
// on another origin can open the WebSocket transport directly and the browser
// attaches the victim's cookies. The adapter therefore enforces both in
// Engine.IO's `allowRequest`. These tests speak the Engine.IO wire protocol
// with a plain `ws` client / fetch, so the Origin header can be set freely.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { SocketIOAdapter } from '../../src/core/networking/adapters/index.js';
import type { WebSocketAdapterOptions } from '../../src/core/networking/websocket-adapter.js';
import { closeApp, createTestPort, waitFor } from '../setup.js';

interface Harness {
  port: number;
  adapter: SocketIOAdapter;
  /** sockets that reached the application's connection handler */
  connected: Array<{ cookie: string | undefined }>;
  /** what the adapter logged at WARN, from the start of initialize() on */
  warnings: string[];
}

let server: http.Server | undefined;
let adapter: SocketIOAdapter | undefined;

afterEach(async () => {
  await shutdown();
  jest.restoreAllMocks();
});

// The options reach the adapter as given: a test that wants
// `enforceHandshakeChecks` names it, every other one runs on the default.
async function boot(options: WebSocketAdapterOptions): Promise<Harness> {
  server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  adapter = new SocketIOAdapter();
  const warnings: string[] = [];
  jest.spyOn((adapter as any).ioLogger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(String(args[0]));
  });
  await adapter.initialize(server, options);
  const connected: Harness['connected'] = [];
  adapter.getDefaultNamespace().on('connection', socket => {
    connected.push({ cookie: socket.headers?.cookie });
    // answers with the size of what it was sent
    socket.on('size', (data: string) => socket.emit('sized', data.length));
  });
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, adapter, connected, warnings };
}

async function shutdown(): Promise<void> {
  await adapter?.close();
  adapter = undefined;
  server?.closeAllConnections();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
}

interface WsResult {
  /** true when the Engine.IO session opened and the namespace connect was acknowledged */
  accepted: boolean;
  /** HTTP status of a refused upgrade */
  status?: number;
}

/** Handshake on the WebSocket transport, then join the default namespace. */
function overWebSocket(port: number, headers: Record<string, string> = {}): Promise<WsResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
      headers,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('Socket.IO handshake timed out'));
    }, 5000);
    const finish = (result: WsResult) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
      resolve(result);
    };
    ws.on('message', data => {
      const packet = data.toString();
      if (packet.startsWith('0'))
        ws.send('40'); // Engine.IO open -> Socket.IO CONNECT
      else if (packet.startsWith('40')) finish({ accepted: true });
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      finish({
        accepted: false,
        ...(res.statusCode !== undefined ? { status: res.statusCode } : {}),
      });
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Handshake on the long-polling transport. */
async function overPolling(port: number, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
    headers,
  });
  const text = await res.text();
  return {
    status: res.status,
    accepted: res.status === 200 && text.startsWith('0{'),
    allowOrigin: res.headers.get('access-control-allow-origin'),
  };
}

const ALLOWED = 'https://app.example';
const FOREIGN = 'https://evil.example';

const NOTICE = /^websocket\.options\.enforceHandshakeChecks is false: /;

describe('Socket.IO adapter: enforceHandshakeChecks', () => {
  it('false lets a failing handshake through and says what would have been refused', async () => {
    let verifyCalls = 0;
    const { port, connected, warnings } = await boot({
      cors: { origin: ALLOWED, credentials: true },
      verifyClient: () => {
        verifyCalls++;
        return false;
      },
      enforceHandshakeChecks: false,
    });
    // One line at start-up names the mode and the two checks it covers
    expect(warnings.filter(m => NOTICE.test(m))).toEqual([
      'websocket.options.enforceHandshakeChecks is false: a handshake that fails ' +
        'websocket.options.cors.origin and websocket.options.verifyClient is logged and ' +
        'allowed, not refused. Remove the option to have it refused.',
    ]);
    warnings.length = 0;

    // Foreign origin: fails the origin rule, connects anyway, on both transports.
    expect((await overWebSocket(port, { Origin: FOREIGN })).accepted).toBe(true);
    expect((await overPolling(port, { Origin: FOREIGN })).accepted).toBe(true);
    // Allowed origin: passes the origin rule, fails verifyClient, connects anyway.
    expect((await overWebSocket(port, { Origin: ALLOWED })).accepted).toBe(true);
    expect(connected).toHaveLength(2);
    expect(verifyCalls).toBe(1);

    expect(warnings).toEqual([
      `Socket.IO handshake failed a check but was ALLOWED (Origin not allowed; origin ${FOREIGN}): ` +
        'websocket.options.enforceHandshakeChecks is false',
      `Socket.IO handshake failed a check but was ALLOWED (Origin not allowed; origin ${FOREIGN}): ` +
        'websocket.options.enforceHandshakeChecks is false',
      'Socket.IO handshake failed a check but was ALLOWED (verifyClient refused the handshake; ' +
        `origin ${ALLOWED}): websocket.options.enforceHandshakeChecks is false`,
    ]);
  });

  it('true refuses, as leaving it out does, and neither prints the start-up line', async () => {
    for (const flag of [{ enforceHandshakeChecks: true }, {}]) {
      const { port, connected, warnings } = await boot({ cors: { origin: ALLOWED }, ...flag });
      expect(warnings).toEqual([]);
      expect((await overWebSocket(port, { Origin: FOREIGN })).accepted).toBe(false);
      expect((await overPolling(port, { Origin: FOREIGN })).status).toBe(403);
      expect((await overWebSocket(port, { Origin: ALLOWED })).accepted).toBe(true);
      expect(connected).toHaveLength(1);
      // Each refusal is logged with its reason
      expect(warnings).toEqual([
        `Refused Socket.IO handshake (Origin not allowed; origin ${FOREIGN})`,
        `Refused Socket.IO handshake (Origin not allowed; origin ${FOREIGN})`,
      ]);
      await shutdown();
    }
  });

  it('logs the first twenty failed handshakes and then one in every 500', async () => {
    const { adapter: a, warnings } = await boot({ cors: { origin: ALLOWED } });
    const check = (a as any).io.engine.opts.allowRequest;
    for (let i = 0; i < 1000; i++) {
      check({ headers: { host: 'api.example', origin: FOREIGN }, socket: {} }, () => undefined);
    }
    expect(warnings).toHaveLength(22);
    expect(warnings[21]).toBe(
      `Refused Socket.IO handshake (Origin not allowed; origin ${FOREIGN}) (1000 so far)`
    );
  });
});

describe('Socket.IO adapter: cors.origin applies to every transport', () => {
  it('refuses a foreign origin on the WebSocket transport, cookie or not', async () => {
    const { port, connected } = await boot({ cors: { origin: ALLOWED, credentials: true } });

    const refused = await overWebSocket(port, { Origin: FOREIGN, Cookie: 'session=victim' });
    expect(refused.accepted).toBe(false);
    expect(refused.status).toBe(400);
    expect(connected).toHaveLength(0);

    const polling = await overPolling(port, { Origin: FOREIGN, Cookie: 'session=victim' });
    expect(polling.accepted).toBe(false);
    expect(polling.status).toBe(403);
    expect(connected).toHaveLength(0);
  });

  it('accepts the allowed origin, same-origin requests and requests without Origin', async () => {
    const { port, connected } = await boot({ cors: { origin: ALLOWED, credentials: true } });

    expect((await overWebSocket(port, { Origin: ALLOWED, Cookie: 'session=me' })).accepted).toBe(
      true
    );
    // non-browser client: no Origin header
    expect((await overWebSocket(port)).accepted).toBe(true);
    // a page served by this very host; never subject to CORS
    expect((await overWebSocket(port, { Origin: `http://127.0.0.1:${port}` })).accepted).toBe(true);
    expect(connected.map(c => c.cookie)).toEqual(['session=me', undefined, undefined]);

    const allowed = await overPolling(port, { Origin: ALLOWED });
    expect(allowed.accepted).toBe(true);
    expect(allowed.allowOrigin).toBe(ALLOWED);
    expect((await overPolling(port)).accepted).toBe(true);
    expect((await overPolling(port, { Origin: `http://127.0.0.1:${port}` })).accepted).toBe(true);
  });

  it('a same-named host on another port or scheme is not same-origin', async () => {
    const { port } = await boot({ cors: { origin: ALLOWED } });
    expect((await overWebSocket(port, { Origin: `http://127.0.0.1:${port + 1}` })).accepted).toBe(
      false
    );
    expect((await overWebSocket(port, { Origin: 'null' })).accepted).toBe(false);
  });

  it('supports list, RegExp, boolean and function rules', async () => {
    const cases: Array<{
      origin: NonNullable<WebSocketAdapterOptions['cors']>['origin'];
      ok: string[];
      no: string[];
      /** false where Socket.IO's own CORS handling already fails the request */
      withoutOrigin?: boolean;
    }> = [
      { origin: ['https://a.example', ALLOWED], ok: ['https://a.example', ALLOWED], no: [FOREIGN] },
      { origin: /\.example\.org$/, ok: ['https://x.example.org'], no: [FOREIGN] },
      { origin: false, ok: [], no: [ALLOWED, FOREIGN] },
      { origin: true, ok: [ALLOWED, FOREIGN], no: [] },
      { origin: '*', ok: [ALLOWED, FOREIGN], no: [] },
      // Socket.IO / cors form: (origin, callback)
      {
        origin: (origin, callback) => callback?.(null, origin === ALLOWED),
        ok: [ALLOWED],
        no: [FOREIGN],
      },
      {
        origin: (_origin, callback) => callback?.(new Error('denied')),
        ok: [],
        no: [ALLOWED, FOREIGN],
        withoutOrigin: false,
      },
    ];
    for (const { origin, ok, no, withoutOrigin = true } of cases) {
      const { port } = await boot({ cors: { origin } });
      for (const o of ok)
        expect({ o, r: (await overWebSocket(port, { Origin: o })).accepted }).toEqual({
          o,
          r: true,
        });
      for (const o of no)
        expect({ o, r: (await overWebSocket(port, { Origin: o })).accepted }).toEqual({
          o,
          r: false,
        });
      // a client without Origin is not subject to the origin rule
      expect({ origin: String(origin), r: (await overWebSocket(port)).accepted }).toEqual({
        origin: String(origin),
        r: withoutOrigin,
      });
      await shutdown();
    }
  });
});

// Socket.IO's own CORS middleware calls a function rule as (origin, callback)
// before the handshake check runs, so the other ways a function can answer are
// exercised on the check itself.
describe('Socket.IO adapter: function rules, checked directly', () => {
  type Check = (req: any, callback: (err: string | null | undefined, ok: boolean) => void) => void;
  const decide = (options: WebSocketAdapterOptions, origin?: string) =>
    new Promise<boolean>(resolve => {
      const quiet = new SocketIOAdapter();
      jest.spyOn((quiet as any).ioLogger, 'warn').mockImplementation(() => undefined);
      const check = (quiet as any).buildAllowRequest(options) as Check;
      check(
        { headers: { host: 'api.example', ...(origin ? { origin } : {}) }, socket: {} },
        (_err, ok) => resolve(ok)
      );
    });

  it('honours a returned decision, a returned promise and the callback, once', async () => {
    const returned = { cors: { origin: (o: string | undefined) => o === ALLOWED } };
    expect(await decide(returned, ALLOWED)).toBe(true);
    expect(await decide(returned, FOREIGN)).toBe(false);

    const reflected = { cors: { origin: (o: string | undefined) => (o === ALLOWED ? o : false) } };
    expect(await decide(reflected, ALLOWED)).toBe(true);
    expect(await decide(reflected, FOREIGN)).toBe(false);

    const promised = {
      cors: { origin: (async (o: string | undefined) => o === ALLOWED) as any },
    };
    expect(await decide(promised, ALLOWED)).toBe(true);
    expect(await decide(promised, FOREIGN)).toBe(false);

    const viaCallback: WebSocketAdapterOptions = {
      cors: {
        origin: (o, callback) => {
          callback?.(null, o === ALLOWED);
          callback?.(null, true); // a second answer is ignored
        },
      },
    };
    expect(await decide(viaCallback, ALLOWED)).toBe(true);
    expect(await decide(viaCallback, FOREIGN)).toBe(false);

    const throwing: WebSocketAdapterOptions = {
      cors: {
        origin: () => {
          throw new Error('boom');
        },
      },
    };
    expect(await decide(throwing, FOREIGN)).toBe(false);
    // no Origin, or same origin: the rule is not consulted
    expect(await decide(throwing)).toBe(true);
    expect(await decide(throwing, 'https://api.example')).toBe(true);
  });

  it('builds no check when there is nothing to enforce', () => {
    const build = (options: WebSocketAdapterOptions) =>
      (new SocketIOAdapter() as any).buildAllowRequest(options);
    expect(build({})).toBeUndefined();
    expect(build({ cors: {} })).toBeUndefined();
    expect(build({ cors: { origin: true } })).toBeUndefined();
    expect(build({ cors: { origin: '*' } })).toBeUndefined();
    // The option alone gives nothing to check, whichever way it is set
    expect(build({ enforceHandshakeChecks: true })).toBeUndefined();
    expect(build({ enforceHandshakeChecks: false, cors: { origin: '*' } })).toBeUndefined();
    expect(build({ cors: { origin: false } })).toEqual(expect.any(Function));
    expect(build({ verifyClient: () => true })).toEqual(expect.any(Function));
  });
});

describe('Socket.IO adapter: verifyClient', () => {
  it('rejects every transport when it returns false, and sees origin, req and secure', async () => {
    const seen: Array<{ origin: string | undefined; cookie: unknown; secure: boolean }> = [];
    const { port, connected } = await boot({
      cors: { origin: ALLOWED, credentials: true },
      verifyClient: info => {
        seen.push({ origin: info.origin, cookie: info.req.headers.cookie, secure: info.secure });
        return false;
      },
    });

    expect((await overWebSocket(port, { Origin: ALLOWED, Cookie: 'session=me' })).accepted).toBe(
      false
    );
    expect((await overWebSocket(port)).accepted).toBe(false);
    const polling = await overPolling(port, { Origin: ALLOWED });
    expect(polling.status).toBe(403);
    expect(connected).toHaveLength(0);
    expect(seen).toEqual([
      { origin: ALLOWED, cookie: 'session=me', secure: false },
      { origin: undefined, cookie: undefined, secure: false },
      { origin: ALLOWED, cookie: undefined, secure: false },
    ]);

    // the origin rule runs first: a foreign origin never reaches the hook
    expect((await overWebSocket(port, { Origin: FOREIGN })).accepted).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it('works without cors.origin and decides by its result', async () => {
    const { port } = await boot({
      cors: {},
      verifyClient: info => info.req.headers['x-token'] === 'good',
    });
    expect((await overWebSocket(port, { 'X-Token': 'good', Origin: FOREIGN })).accepted).toBe(true);
    expect((await overWebSocket(port, { 'X-Token': 'bad' })).accepted).toBe(false);
    expect((await overPolling(port, { 'X-Token': 'good' })).accepted).toBe(true);
    expect((await overPolling(port)).accepted).toBe(false);
  });

  it('a hook that throws, or resolves to false, rejects', async () => {
    const throwing = await boot({
      cors: {},
      verifyClient: () => {
        throw new Error('auth backend down');
      },
    });
    expect((await overWebSocket(throwing.port)).accepted).toBe(false);
    expect((await overPolling(throwing.port)).status).toBe(403);
    expect(throwing.warnings).toEqual([
      'Refused Socket.IO handshake (verifyClient threw: auth backend down)',
      'Refused Socket.IO handshake (verifyClient threw: auth backend down)',
    ]);
    await shutdown();

    const asyncHook = (async (info: { req: any }) =>
      info.req.headers['x-token'] === 'good') as unknown as WebSocketAdapterOptions['verifyClient'];
    const { port } = await boot({ ...(asyncHook ? { verifyClient: asyncHook } : {}) });
    expect((await overWebSocket(port, { 'X-Token': 'good' })).accepted).toBe(true);
    expect((await overWebSocket(port, { 'X-Token': 'bad' })).accepted).toBe(false);
    expect((await overPolling(port, { 'X-Token': 'good' })).accepted).toBe(true);
    expect((await overPolling(port, { 'X-Token': 'bad' })).status).toBe(403);
    await shutdown();

    const rejecting = await boot({
      verifyClient: (() => Promise.reject(new Error('token service down'))) as any,
    });
    expect((await overWebSocket(rejecting.port)).accepted).toBe(false);
    expect((await overPolling(rejecting.port)).status).toBe(403);
  });

  it('still runs an allowRequest the application passed in its options', async () => {
    const { port } = await boot({
      cors: { origin: ALLOWED },
      allowRequest: (
        req: http.IncomingMessage,
        callback: (err: string | null, ok: boolean) => void
      ) => callback(null, req.headers['x-extra'] === 'yes'),
    });
    expect((await overWebSocket(port, { Origin: ALLOWED, 'X-Extra': 'yes' })).accepted).toBe(true);
    expect((await overWebSocket(port, { Origin: ALLOWED })).accepted).toBe(false);
    expect((await overWebSocket(port, { Origin: FOREIGN, 'X-Extra': 'yes' })).accepted).toBe(false);
  });
});

describe('Socket.IO adapter: nothing configured', () => {
  // With neither cors.origin nor verifyClient the adapter installs no
  // allowRequest and Socket.IO behaves as it does on its own
  // (mergeWebSocketConfig hands the adapter `cors: {}`).
  it('installs no allowRequest and leaves the handshake to Socket.IO', async () => {
    for (const flag of [{}, { enforceHandshakeChecks: true }, { enforceHandshakeChecks: false }]) {
      const { port, adapter: a, warnings } = await boot({ cors: {}, ...flag });
      expect((a as any).io.engine.opts.allowRequest).toBeUndefined();
      expect((await overWebSocket(port, { Origin: FOREIGN })).accepted).toBe(true);
      expect((await overPolling(port, { Origin: FOREIGN })).accepted).toBe(true);
      // Nothing to report, so nothing is said
      expect(warnings).toEqual([]);
      await shutdown();
    }
  });
});

describe('Socket.IO adapter: message size', () => {
  const MB = 1000 * 1000;

  /** Open a session on the WebSocket transport and send one `size` event carrying `bytes` of text. */
  function sendOverWebSocket(
    port: number,
    bytes: number
  ): Promise<{ sized?: number; closed?: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('no answer to the size event'));
      }, 10000);
      const finish = (result: { sized?: number; closed?: number }) => {
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        ws.terminate();
        resolve(result);
      };
      ws.on('message', data => {
        const packet = data.toString();
        if (packet.startsWith('0')) ws.send('40');
        else if (packet.startsWith('40')) ws.send(`42["size","${'x'.repeat(bytes)}"]`);
        else if (packet.startsWith('42')) finish({ sized: JSON.parse(packet.slice(2))[1] });
      });
      ws.on('close', code => finish({ closed: code }));
      ws.on('error', () => undefined);
    });
  }

  /** The same event as the body of one long-polling POST; resolves with the POST's status. */
  async function postOverPolling(port: number, bytes: number): Promise<number> {
    const base = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
    const open = await (await fetch(base)).text();
    const sid = JSON.parse(open.slice(1)).sid as string;
    await fetch(`${base}&sid=${sid}`, { method: 'POST', body: '40' });
    const res = await fetch(`${base}&sid=${sid}`, {
      method: 'POST',
      body: `42["size","${'x'.repeat(bytes)}"]`,
    });
    await res.text();
    return res.status;
  }

  it("keeps Socket.IO's 1 MB limit unless maxPayloadLength sets another", async () => {
    const byDefault = await boot({ cors: {} });
    expect((byDefault.adapter as any).io.engine.opts.maxHttpBufferSize).toBe(MB);
    // Under the limit: delivered
    expect(await sendOverWebSocket(byDefault.port, 512 * 1024)).toEqual({ sized: 512 * 1024 });
    expect(await postOverPolling(byDefault.port, 512 * 1024)).toBe(200);
    // Over it: the WebSocket transport is closed, the polling POST is answered 413
    expect(await sendOverWebSocket(byDefault.port, 2 * MB)).toEqual({ closed: 1009 });
    expect(await postOverPolling(byDefault.port, 2 * MB)).toBe(413);
    await shutdown();

    // Raised: the same message is delivered, and one over the new limit is not
    const raised = await boot({ cors: {}, maxPayloadLength: 4 * MB });
    expect((raised.adapter as any).io.engine.opts.maxHttpBufferSize).toBe(4 * MB);
    expect(await sendOverWebSocket(raised.port, 2 * MB)).toEqual({ sized: 2 * MB });
    expect(await postOverPolling(raised.port, 2 * MB)).toBe(200);
    expect(await sendOverWebSocket(raised.port, 5 * MB)).toEqual({ closed: 1009 });
    expect(await postOverPolling(raised.port, 5 * MB)).toBe(413);
    await shutdown();

    // Socket.IO's own name for the option still wins when the application passes it
    const own = await boot({ cors: {}, maxPayloadLength: 4 * MB, maxHttpBufferSize: 3 * MB });
    expect((own.adapter as any).io.engine.opts.maxHttpBufferSize).toBe(3 * MB);
  });
});

describe('Socket.IO adapter: websocket.compression', () => {
  let app: any;
  const sockets: WebSocket[] = [];
  // About 150 KB of JSON that deflates to a few percent of its size
  const rows = Array.from({ length: 4000 }, (_, i) => ({ id: i, name: 'subscriber', on: true }));
  const rowsBytes = Buffer.byteLength(JSON.stringify(rows));
  const NOT_APPLIED =
    'websocket.compression is set but is not applied by the Socket.IO adapter: ' +
    'permessage-deflate is not negotiated and WebSocket messages are sent uncompressed. ' +
    'It is turned on when the adapter starts: set websocket.compression in the ' +
    'app configuration.';

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    resetConfig();
    if (app) {
      await app.core.getWebSocketAdapter()?.close();
      await closeApp(app);
    }
    app = null;
  });

  interface Session {
    ws: WebSocket;
    /** the Sec-WebSocket-Extensions header of the server's answer, if any */
    accepted: string | undefined;
    /** Socket.IO event packets received, parsed: [event, data] */
    events: unknown[][];
    closed: Promise<number>;
  }

  /**
   * A Socket.IO session on the WebSocket transport, joined to the default
   * namespace. `offer` is the client's permessage-deflate offer: true for the
   * `ws` client's own, false for none, or a Sec-WebSocket-Extensions value.
   */
  function openSession(port: number, offer: boolean | string): Promise<Session> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
        perMessageDeflate: offer === true,
        ...(typeof offer === 'string' ? { headers: { 'Sec-WebSocket-Extensions': offer } } : {}),
      });
      sockets.push(ws);
      const session: Session = {
        ws,
        accepted: undefined,
        events: [],
        closed: new Promise<number>(done => ws.once('close', code => done(code))),
      };
      ws.once('upgrade', res => {
        const header = res.headers['sec-websocket-extensions'];
        session.accepted = typeof header === 'string' ? header : undefined;
      });
      ws.on('message', data => {
        const packet = data.toString();
        if (packet.startsWith('0')) ws.send('40');
        else if (packet === '2') ws.send('3');
        else if (packet.startsWith('40')) resolve(session);
        else if (packet.startsWith('42')) session.events.push(JSON.parse(packet.slice(2)));
      });
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(new Error(`upgrade refused: ${res.statusCode}`));
      });
      ws.once('error', reject);
    });
  }

  // Send one event; resolves with the next event the server sends and the
  // bytes the exchange put on the connection in each direction.
  async function exchange(session: Session, event: string, data: unknown) {
    const socket = (session.ws as any)._socket;
    const before = { sent: socket.bytesWritten, received: socket.bytesRead };
    const from = session.events.length;
    session.ws.send(`42${JSON.stringify([event, data])}`);
    await waitFor(() => session.events.length > from, { description: `the answer to ${event}` });
    return {
      reply: session.events[from],
      sent: socket.bytesWritten - before.sent,
      received: socket.bytesRead - before.received,
    };
  }

  const echoing = (a: SocketIOAdapter) =>
    a.getDefaultNamespace().on('connection', socket => {
      socket.on('echo', (data: unknown) => socket.emit('echoed', data));
    });

  it('negotiates permessage-deflate with a client that offers it, and with no other', async () => {
    // Through createApp(): websocket.compression is what turns it on
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node' },
      websocket: { adapter: new SocketIOAdapter(), compression: true },
    });
    await app.core.ensureWebSocketReady();
    echoing(app.core.getWebSocketAdapter());
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

    const offering = await openSession(port, true);
    // Each message is compressed on its own, in a 4 KB window
    expect(offering.accepted).toBe(
      'permessage-deflate; server_no_context_takeover; server_max_window_bits=12'
    );
    const compressed = await exchange(offering, 'echo', rows);
    expect(compressed.reply).toEqual(['echoed', rows]);
    // Compressed on the way in and on the way out
    expect(compressed.sent).toBeLessThan(rowsBytes / 5);
    expect(compressed.received).toBeLessThan(rowsBytes / 5);
    // A short message goes through the same connection
    expect((await exchange(offering, 'echo', { n: 1 })).reply).toEqual(['echoed', { n: 1 }]);

    // The same server, a client that does not offer the extension
    const plain = await openSession(port, false);
    expect(plain.accepted).toBeUndefined();
    const uncompressed = await exchange(plain, 'echo', rows);
    expect(uncompressed.reply).toEqual(['echoed', rows]);
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
      const declined = await openSession(port, offer);
      expect([offer, declined.accepted]).toEqual([offer, undefined]);
      expect((await exchange(declined, 'echo', 'hi')).reply).toEqual(['echoed', 'hi']);
    }
  });

  it("is off unless compression is true, and the application's own perMessageDeflate wins", async () => {
    const DEFLATE = /^permessage-deflate\b/;
    for (const [options, expected] of [
      [{ compression: true }, 'shorthand'],
      [{}, 'off'],
      [{ compression: false }, 'off'],
      // Socket.IO's own option, passed through: it decides, either way
      [{ compression: true, perMessageDeflate: false }, 'off'],
      [{ perMessageDeflate: { threshold: 2048 } }, 'own'],
      [{ compression: true, perMessageDeflate: { threshold: 2048 } }, 'own'],
    ] as Array<[WebSocketAdapterOptions, 'shorthand' | 'off' | 'own']>) {
      const { port, adapter: a } = await boot({ cors: {}, ...options });
      const opts = (a as any).io.engine.opts;
      // `compression` is the adapter's switch, not a Socket.IO option
      expect('compression' in opts).toBe(false);
      // Long-polling responses are compressed by Socket.IO's own default, as before
      expect(opts.httpCompression).toEqual({ threshold: 1024 });

      const session = await openSession(port, true);
      if (expected === 'off') {
        expect(opts.perMessageDeflate).toBeFalsy();
        expect(session.accepted).toBeUndefined();
      } else if (expected === 'own') {
        expect(opts.perMessageDeflate).toEqual({ threshold: 2048 });
        expect(session.accepted).toBe('permessage-deflate');
      } else {
        expect(opts.perMessageDeflate.threshold).toBe(1024);
        expect(opts.perMessageDeflate.serverNoContextTakeover).toBe(true);
        expect(session.accepted).toMatch(DEFLATE);
      }
      session.ws.terminate();
      await shutdown();
    }

    // Asked for on the adapter before it starts: the same as the option
    server = http.createServer((_req, res) => res.end());
    adapter = new SocketIOAdapter();
    adapter.setCompression(true);
    await adapter.initialize(server, { cors: {} });
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()));
    const early = await openSession((server.address() as AddressInfo).port, true);
    expect(early.accepted).toMatch(DEFLATE);
  });

  it('closes with 1009 a connection whose message inflates past maxPayloadLength', async () => {
    const limit = 64 * 1024;
    const { port, adapter: a } = await boot({
      cors: {},
      compression: true,
      maxPayloadLength: limit,
    });
    // One number: Socket.IO's limit on a message, which its WebSocket
    // transport also applies to a message once inflated
    expect((a as any).io.engine.opts.maxHttpBufferSize).toBe(limit);

    const session = await openSession(port, true);
    expect(session.accepted).toMatch(/^permessage-deflate\b/);
    // Under the limit once inflated: answered
    expect((await exchange(session, 'size', 'x'.repeat(limit / 2))).reply).toEqual([
      'sized',
      limit / 2,
    ]);

    // A fraction of the limit on the wire, three times the limit inflated
    const socket = (session.ws as any)._socket;
    const sentBefore = socket.bytesWritten;
    session.ws.send(`42["size","${'x'.repeat(3 * limit)}"]`);
    expect(await session.closed).toBe(1009);
    expect(socket.bytesWritten - sentBefore).toBeLessThan(limit / 2);
    expect(session.events).toHaveLength(1);
  });

  it('says nothing when the option is applied, and says so once when it comes too late', async () => {
    const applied = await boot({ cors: {}, compression: true });
    // What the framework calls after initialize() for websocket.compression
    applied.adapter.setCompression(true);
    expect(applied.warnings).toEqual([]);
    await shutdown();

    // First asked for once the Socket.IO server exists: it reads the setting
    // when it is created, so the line says where to set it.
    const late = await boot({ cors: {} });
    late.adapter.setCompression(true);
    late.adapter.setCompression(true);
    expect(late.warnings).toEqual([NOT_APPLIED]);
    const session = await openSession(late.port, true);
    expect(session.accepted).toBeUndefined();
  });
});

describe('Socket.IO adapter: app.websocket() while the adapter is still starting', () => {
  // The adapter builds its Socket.IO server in an asynchronous initialize(),
  // which has not finished when `await createApp()` returns.
  let app: any;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    resetConfig();
    if (app) {
      await app.core.getWebSocketAdapter()?.close();
      await closeApp(app);
    }
    app = null;
  });

  const newApp = () =>
    createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node' },
      websocket: { adapter: new SocketIOAdapter() },
    });

  /** Join `namespace` over the WebSocket transport and send one `ping` event. */
  function pingNamespace(port: number, namespace: string, value: number): void {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    sockets.push(ws);
    ws.on('error', () => undefined);
    ws.on('message', data => {
      const packet = data.toString();
      if (packet.startsWith('0')) ws.send(`40${namespace},`);
      else if (packet.startsWith(`40${namespace}`)) ws.send(`42${namespace},["ping",${value}]`);
    });
  }

  it('accepts a registration made straight after createApp() and applies it at listen()', async () => {
    app = await newApp();
    const registered: string[] = [];
    app.on('websocket:registered', (e: { namespace: string }) => registered.push(e.namespace));
    const calls: string[] = [];

    expect(() =>
      app.websocket('/chat', {
        connection: () => calls.push('connection'),
        ping: (_socket: unknown, data: unknown) => {
          calls.push(`ping:${String(data)}`);
        },
      })
    ).not.toThrow();
    // Held: the Socket.IO server does not exist yet
    expect(registered).toEqual([]);

    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    expect(registered).toEqual(['/chat']);

    pingNamespace(port, '/chat', 7);
    await waitFor(() => calls.includes('ping:7'), { description: 'the ping handler' });
    expect(calls).toEqual(['connection', 'ping:7']);
  });

  it('applies websocket.options from createApp(): the origin rule refuses by default', async () => {
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node' },
      websocket: {
        adapter: new SocketIOAdapter(),
        options: { cors: { origin: ALLOWED, credentials: true } },
      },
    });
    let connections = 0;
    app.websocket('/', { connection: () => connections++ });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

    expect(
      (await overWebSocket(port, { Origin: FOREIGN, Cookie: 'session=victim' })).accepted
    ).toBe(false);
    expect((await overPolling(port, { Origin: FOREIGN })).status).toBe(403);
    expect(connections).toBe(0);
    expect((await overWebSocket(port, { Origin: ALLOWED })).accepted).toBe(true);
    expect(connections).toBe(1);
  });

  it('still registers at once when the adapter has finished starting', async () => {
    app = await newApp();
    await app.core.ensureWebSocketReady();
    await Promise.resolve();
    const registered: string[] = [];
    app.on('websocket:registered', (e: { namespace: string }) => registered.push(e.namespace));

    app.websocket('/later', { ping: () => undefined });
    expect(registered).toEqual(['/later']);
  });
});

describe('Socket.IO adapter: socket.ip behind a proxy', () => {
  let app: any;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    resetConfig();
    if (app) {
      await app.core.getWebSocketAdapter()?.close();
      await closeApp(app);
    }
    app = null;
  });

  // What a connection and a request from the same client report, with the
  // proxy's X-Forwarded-For on both
  async function addressesWith(server: Record<string, unknown>) {
    resetConfig();
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node', ...server },
      websocket: { adapter: new SocketIOAdapter() },
    });
    const seen: { socketIp?: unknown; inMiddleware?: unknown } = {};
    app.get('/ip', (req: any) => ({ ip: req.ip }));
    app.websocket('/who', {
      connection: (socket: { ip?: string }) => {
        seen.socketIp = socket.ip;
      },
    });
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    app.core
      .getWebSocketAdapter()
      .createNamespace('/who')
      .use((socket: { ip?: string }, next: () => void) => {
        seen.inMiddleware = socket.ip;
        next();
      });

    const forwarded = { 'X-Forwarded-For': '203.0.113.7, 198.51.100.4' };
    const reply = await fetch(`http://127.0.0.1:${port}/ip`, { headers: forwarded });
    const requestIp = ((await reply.json()) as { ip: string }).ip;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
      headers: forwarded,
    });
    sockets.push(ws);
    ws.on('error', () => undefined);
    ws.on('message', data => {
      if (data.toString().startsWith('0')) ws.send('40/who,');
    });
    await waitFor(() => seen.socketIp !== undefined, { description: 'the connection hook' });

    await app.core.getWebSocketAdapter()?.close();
    await closeApp(app);
    app = null;
    return { requestIp, ...seen };
  }

  it('is the client req.ip names once server.trustProxy is set, and the peer without it', async () => {
    // One trusted proxy: the client is the last X-Forwarded-For entry
    const behindProxy = await addressesWith({ trustProxy: 1 });
    expect(behindProxy.requestIp).toBe('198.51.100.4');
    expect(behindProxy.socketIp).toBe('198.51.100.4');
    expect(behindProxy.inMiddleware).toBe('198.51.100.4');

    // No proxy trusted, and the setting left out: the connected peer
    const untrusted = await addressesWith({ trustProxy: false });
    expect(untrusted.socketIp).toBe('127.0.0.1');
    expect(untrusted.socketIp).toBe(untrusted.requestIp);
    const unset = await addressesWith({});
    expect(unset.socketIp).toBe('127.0.0.1');
    expect(unset.inMiddleware).toBe('127.0.0.1');
    expect(unset.socketIp).toBe(unset.requestIp);
  });
});
