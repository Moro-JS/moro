// @ts-nocheck
// Integration Tests - security/correctness parity between the native
// @morojs/engine backend and the Node http backend for the behaviors hardened
// during the production-readiness pass:
//   - Set-Cookie values are percent-encoded (no attribute injection / silent drop)
//   - a malformed request body is a 400 on BOTH engines (not 200/500 divergence)
//   - an empty JSON body does not 500 (parses to null, handler still runs)
//   - req.socket / req.connection are present so Node-style middleware
//     (CSRF's req.socket.encrypted, rate-limiters' req.connection.remoteAddress)
//     does not throw on the engine transport
//   - req.method is the upper-case token on the engine too, so a middleware
//     that guards by method sees the same value it would on Node
//   - a failed direct route answers the generic 500 body in production on both
//   - an absolute-form request target is routed by its path on both servers,
//     and a middleware that guards a path sees that path
//
// Runs each engine in its own phase (UnifiedRouter is a process-wide singleton).
// Skipped when the native engine can't load.
import { describe, it, expect, afterEach } from '@jest/globals';
import net from 'node:net';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const testPort = () => createTestPort();
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

function registerRoutes(app: any): void {
  // Sets a cookie whose value contains delimiters that MUST be encoded
  app.get('/setcookie', (_req: any, res: any) => {
    res.cookie('session', 'a b;c,d=e', { httpOnly: true });
    return { ok: true };
  });
  // Echoes the parsed body (or null)
  app.post('/echo', (req: any) => ({ received: req.body ?? null }));
  // Touches the Node-style socket/connection surface the way middleware does
  app.get('/sock', (req: any) => ({
    encrypted: (req.socket as any)?.encrypted ?? null,
    remoteFromConnection: req.connection?.remoteAddress ?? null,
    hasSocket: !!req.socket,
  }));
}

async function collect(port: number) {
  const base = `http://localhost:${port}`;
  const setCookie = await fetch(`${base}/setcookie`);
  const malformed = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ this is not json',
  });
  const emptyJson = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '',
  });
  const sock = await fetch(`${base}/sock`);
  return {
    cookie: setCookie.headers.get('set-cookie'),
    malformedStatus: malformed.status,
    emptyStatus: emptyJson.status,
    emptyBody: await emptyJson.json().catch(() => 'NOTJSON'),
    sockStatus: sock.status,
    sockBody: await sock.json().catch(() => null),
  };
}

// One raw request on its own connection; resolves with everything received.
// (fetch and node:http normalise the method token before it reaches the wire.)
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on('data', d => chunks.push(d));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

// An absolute-form request target (RFC 9112 3.2.2) is routed by its path on
// both servers, takes its host from the target, and a middleware that guards a
// path sees that path.
async function absoluteTargetCase(engine: 'moro' | 'node'): Promise<void> {
  resetConfig();
  UnifiedRouter.reset();
  const app = await createApp({
    logger: { level: 'fatal' },
    autoDiscover: false,
    server: { engine },
  });
  try {
    const guarded: string[] = [];
    await app.use((req: any, res: any, next: () => void) => {
      if (req.path.startsWith('/admin')) {
        guarded.push(req.path);
        if (req.headers['x-key'] !== 'let-me-in') {
          res.status(401).json({ error: 'denied' });
          return;
        }
      }
      next();
    });
    app.get('/admin/report', (req: any) => ({
      path: req.path,
      url: req.url,
      query: req.query,
      host: req.headers.host,
      hostname: req.hostname,
    }));
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    const request = (target: string, extra = '') =>
      rawRequest(
        port,
        `GET ${target} HTTP/1.1\r\nHost: header.example\r\n${extra}Connection: close\r\n\r\n`
      );
    const bodyOf = (reply: string) => JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4));

    // The guard sees the path the router matches, not the whole URL
    const refused = await request('http://app.example.com/admin/report');
    expect(refused.startsWith('HTTP/1.1 401')).toBe(true);
    expect(guarded).toEqual(['/admin/report']);

    // RFC 9112 3.2.2: routed by the path of the target, with the target's host
    const served = await request(
      'http://app.example.com:8080/admin/report?year=2026',
      'X-Key: let-me-in\r\n'
    );
    expect(served.startsWith('HTTP/1.1 200')).toBe(true);
    expect(bodyOf(served)).toEqual({
      path: '/admin/report',
      url: '/admin/report?year=2026',
      query: { year: '2026' },
      host: 'app.example.com:8080',
      hostname: 'app.example.com',
    });

    // The same request in origin-form is untouched
    const origin = await request('/admin/report?year=2026', 'X-Key: let-me-in\r\n');
    expect(bodyOf(origin)).toMatchObject({ path: '/admin/report', host: 'header.example' });

    // A URL of another scheme, or one with no host, is not a route
    expect((await request('ftp://app.example.com/admin/report')).startsWith('HTTP/1.1 404')).toBe(
      true
    );
    expect((await request('http:///admin/report')).startsWith('HTTP/1.1 404')).toBe(true);
  } finally {
    await closeApp(app);
  }
}

