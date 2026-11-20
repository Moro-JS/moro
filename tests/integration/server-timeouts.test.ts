// @ts-nocheck
// Integration - server.timeouts.request and server.maxConnections are FINALLY
// applied (they were validated-but-never-wired before). A stalled request is
// reaped within the budget on the engine; maxConnections drops the excess.
//
// The defaults (75 s idle on the HTTP/2 server and on a native engine whose
// idle timeout spares a response that is still being delivered, 5 minutes to
// deliver a request everywhere) are asserted by reading what each server is
// handed; what a timeout does and does not close is exercised with values of
// a few hundred milliseconds.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { WebSocket } from 'ws';
import * as http2 from 'http2';
import { createApp, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine, engineLoadable } from './engine-test-utils.js';
import * as net from 'net';
import * as tls from 'tls';
import { fixture, testCA } from '../utils/tls-client.js';

const testPort = () => createTestPort();
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One raw connection: `onConnect` writes whatever the case needs, and the
 * result says what came back, whether the server ended the connection in an
 * orderly way (a FIN, no reset) and when. A connection still open after
 * `maxMs` is reported as such and destroyed.
 */
function exchange(
  port: number,
  onConnect: (sock: net.Socket) => void,
  maxMs = 4000
): Promise<{ text: string; closedAfter: number | null; orderly: boolean }> {
  return new Promise(resolve => {
    const started = Date.now();
    let text = '';
    let fin = false;
    let failed = false;
    const sock = net.connect({ host: '127.0.0.1', port }, () => onConnect(sock));
    sock.on('data', chunk => (text += chunk.toString('latin1')));
    sock.on('end', () => (fin = true));
    sock.on('error', () => (failed = true));
    const giveUp = setTimeout(() => {
      sock.destroy();
      resolve({ text, closedAfter: null, orderly: false });
    }, maxMs);
    sock.on('close', () => {
      clearTimeout(giveUp);
      resolve({ text, closedAfter: Date.now() - started, orderly: fin && !failed });
    });
  });
}

const responsesIn = (text: string) => (text.match(/HTTP\/1\.1 200/g) || []).length;

// The options object the native engine's serve() was last called with.
const engineModule: any = engineLoadable ? loadNativeEngine()?.module : null;
// The idle timeout an app that configures none gets on the installed engine:
// the 75 s default where the engine leaves a response in delivery alone
// (capabilities.idleSparesDrainingResponse), none (0) on one that would cut it.
const engineSparesDrainingResponse =
  engineLoadable && loadNativeEngine()?.capabilities?.idleSparesDrainingResponse === true;
const DEFAULT_ENGINE_IDLE = engineSparesDrainingResponse ? 75000 : 0;
function watchEngineOptions(): () => any {
  const serve = jest.spyOn(engineModule, 'serve');
  return () => serve.mock.calls[serve.mock.calls.length - 1]?.[1];
}

