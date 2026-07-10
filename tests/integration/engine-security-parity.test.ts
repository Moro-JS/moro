/* eslint-disable */
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
//
// Runs each engine in its own phase (UnifiedRouter is a process-wide singleton).
// Skipped when the native engine can't load.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const testPort = () => 10800 + Math.floor(Math.random() * 4000);
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
});