describeEngine('Engine <-> Node security parity', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  async function runPhase(engine: 'moro' | 'node') {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    registerRoutes(app);
    const port = testPort();
    await listen(app, port);
    const results = await collect(port);
    await closeApp(app);
    app = null;
    return results;
  }

  it('encodes cookies, unifies malformed-body 400, and exposes req.socket on both engines', async () => {
    const node = await runPhase('node');
    const moro = await runPhase('moro');

    // Cookie value is percent-encoded on both (space -> %20, ';' -> %3B, etc.)
    for (const r of [node, moro]) {
      expect(r.cookie).toContain('session=a%20b%3Bc%2Cd%3De');
      expect(r.cookie).toContain('HttpOnly');
    }

    // Malformed JSON body is a client error (400) on BOTH transports
    expect(node.malformedStatus).toBe(400);
    expect(moro.malformedStatus).toBe(moro.malformedStatus === 400 ? 400 : node.malformedStatus);
    expect(moro.malformedStatus).toBe(400);

    // Empty JSON body does not 500 (parses to null; handler runs) on both
    expect(node.emptyStatus).toBeLessThan(500);
    expect(moro.emptyStatus).toBeLessThan(500);
    expect(node.emptyStatus).toBe(moro.emptyStatus);

    // The socket/connection shim is present and does not crash the request
    for (const r of [node, moro]) {
      expect(r.sockStatus).toBe(200);
      expect(r.sockBody.hasSocket).toBe(true);
    }
    // The engine serves plaintext HTTP -> encrypted is false, never a throw
    expect(moro.sockBody.encrypted).toBe(false);
  }, 30000);

  it('keeps the error text of a failed direct route out of the response in production', async () => {
    const previous = process.env.NODE_ENV;
    try {
      for (const engine of ['node', 'moro'] as const) {
        resetConfig();
        UnifiedRouter.reset();
        process.env.NODE_ENV = previous;
        app = await createApp({
          logger: { level: 'fatal' },
          autoDiscover: false,
          routing: false,
          server: { engine },
        });
        app.get('/report', () => {
          throw new Error("ENOENT: no such file or directory, open '/srv/app/reports/q3.csv'");
        });
        const port = testPort();
        await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
        // The server's own route table answers once the router no longer holds the route.
        UnifiedRouter.getInstance().clearAllRoutes();

        process.env.NODE_ENV = 'production';
        const inProduction = await fetch(`http://127.0.0.1:${port}/report`);
        expect(inProduction.status).toBe(500);
        const body = await inProduction.json();
        expect({ engine, body }).toEqual({
          engine,
          body: { success: false, error: 'Internal server error', requestId: body.requestId },
        });
        expect(typeof body.requestId).toBe('string');

        // Outside production the response is the one it always was.
        process.env.NODE_ENV = 'development';
        const inDevelopment = await fetch(`http://127.0.0.1:${port}/report`);
        expect(inDevelopment.status).toBe(500);
        expect(await inDevelopment.json()).toEqual({
          success: false,
          error: "ENOENT: no such file or directory, open '/srv/app/reports/q3.csv'",
        });

        await closeApp(app);
        app = null;
      }
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('normalises a non-standard method token before middleware sees it', async () => {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      server: { engine: 'moro' },
    });
    const seen: string[] = [];
    await app.use((req: any, res: any, next: () => void) => {
      seen.push(req.method);
      // The usual shape of a state-changing-method guard.
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        res.status(401).json({ error: 'denied' });
        return;
      }
      next();
    });
    let deleted = 0;
    app.delete('/item').handler(() => ({ deleted: ++deleted }));
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

    const upper = await rawRequest(
      port,
      'DELETE /item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    expect(upper.startsWith('HTTP/1.1 401')).toBe(true);

    const lower = await rawRequest(
      port,
      'delete /item HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    // Whether the engine routes or rejects the token, the guard must not be
    // skipped: the handler never runs without it.
    expect(lower.startsWith('HTTP/1.1 200')).toBe(false);
    expect(deleted).toBe(0);
    expect(seen.every(method => method === method.toUpperCase())).toBe(true);
  });

  it('routes an absolute-form request target by its path, past the middleware that guards that path', () =>
    absoluteTargetCase('moro'));
});

describe('absolute-form request target (Node http server)', () => {
  it('routes it by its path, past the middleware that guards that path', () =>
    absoluteTargetCase('node'));
});