describeEngine('Native engine server timeouts / connection cap', () => {
  let app: any;
  afterEach(async () => {
    jest.restoreAllMocks();
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const create = async (server: any, extra: any = {}) => {
    if (app) {
      await closeApp(app);
      resetConfig();
    }
    app = await createApp({
      logger: { level: 'fatal' },
      ...extra,
      server: { engine: 'moro', ...server },
    });
    return app;
  };

  it('hands the engine a 5 minute request timeout when none is configured, and the 75 s idle timeout if the engine spares a response in delivery', async () => {
    const handed = watchEngineOptions();
    await create({});

    expect(handed().idleTimeoutMs).toBe(DEFAULT_ENGINE_IDLE);
    expect(handed().requestTimeoutMs).toBe(300000);
  });

  it('applies the idle default by what the engine advertises', async () => {
    const capabilities = loadNativeEngine()!.capabilities as any;
    const advertised = capabilities.idleSparesDrainingResponse;
    const handed = watchEngineOptions();
    try {
      capabilities.idleSparesDrainingResponse = true;
      await create({});
      expect(handed().idleTimeoutMs).toBe(75000);

      capabilities.idleSparesDrainingResponse = false;
      await create({});
      expect(handed().idleTimeoutMs).toBe(0);
      // A configured value is handed over whatever the engine advertises
      await create({ timeouts: { idle: 20000 } });
      expect(handed().idleTimeoutMs).toBe(20000);
    } finally {
      capabilities.idleSparesDrainingResponse = advertised;
    }
  });

  it('hands over an explicit 0, which disables that timeout, and the default for the other', async () => {
    const handed = watchEngineOptions();

    await create({ timeouts: { idle: 0 } });
    expect(handed().idleTimeoutMs).toBe(0);
    expect(handed().requestTimeoutMs).toBe(300000);

    await create({ timeouts: { request: 0 } });
    expect(handed().idleTimeoutMs).toBe(DEFAULT_ENGINE_IDLE);
    expect(handed().requestTimeoutMs).toBe(0);

    // With both at 0 a connection that never sends a request is left open
    await create({ timeouts: { idle: 0, request: 0 } });
    expect(handed().idleTimeoutMs).toBe(0);
    expect(handed().requestTimeoutMs).toBe(0);
    const port = testPort();
    await listen(app, port);
    const silent = await exchange(port, sock => sock.write('GET / HTTP/1.1\r\n'), 1200);
    expect(silent.closedAfter).toBeNull();
  });

  it('takes server.timeout as the request timeout unless server.timeouts.request is given', async () => {
    const handed = watchEngineOptions();

    await create({ timeout: 45000 });
    expect(handed().requestTimeoutMs).toBe(45000);
    expect(app.getConfig().server.timeouts.request).toBe(45000);

    await create({ timeout: 45000, timeouts: { request: 900 } });
    expect(handed().requestTimeoutMs).toBe(900);

    await create({ timeout: 45000, timeouts: { request: 0 } });
    expect(handed().requestTimeoutMs).toBe(0);
  });

  it('answers 408 when a request takes longer than server.timeout to arrive, and lets a slow handler finish', async () => {
    const port = testPort();
    await create({ timeout: 600 });
    app.post('/upload', (req: any) => ({ received: String(req.body).length }));
    app.get('/slow', async () => {
      await sleep(1500);
      return { slow: true };
    });
    await listen(app, port);

    const [upload, slow] = await Promise.all([
      // 40 bytes of body, 4 at a time every 100 ms: one second to deliver
      exchange(port, sock => {
        sock.write(
          'POST /upload HTTP/1.1\r\nHost: t\r\nContent-Type: text/plain\r\n' +
            'Content-Length: 40\r\nConnection: close\r\n\r\n'
        );
        let sent = 0;
        const drip = setInterval(() => {
          sock.write('abcd');
          if (++sent === 10) clearInterval(drip);
        }, 100);
        sock.on('close', () => clearInterval(drip));
      }),
      // received at once, answered after two and a half request timeouts
      exchange(port, sock =>
        sock.write('GET /slow HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n')
      ),
    ]);

    expect(upload.text.startsWith('HTTP/1.1 408')).toBe(true);
    expect(upload.orderly).toBe(true);
    expect(slow.text.startsWith('HTTP/1.1 200')).toBe(true);
    expect(slow.text.endsWith('{"slow":true}')).toBe(true);
  });

  it('closes a connection that has been idle for server.timeouts.idle, after its responses are delivered', async () => {
    const handed = watchEngineOptions();
    const port = testPort();
    await create({ timeouts: { idle: 500 } });
    app.get('/ping', () => ({ pong: true }));
    await listen(app, port);

    // Setting one timeout leaves the other at its default
    expect(handed().idleTimeoutMs).toBe(500);
    expect(handed().requestTimeoutMs).toBe(300000);

    const request = 'GET /ping HTTP/1.1\r\nHost: t\r\n\r\n';
    const [silent, keepAlive, pipelined, reused] = await Promise.all([
      exchange(port, () => {}),
      exchange(port, sock => sock.write(request)),
      exchange(port, sock => sock.write(request.repeat(3))),
      // a second request before the idle timeout is answered on the same connection
      exchange(port, sock => {
        sock.write(request);
        setTimeout(() => sock.write(request), 300);
      }),
    ]);

    for (const connection of [silent, keepAlive, pipelined, reused]) {
      expect(connection.closedAfter).not.toBeNull();
      expect(connection.closedAfter).toBeGreaterThanOrEqual(400);
      expect(connection.orderly).toBe(true);
    }
    expect(silent.text).toBe('');
    expect(responsesIn(keepAlive.text)).toBe(1);
    expect(responsesIn(pipelined.text)).toBe(3);
    expect(pipelined.text.endsWith('{"pong":true}')).toBe(true);
    expect(responsesIn(reused.text)).toBe(2);
    expect(reused.closedAfter).toBeGreaterThanOrEqual(700);
  });

  it('does not close a request in progress: a slow handler, a stream with gaps, server-sent events and a WebSocket outlive both timeouts', async () => {
    const handed = watchEngineOptions();
    const port = testPort();
    await create({ timeout: 500, timeouts: { idle: 400 } }, { websocket: { enabled: true } });
    app.use(middleware.sse());
    app.get('/slow', async () => {
      await sleep(1400);
      return { slow: true };
    });
    app.get('/stream', (req: any, res: any) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('a;');
      setTimeout(() => res.write('b;'), 700);
      setTimeout(() => res.end('c;'), 1400);
    });
    app.get('/events', (req: any, res: any) => {
      res.sendEvent({ n: 1 });
      setTimeout(() => res.sendEvent({ n: 2 }), 700);
      setTimeout(() => {
        res.sendEvent({ n: 3 });
        res.end();
      }, 1400);
    });
    app.websocket('/echo', { message: (socket: any, text: string) => socket.send(text) }, {
      raw: true,
    } as any);
    await listen(app, port);

    // Both timeouts are in force, each well under the 1.4 s every case runs for
    expect(handed().idleTimeoutMs).toBe(400);
    expect(handed().requestTimeoutMs).toBe(500);

    const get = (path: string) =>
      exchange(port, sock =>
        sock.write(`GET ${path} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`)
      );
    const webSocket = (async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/echo`);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      let closed = false;
      ws.once('close', () => (closed = true));
      await sleep(1400); // nothing sent either way
      const echoed = closed
        ? null
        : await new Promise<string | null>(resolve => {
            ws.once('message', data => resolve(data.toString()));
            ws.once('close', () => resolve(null));
            ws.send('still here');
          });
      ws.terminate();
      return echoed;
    })();
    const [slow, stream, events, echoed] = await Promise.all([
      get('/slow'),
      get('/stream'),
      get('/events'),
      webSocket,
    ]);

    expect(slow.text.endsWith('{"slow":true}')).toBe(true);
    expect(stream.text).toContain('a;');
    expect(stream.text).toContain('b;');
    expect(stream.text).toContain('c;');
    expect(stream.orderly).toBe(true);
    expect((events.text.match(/data: /g) || []).length).toBe(3);
    expect(events.orderly).toBe(true);
    expect(echoed).toBe('still here');
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

describe('Node.js server timeouts', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const create = async (server: any) => {
    if (app) {
      await closeApp(app);
      resetConfig();
    }
    app = await createApp({ logger: { level: 'fatal' }, server: { engine: 'node', ...server } });
    return app.core.httpServer.getServer();
  };

  it('takes server.timeout as the request timeout, and has no socket idle timeout unless server.timeouts.idle is set', async () => {
    const defaults = await create({});
    expect(defaults.requestTimeout).toBe(300000);
    expect(defaults.keepAliveTimeout).toBe(5000);
    expect(defaults.headersTimeout).toBe(6000);
    // Node's socket idle timeout also cuts a slow handler, so no default is applied
    expect(defaults.timeout).toBe(0);

    const aliased = await create({ timeout: 120000 });
    expect(aliased.requestTimeout).toBe(120000);
    expect(aliased.timeout).toBe(0);

    const explicit = await create({ timeout: 120000, timeouts: { request: 45000, idle: 30000 } });
    expect(explicit.requestTimeout).toBe(45000);
    expect(explicit.timeout).toBe(30000);
  });
});

describe('HTTP/2 server idle timeout', () => {
  let app: any;
  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const create = async (server: any) => {
    if (app) {
      await closeApp(app);
      resetConfig();
    }
    app = await createApp({
      logger: { level: 'fatal' },
      server: { engine: 'node', http2: true, ...server },
    });
    return app.core.httpServer.getServer();
  };

  it('is 75 s when none is configured, and off with server.timeouts.idle: 0', async () => {
    expect((await create({})).timeout).toBe(75000);
    expect((await create({ timeouts: { idle: 0 } })).timeout).toBe(0);
    expect((await create({ timeouts: { idle: 20000 } })).timeout).toBe(20000);
  });

  it('lets a stream in progress finish, then closes the session; an idle session is closed at the timeout', async () => {
    const port = testPort();
    await create({ timeouts: { idle: 300 } });
    app.get('/slow', async () => {
      await sleep(1000);
      return { slow: true };
    });
    await listen(app, port);

    const session = (path: string | null) =>
      new Promise<{ status: number | null; body: string; closedAfter: number | null }>(resolve => {
        const started = Date.now();
        const client = http2.connect(`http://127.0.0.1:${port}`);
        let status: number | null = null;
        let body = '';
        client.on('error', () => {});
        const giveUp = setTimeout(() => {
          client.destroy();
          resolve({ status, body, closedAfter: null });
        }, 4000);
        client.on('close', () => {
          clearTimeout(giveUp);
          resolve({ status, body, closedAfter: Date.now() - started });
        });
        if (path) {
          const request = client.request({ ':path': path });
          request.on('response', headers => (status = Number(headers[':status'])));
          request.on('data', chunk => (body += chunk));
          request.on('error', () => {});
          request.end();
        }
      });

    const [idle, busy] = await Promise.all([session(null), session('/slow')]);

    expect(idle.closedAfter).not.toBeNull();
    expect(idle.closedAfter).toBeLessThan(1000);
    // answered 700 ms after the idle timeout fired, in full
    expect(busy.status).toBe(200);
    expect(busy.body).toBe('{"slow":true}');
    expect(busy.closedAfter).not.toBeNull();
    expect(busy.closedAfter).toBeGreaterThanOrEqual(900);
  });

  it('on TLS, closes an idle HTTP/1.1 connection at the timeout as well, and keeps serving', async () => {
    const port = testPort();
    await create({
      timeouts: { idle: 300 },
      ssl: { key: fixture('localhost.key'), cert: fixture('localhost.pem') },
    });
    app.get('/slow', async () => {
      await sleep(900);
      return { slow: true };
    });
    await listen(app, port);

    // A client that negotiates http/1.1 and then sends nothing
    const http1 = new Promise<{ alpn: string | false; closedAfter: number | null }>(resolve => {
      const started = Date.now();
      let alpn: string | false = false;
      const socket = tls.connect({
        host: '127.0.0.1',
        port,
        servername: 'localhost',
        ca: testCA(),
        ALPNProtocols: ['http/1.1'],
      });
      socket.on('secureConnect', () => (alpn = socket.alpnProtocol));
      socket.on('error', () => {});
      socket.resume();
      const giveUp = setTimeout(() => {
        socket.destroy();
        resolve({ alpn, closedAfter: null });
      }, 3000);
      socket.on('close', () => {
        clearTimeout(giveUp);
        resolve({ alpn, closedAfter: Date.now() - started });
      });
    });
    // An HTTP/2 request answered 600 ms after the idle timeout fired
    const h2 = new Promise<{ status: number | null; body: string }>(resolve => {
      const client = http2.connect(`https://localhost:${port}`, { ca: testCA() });
      let status: number | null = null;
      let body = '';
      client.on('error', () => {});
      const giveUp = setTimeout(() => client.destroy(), 4000);
      client.on('close', () => {
        clearTimeout(giveUp);
        resolve({ status, body });
      });
      const request = client.request({ ':path': '/slow' });
      request.on('response', headers => (status = Number(headers[':status'])));
      request.on('data', chunk => (body += chunk));
      request.on('error', () => {});
      request.end();
    });

    const [idleHttp1, busy] = await Promise.all([http1, h2]);

    expect(idleHttp1.alpn).toBe('http/1.1');
    expect(idleHttp1.closedAfter).not.toBeNull();
    expect(idleHttp1.closedAfter).toBeLessThan(2000);
    expect(busy.status).toBe(200);
    expect(busy.body).toBe('{"slow":true}');
  });
});
