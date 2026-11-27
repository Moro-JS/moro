// @ts-nocheck
// Integration Tests - cross-backend HTTP conformance harness. One table-driven
// suite asserts that the SAME request produces the SAME response across every
// HTTP backend available on this platform:
//   - 'node' : the Node.js http server            (always present)
//   - 'moro' : the native @morojs/engine          (when it loads)
//
// This makes Moro's parity guarantee explicit and executable. The route surface
// deliberately covers the shapes an audit once found diverging between
// backends - notably a route that sets TWO cookies (they must not be folded
// into one header) and the { success, data } fast-path response shape.
//
// UnifiedRouter is a process-wide singleton, so backends are exercised one at a
// time (reset + create + listen + collect + close per phase) and their captured
// responses are compared afterwards - never two live servers at once. A requested
// backend that silently falls back to Node (missing prebuilt binary, ABI
// mismatch) is EXCLUDED from the cross-comparison rather than compared against
// itself, so the parity assertion can never be vacuously satisfied. When only one
// backend is available the suite still runs and asserts that backend is correct.
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { createApp, param, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { logger, MoroLogger } from '../../src/core/logger/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';
import { fixture, httpsRequest, h2Request } from '../utils/tls-client.js';
import {
  setCookies,
  secureFlags,
  OVER_HTTP,
  OVER_TLS,
  setEveryCookie,
  byCall,
  EVERY_COOKIE,
} from '../utils/cookie-secure-parity.js';
import { signCookieValue } from '../../src/core/middleware/built-in/cookie/index.js';
import {
  createHelperFiles,
  registerHelpers,
  runHelperExchanges,
  expectDocumentedAnswers,
  EXCHANGES,
  BACKEND_SPECIFIC_HEADERS,
  type HelperReply,
} from '../utils/helper-parity.js';

const testPort = () => createTestPort();
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));
const log = (line: string) => process.stdout.write(line + '\n');

type BackendId = 'node' | 'moro';

// The package each engine backend MUST boot for its results to count as that
// backend (guards against a silent fallback to Node polluting the comparison).
const EXPECTED_PACKAGE: Record<Exclude<BackendId, 'node'>, string> = {
  moro: '@morojs/engine',
};

const CANDIDATE_BACKENDS: Array<{ id: BackendId; label: string; available: boolean }> = [
  { id: 'node', label: 'node http', available: true },
  { id: 'moro', label: '@morojs/engine', available: engineLoadable },
];

// Decided at module-load time (NOT from `comparable`, which is populated later in
// beforeAll) so the it/it.skip choice is made before the describe body runs.
const AVAILABLE_BACKEND_COUNT = CANDIDATE_BACKENDS.filter(b => b.available).length;

// ---- Shared route surface (identical registration on every backend) ----------
const POST_ECHO_BODY = { a: 1, b: 'two', nested: { x: true, arr: [9, 8] }, empty: '' };

function registerRoutes(app: any): void {
  // Plain JSON object response
  app.get('/json', () => ({ hello: 'world', n: 42, list: [1, 2, 3], nested: { ok: true } }));
  // The { success, data } fast-path response shape
  app.get('/fast', () => ({ success: true, data: { id: 7, name: 'moro' } }));
  // TWO cookies on one response - each must arrive as its own Set-Cookie header
  app.get('/cookies', (req: any, res: any) => {
    res.cookie('session', 'sess-abc-123', { httpOnly: true, path: '/', sameSite: 'lax' });
    res.cookie('csrf', 'csrf-xyz-789', { path: '/', sameSite: 'strict' });
    res.json({ success: true });
  });
  // Redirect (status + Location, not followed)
  app.get('/go', (req: any, res: any) => res.redirect('/target'));
  // Query-param echo
  app.get('/search', (req: any) => ({ query: req.query }));
  // POST JSON body echo
  app.post('/echo', (req: any) => ({ received: req.body }));
  // (no '/nope' route -> exercises the default 404)
}

// ---- Request table -----------------------------------------------------------
interface Case {
  name: string;
  method: string;
  path: string;
  body?: any;
  headers?: Record<string, string>; // override the defaults a JSON body gets
}
const CASES: Case[] = [
  { name: 'json', method: 'GET', path: '/json' },
  { name: 'fastPath', method: 'GET', path: '/fast' },
  { name: 'twoCookies', method: 'GET', path: '/cookies' },
  { name: 'redirect', method: 'GET', path: '/go' },
  { name: 'notFound', method: 'GET', path: '/nope' },
  { name: 'queryEcho', method: 'GET', path: '/search?a=1&b=hello&c=' },
  { name: 'postEcho', method: 'POST', path: '/echo', body: POST_ECHO_BODY },
];

// ---- Raw node:http client (fetch auto-follows redirects and blurs Set-Cookie
// folding; a raw client preserves status, Location and the per-header cookie
// array exactly as they arrive on the wire). --------------------------------
interface RawResp {
  status: number;
  contentType: string | null;
  location: string | null;
  setCookie: string[];
  body: string;
  json: any;
}

function httpRequest(port: number, c: Case): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const bodyStr = c.body !== undefined ? JSON.stringify(c.body) : undefined;
    const headers: Record<string, string> = {};
    if (bodyStr !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(bodyStr));
    }
    Object.assign(headers, c.headers);
    const req = http.request(
      { host: '127.0.0.1', port, path: c.path, method: c.method, headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const ctHeader = (res.headers['content-type'] as string) || '';
          let json: any = null;
          if (ctHeader.includes('application/json')) {
            try {
              json = JSON.parse(raw);
            } catch {
              json = null;
            }
          }
          const sc = res.headers['set-cookie'];
          resolve({
            status: res.statusCode as number,
            contentType: ctHeader ? ctHeader.split(';')[0].trim() : null,
            location: (res.headers['location'] as string) ?? null,
            setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [],
            body: raw,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// Reduce Set-Cookie header strings to a stable, order-independent set of
// name=value pairs. This catches the folding bug (count of headers) and value
// divergence while ignoring cosmetic attribute serialization differences.
function cookiePairs(setCookie: string[]): Array<{ name: string; value: string }> {
  return setCookie
    .map(c => {
      const nv = c.split(';', 1)[0];
      const eq = nv.indexOf('=');
      return { name: nv.slice(0, eq).trim(), value: nv.slice(eq + 1).trim() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function runBackend(
  id: BackendId
): Promise<{ booted: any; results: Record<string, RawResp> }> {
  resetConfig();
  UnifiedRouter.reset();
  const app = await createApp({ logger: { level: 'fatal' }, server: { engine: id } });
  try {
    registerRoutes(app);
    const port = testPort();
    await listen(app, port);
    const booted = app.engine; // what actually booted (may differ from requested)
    const results: Record<string, RawResp> = {};
    for (const c of CASES) {
      results[c.name] = await httpRequest(port, c);
    }
    return { booted, results };
  } finally {
    await closeApp(app);
    try {
      app.core?.container?.destroy?.();
    } catch {
      // ignore
    }
  }
}

// Collected once for all comparison tests.
const collected: Record<string, { booted: any; results: Record<string, RawResp> }> = {};
const comparable: BackendId[] = [];

describe('Cross-backend HTTP conformance', () => {
  beforeAll(async () => {
    log(
      '[conformance] candidate backends: ' +
        CANDIDATE_BACKENDS.map(b => `${b.id}(${b.available ? 'available' : 'absent'})`).join(', ')
    );

    for (const b of CANDIDATE_BACKENDS) {
      if (!b.available) continue;
      const { booted, results } = await runBackend(b.id);
      const bootedOk =
        b.id === 'node'
          ? booted?.server === 'node'
          : booted?.server === 'engine' && booted?.enginePackage === EXPECTED_PACKAGE[b.id];
      if (bootedOk) {
        collected[b.id] = { booted, results };
        comparable.push(b.id);
      } else {
        log(
          `[conformance] backend '${b.id}' requested but booted ${JSON.stringify(booted)} - ` +
            'excluded from comparison (would be a self-comparison)'
        );
      }
    }
    log(
      `[conformance] backends actually compared (${comparable.length}): ` +
        comparable
          .map(id => `${id}=${collected[id].booted?.enginePackage ?? 'node-http'}`)
          .join(', ')
    );
  }, 120000);

  afterAll(() => {
    resetConfig();
  });

  it('runs against at least the Node backend', () => {
    expect(comparable).toContain('node');
    expect(collected['node']).toBeDefined();
  });

  // Self-consistency: prove the Node baseline is actually correct, so a
  // single-backend environment is not a vacuous pass.
  it('Node backend produces correct responses (baseline correctness)', () => {
    const r = collected['node'].results;

    expect(r.json.status).toBe(200);
    expect(r.json.json).toEqual({ hello: 'world', n: 42, list: [1, 2, 3], nested: { ok: true } });

    expect(r.fastPath.status).toBe(200);
    expect(r.fastPath.json).toEqual({ success: true, data: { id: 7, name: 'moro' } });

    expect(r.twoCookies.status).toBe(200);
    expect(r.twoCookies.json).toEqual({ success: true });
    // Two DISTINCT Set-Cookie headers (not folded into one comma-joined header)
    expect(r.twoCookies.setCookie.length).toBe(2);
    expect(cookiePairs(r.twoCookies.setCookie)).toEqual([
      { name: 'csrf', value: 'csrf-xyz-789' },
      { name: 'session', value: 'sess-abc-123' },
    ]);

    expect(r.redirect.status).toBe(302);
    expect(r.redirect.location).toBe('/target');

    expect(r.notFound.status).toBe(404);
    expect(r.notFound.json?.success).toBe(false);

    expect(r.queryEcho.status).toBe(200);
    expect(r.queryEcho.json).toEqual({ query: { a: '1', b: 'hello', c: '' } });

    expect(r.postEcho.status).toBe(200);
    expect(r.postEcho.json).toEqual({ received: POST_ECHO_BODY });
  });

  // Every backend must set each cookie as its own header (never folded).
  it('every backend emits two distinct Set-Cookie headers', () => {
    for (const id of comparable) {
      expect(collected[id].results.twoCookies.setCookie.length).toBe(2);
      expect(cookiePairs(collected[id].results.twoCookies.setCookie)).toEqual([
        { name: 'csrf', value: 'csrf-xyz-789' },
        { name: 'session', value: 'sess-abc-123' },
      ]);
    }
  });

  // The core parity assertion: identical status, JSON body and cookies across
  // every backend that actually booted. Skipped (not failed) when only one
  // backend is installed here - the baseline test above already covers
  // correctness in that case. (Gated on the module-scope availability count, not
  // on `comparable`, which is only filled in during beforeAll.)
  const crossIt = AVAILABLE_BACKEND_COUNT > 1 ? it : it.skip;
  crossIt('all available backends agree on status, JSON body and Set-Cookie', () => {
    // If every engine backend silently fell back to Node, only 'node' remains -
    // nothing to cross-check, and the baseline test already proved correctness.
    if (comparable.length < 2) {
      log('[conformance] <2 backends actually booted distinctly; cross-comparison is a no-op');
      return;
    }
    const ref = comparable[0];
    for (const id of comparable) {
      for (const c of CASES) {
        const a = collected[ref].results[c.name];
        const b = collected[id].results[c.name];
        const where = `[${id} vs ${ref}] ${c.name}`;
        expect(`${where} status=${b.status}`).toBe(`${where} status=${a.status}`);
        expect({ where, body: b.json }).toEqual({ where, body: a.json });
        expect({ where, cookies: cookiePairs(b.setCookie) }).toEqual({
          where,
          cookies: cookiePairs(a.setCookie),
        });
        expect(`${where} location=${b.location}`).toBe(`${where} location=${a.location}`);
      }
    }
  });
});

// The request-body limit has two tiers: server.bodySizeLimit for ordinary
// bodies and the larger server.maxUploadSize for multipart uploads. The tier is
// chosen by the request's media type, so a content-type parameter that merely
// mentions multipart/form-data stays on the ordinary limit - on every backend.
const SIZE_TIER_BACKENDS: BackendId[] = CANDIDATE_BACKENDS.filter(b => b.available).map(b => b.id);

describe.each(SIZE_TIER_BACKENDS)('Request body size tier on the %s backend', backend => {
  let app: any;

  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    resetConfig();
  });

  it('does not grant the upload limit to a JSON body that mentions multipart', async () => {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      server: { engine: backend, bodySizeLimit: '1kb', maxUploadSize: '1mb' },
    });
    let handlerRan = 0;
    app.post('/echo', (req: any) => {
      handlerRan++;
      return { size: JSON.stringify(req.body ?? null).length };
    });
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

    const big = { a: 'x'.repeat(5000) };
    const small = { a: 'ok' };

    const plain = await httpRequest(port, {
      name: 'plain',
      method: 'POST',
      path: '/echo',
      body: big,
    });
    expect(plain.status).toBe(413);

    const disguised = await httpRequest(port, {
      name: 'disguised',
      method: 'POST',
      path: '/echo',
      body: big,
      headers: { 'content-type': 'application/json; x=multipart/form-data' },
    });
    expect(disguised.status).toBe(413);
    expect(handlerRan).toBe(0);

    // An ordinary body within the limit is unaffected.
    const ok = await httpRequest(port, { name: 'ok', method: 'POST', path: '/echo', body: small });
    expect(ok.status).toBe(200);
    expect(handlerRan).toBe(1);
  });
});

// The fields of an application/x-www-form-urlencoded body are capped by
// server.limits.form.maxFields (1000 unless configured), as the parts of a
// multipart one are by multipart.maxParts: a body with more is answered 413
// and its handler never runs - on every backend.
describe.each(SIZE_TIER_BACKENDS)('Urlencoded field cap on the %s backend', backend => {
  let app: any;
  let handlerRan = 0;

  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    resetConfig();
  });

  const boot = async (limits?: Record<string, unknown>): Promise<number> => {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      routing: false,
      server: { engine: backend, ...(limits ? { limits } : {}) },
    });
    handlerRan = 0;
    app.post('/form', (req: any) => {
      handlerRan++;
      return { fields: Object.keys(req.body).length, last: req.body.k0 };
    });
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    return port;
  };
  const fields = (count: number, value = '1') =>
    Array.from({ length: count }, (_, i) => `k${i}=${value}`).join('&');
  const post = (port: number, body: string, type = 'application/x-www-form-urlencoded') =>
    fetch(`http://127.0.0.1:${port}/form`, {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

  it('answers 200 at server.limits.form.maxFields and 413 one field over', async () => {
    const port = await boot({ form: { maxFields: 5 } });

    const at = await post(port, fields(5));
    expect(at.status).toBe(200);
    expect(await at.json()).toEqual({ fields: 5, last: '1' });

    const over = await post(port, fields(6));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ success: false, error: 'Request entity too large' });
    expect(handlerRan).toBe(1);

    // Not ASCII, which the engine reads as bytes instead of text: the same cap
    expect((await post(port, fields(5, 'é'))).status).toBe(200);
    expect((await post(port, fields(6, 'é'))).status).toBe(413);

    // A repeated name is a field each time it is sent, and its last value stays
    const repeated = await post(port, 'k0=a&k0=b&k0=c&k0=d&k0=e');
    expect(await repeated.json()).toEqual({ fields: 1, last: 'e' });
    expect((await post(port, 'k0=a&k0=b&k0=c&k0=d&k0=e&k0=f')).status).toBe(413);
  });

  it('caps a form at 1000 fields when nothing is configured', async () => {
    const port = await boot();

    const at = await post(port, fields(1000));
    expect(at.status).toBe(200);
    expect(await at.json()).toEqual({ fields: 1000, last: '1' });

    // The body the cap is for: 100,000 fields in under a megabyte
    const flood = fields(100000);
    expect(Buffer.byteLength(flood)).toBeLessThan(1024 * 1024);
    for (const body of [fields(1001), flood]) {
      const over = await post(port, body);
      expect(over.status).toBe(413);
    }
    expect(handlerRan).toBe(1);

    // The connection and the server are as they were
    expect((await post(port, 'k0=still&b=here')).status).toBe(200);
  });

  it('leaves a body of another type alone, however many separators it holds', async () => {
    const port = await boot({ form: { maxFields: 5 } });
    app.post('/text', (req: any) => ({ length: String(req.body).length }));

    const text = fields(2000);
    const res = await fetch(`http://127.0.0.1:${port}/text`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: text,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: text.length });
  });
});

// Global middleware and request hooks are in front of every route, whatever
// its handler is: a function, a literal body, or param(). (The native engine
// can answer the last two by itself, and does so only for an app that has
// neither.) Each backend must give the same answers.
describe.each(SIZE_TIER_BACKENDS)(
  'Global middleware in front of literal-body and param() routes on the %s backend',
  backend => {
    let app: any;
    let port: number;

    afterEach(async () => {
      if (app) await closeApp(app);
      app = undefined;
      resetConfig();
    });

    async function createGuardedApp(options: any = {}) {
      resetConfig();
      UnifiedRouter.reset();
      app = await createApp({
        logger: { level: 'fatal' },
        autoDiscover: false,
        routing: false,
        ...options,
        server: { engine: backend, requestLogging: { enabled: false } },
      });
      app.get('/fn', () => ({ ok: true }));
      app.get('/banner', 'build 1.2.3');
      app.get('/config', '{"feature":true}');
      app.get('/user/:id').handler(param('id'));
      return app;
    }

    async function start() {
      port = testPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    }

    const ROUTES = ['/fn', '/banner', '/config', '/user/42'];

    it('a guard registered with app.use() answers for all of them', async () => {
      await createGuardedApp();
      const guarded: string[] = [];
      await app.use((req: any, res: any, _next: () => void) => {
        guarded.push(req.path);
        res.status(401).json({ error: 'sign in' });
      });
      await start();

      for (const route of ROUTES) {
        const reply = await helperRequest(port, route);
        expect(`${route} ${reply.status}`).toBe(`${route} 401`);
        expect(JSON.parse(reply.text)).toEqual({ error: 'sign in' });
      }
      expect(guarded).toEqual(ROUTES);
    });

    it('middleware and a request hook registered after listen() run for all of them', async () => {
      await createGuardedApp();
      await start();

      const order: string[] = [];
      app.hooks.before('request', (context: any) => {
        order.push(`hook ${context.request.path}`);
      });
      await app.use((req: any, res: any, next: () => void) => {
        order.push(`middleware ${req.path}`);
        res.setHeader('X-Checked', 'yes');
        next();
      });

      for (const route of ROUTES) {
        const reply = await helperRequest(port, route);
        expect(`${route} ${reply.status}`).toBe(`${route} 200`);
        expect(reply.headers['x-checked']).toBe('yes');
      }
      expect(order).toEqual(ROUTES.flatMap(route => [`hook ${route}`, `middleware ${route}`]));

      // Behind the middleware each route still answers what it always did.
      expect((await helperRequest(port, '/banner')).text).toBe('build 1.2.3');
      expect(JSON.parse((await helperRequest(port, '/config')).text)).toEqual({ feature: true });
      expect((await helperRequest(port, '/user/42')).text).toBe('42');
    });

    it('config-driven helmet and CORS apply to all of them', async () => {
      await createGuardedApp({
        security: {
          helmet: { enabled: true },
          cors: { enabled: true, origin: 'https://app.example' },
        },
      });
      await start();

      for (const route of ROUTES) {
        const reply = await helperRequest(port, route, {
          headers: { origin: 'https://app.example' },
        });
        expect(`${route} ${reply.status}`).toBe(`${route} 200`);
        expect(reply.headers['x-content-type-options']).toBe('nosniff');
        expect(reply.headers['access-control-allow-origin']).toBe('https://app.example');
      }
    });

    // The rate limit and the CSRF check answer before the application's CORS
    // runs: always when a configuration section installs them, and whenever
    // their hook is ahead of CORS when the application installs them. A page
    // on an allowed origin must still be able to read what they answer, and a
    // preflight is CORS's own to answer.
    const ALLOWED = { origin: 'https://app.example' };
    const CORS = {
      origin: ['https://app.example'],
      credentials: true,
      exposedHeaders: ['Retry-After'],
    };
    const corsOf = (reply: HelperReply) => ({
      allowOrigin: reply.headers['access-control-allow-origin'],
      credentials: reply.headers['access-control-allow-credentials'],
      exposed: reply.headers['access-control-expose-headers'],
      vary: reply.headers.vary,
    });
    const READABLE = {
      allowOrigin: 'https://app.example',
      credentials: 'true',
      exposed: 'Retry-After',
      vary: 'Origin',
    };
    const preflight = (method: string) =>
      helperRequest(port, '/fn', {
        method: 'OPTIONS',
        headers: { ...ALLOWED, 'access-control-request-method': method },
      });

    // Everything logged at error level while `run` is in progress
    async function errorsLoggedDuring(run: () => Promise<void>): Promise<string[]> {
      const logged: string[] = [];
      logger.addOutput({
        name: 'refusal-errors',
        write: (entry: any) => {
          logged.push(String(entry.message));
        },
      } as any);
      try {
        await run();
      } finally {
        logger.removeOutput('refusal-errors');
      }
      return logged;
    }

    const INSTALLED = ['the configuration', 'app.use()'];

    it.each(INSTALLED)(
      'a rate limit installed by %s refuses with the CORS headers of security.cors',
      async how => {
        const limit = { requests: 2, window: 60000 };
        await createGuardedApp({
          security: {
            cors: { enabled: true, ...CORS },
            ...(how === 'app.use()' ? {} : { rateLimit: { global: { enabled: true, ...limit } } }),
          },
        });
        if (how === 'app.use()') await app.use(middleware.rateLimit(limit));
        await start();

        // More preflights than the limit allows requests: each one is answered
        // by CORS, and none is held against the client
        for (let i = 0; i < 4; i++) {
          const reply = await preflight('GET');
          expect(`preflight ${i}: ${reply.status}`).toBe(`preflight ${i}: 204`);
          expect(corsOf(reply)).toEqual(READABLE);
        }

        const served = await helperRequest(port, '/fn', { headers: ALLOWED });
        expect(served.status).toBe(200);
        expect(corsOf(served)).toEqual(READABLE);
        expect((await helperRequest(port, '/fn', { headers: ALLOWED })).status).toBe(200);

        const refused = await helperRequest(port, '/fn', { headers: ALLOWED });
        expect(refused.status).toBe(429);
        expect(refused.headers['retry-after']).toBe('60');
        expect(corsOf(refused)).toEqual(corsOf(served));

        // An origin the application does not allow is named no CORS headers
        const foreign = await helperRequest(port, '/fn', {
          headers: { origin: 'https://evil.example' },
        });
        expect(foreign.status).toBe(429);
        expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
        expect(foreign.headers['access-control-allow-credentials']).toBeUndefined();
      }
    );

    it.each(INSTALLED)(
      'a CSRF check installed by %s refuses with the CORS headers of security.cors',
      async how => {
        // OPTIONS is checked like any other method here
        const check = { ignoreMethods: ['GET', 'HEAD'] };
        await createGuardedApp({
          security: {
            cors: { enabled: true, ...CORS },
            ...(how === 'app.use()' ? {} : { csrf: { enabled: true, ...check } }),
          },
        });
        if (how === 'app.use()') await app.use(middleware.csrf(check));
        await start();

        const served = await helperRequest(port, '/fn', { headers: ALLOWED });
        expect(served.status).toBe(200);

        const refused = await helperRequest(port, '/fn', { method: 'POST', headers: ALLOWED });
        expect(refused.status).toBe(403);
        expect(JSON.parse(refused.text).code).toBe('CSRF_TOKEN_MISMATCH');
        expect(corsOf(refused)).toEqual(READABLE);
        expect(corsOf(refused)).toEqual(corsOf(served));

        // The preflight for that POST carries no token and needs none
        const asked = await preflight('POST');
        expect(asked.status).toBe(204);
        expect(corsOf(asked)).toEqual(READABLE);

        const foreign = await helperRequest(port, '/fn', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        });
        expect(foreign.status).toBe(403);
        expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
      }
    );

    it.each(INSTALLED)(
      'a rate limit installed by %s ahead of app.use(middleware.cors()) does the same',
      async how => {
        const limit = { requests: 1, window: 60000 };
        await createGuardedApp({
          logger: { level: 'error' },
          ...(how === 'app.use()'
            ? {}
            : { security: { rateLimit: { global: { enabled: true, ...limit } } } }),
        });
        if (how === 'app.use()') await app.use(middleware.rateLimit(limit));
        await app.use(middleware.cors(CORS));
        await start();

        const logged = await errorsLoggedDuring(async () => {
          for (let i = 0; i < 3; i++) expect((await preflight('GET')).status).toBe(204);

          const served = await helperRequest(port, '/fn', { headers: ALLOWED });
          expect(served.status).toBe(200);
          const refused = await helperRequest(port, '/fn', { headers: ALLOWED });
          expect(refused.status).toBe(429);
          expect(corsOf(refused)).toEqual(corsOf(served));
          expect(corsOf(refused).allowOrigin).toBe('https://app.example');
        });
        // The CORS hook has nothing to add to a request that was already answered
        expect(logged).toEqual([]);
      }
    );

    it('with CORS registered first, a refusal carries its headers and CORS decides once', async () => {
      await createGuardedApp();
      const asked: string[] = [];
      await app.use(
        middleware.cors({
          origin: (origin: string | undefined) => {
            asked.push(String(origin));
            return origin === ALLOWED.origin ? origin : false;
          },
          credentials: true,
        })
      );
      await app.use(middleware.rateLimit({ requests: 1, window: 60000 }));
      await start();

      expect((await preflight('GET')).status).toBe(204);
      expect((await preflight('GET')).status).toBe(204);
      const served = await helperRequest(port, '/fn', { headers: ALLOWED });
      expect(served.status).toBe(200);
      const refused = await helperRequest(port, '/fn', { headers: ALLOWED });
      expect(refused.status).toBe(429);
      expect(corsOf(refused)).toEqual(corsOf(served));
      expect(corsOf(refused).allowOrigin).toBe(ALLOWED.origin);
      // One decision per request, the refused one included
      expect(asked).toHaveLength(4);
    });

    // Every built-in a configuration section installs, and behind the rate
    // limit every hook-based built-in an application can add with app.use().
    // When the limit refuses a request, none of them has anything left to do.
    it('a configured refusal is answered once, with nothing logged at error level', async () => {
      await createGuardedApp({
        logger: { level: 'error' },
        security: {
          cors: { enabled: true, ...CORS },
          helmet: { enabled: true },
          csp: { enabled: true },
          csrf: { enabled: true },
          rateLimit: { global: { enabled: true, requests: 1, window: 60000 } },
        },
        modules: { session: { enabled: true, secret: 'a-secret-for-this-test-only-0123456789' } },
        performance: { compression: { enabled: true } },
      });
      await start();

      const logged = await errorsLoggedDuring(async () => {
        const served = await helperRequest(port, '/fn', { headers: ALLOWED });
        expect(served.status).toBe(200);
        const refused = await helperRequest(port, '/fn', { headers: ALLOWED });
        expect(refused.status).toBe(429);
        expect(JSON.parse(refused.text)).toEqual({
          success: false,
          error: 'Too many requests',
          retryAfter: 60,
        });
        expect(refused.headers['x-content-type-options']).toBe('nosniff');
        expect(corsOf(refused).allowOrigin).toBe('https://app.example');
        // Refused before the session: no cookie is handed out
        expect(refused.headers['set-cookie']).toBeUndefined();
      });
      expect(logged).toEqual([]);
    });

    it('hook-based built-ins behind a configured refusal leave the answer alone', async () => {
      await createGuardedApp({
        logger: { level: 'error' },
        security: { rateLimit: { global: { enabled: true, requests: 1, window: 60000 } } },
      });
      await app.use(middleware.cors(CORS));
      await app.use(middleware.csp({}));
      await app.use(middleware.cookie({}));
      await app.use(middleware.session({ secret: 'a-secret-for-this-test-only-0123456789' }));
      await app.use(middleware.csrf({}));
      await app.use(middleware.cache({ adapter: 'memory' }));
      await app.use(middleware.sse({}));
      await app.use(middleware.validation());
      await app.use(
        middleware.cdn({
          adapter: {
            purge: async () => undefined,
            setHeaders: (res: any) => res.setHeader('CDN-Cache-Control', 'max-age=60'),
          },
        })
      );
      await start();

      const logged = await errorsLoggedDuring(async () => {
        expect((await helperRequest(port, '/fn', { headers: ALLOWED })).status).toBe(200);
        const refused = await helperRequest(port, '/fn', { headers: ALLOWED });
        expect(refused.status).toBe(429);
        expect(corsOf(refused).allowOrigin).toBe('https://app.example');
        expect(refused.headers['content-security-policy']).toBeUndefined();
        expect(refused.headers['set-cookie']).toBeUndefined();
        expect(refused.headers['x-cache']).toBeUndefined();
        expect(refused.headers['cdn-cache-control']).toBeUndefined();
      });
      expect(logged).toEqual([]);
    });
  }
);

// ---------------------------------------------------------------------------
// The request and response helpers (req.hostname, res.download, res.redirect,
// res.sendFile, ...), exercised through the table in tests/utils/helper-parity:
// the Node http server's answers are the documented ones, and every other
// backend must give the same status, headers and body to each exchange.
// ---------------------------------------------------------------------------

// One request, replied with everything the comparison reads.
function helperRequest(
  port: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HelperReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', d => chunks.push(d as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode as number,
            headers: res.headers as Record<string, any>,
            body,
            text: body.toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

// Raw bytes in; everything the server sent back, and whether it closed the socket.
function rawExchange(
  port: number,
  bytes: string,
  waitMs = 1500
): Promise<{ text: string; closed: boolean }> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    let text = '';
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, closed });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    socket.on('data', d => (text += d.toString('latin1')));
    socket.on('close', () => finish(true));
    socket.on('error', () => finish(true));
  });
}

const mediaType = (contentType: unknown): string | undefined =>
  typeof contentType === 'string' ? contentType.split(';')[0].trim() : undefined;

const HELPER_BACKENDS: BackendId[] = CANDIDATE_BACKENDS.filter(b => b.available).map(b => b.id);

describe('Request and response helpers across backends', () => {
  const files = createHelperFiles();
  let app: any;

  afterAll(() => files.remove());

  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    resetConfig();
  });

  async function boot(
    backend: BackendId,
    register: (a: any) => void | Promise<void>,
    options: Record<string, unknown> = {}
  ): Promise<number> {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      server: { engine: backend },
      ...options,
    });
    await register(app);
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    return port;
  }

  it('every backend gives the documented answer to every helper call', async () => {
    const seen: Record<string, Record<string, any>> = {};
    const closedRequests: Record<string, number> = {};
    for (const backend of HELPER_BACKENDS) {
      const port = await boot(backend, a => registerHelpers(a, files));
      seen[backend] = await runHelperExchanges(helperRequest, 'host', port, files);
      closedRequests[backend] = app.closedRequests;
      await closeApp(app);
      app = undefined;
    }

    expectDocumentedAnswers(seen.node, files);
    expect(closedRequests.node).toBe(1);

    for (const backend of HELPER_BACKENDS) {
      if (backend === 'node') continue;
      // Every exchange that differs, reported together
      const differences: Record<string, { expected: any; actual: any }> = {};
      for (const [name] of EXCHANGES) {
        const expected = { ...seen.node[name], headers: { ...seen.node[name].headers } };
        const actual = { ...seen[backend][name], headers: { ...seen[backend][name].headers } };
        for (const header of BACKEND_SPECIFIC_HEADERS[name] ?? []) {
          delete expected.headers[header];
          delete actual.headers[header];
        }
        // The media type is what is compared: whether a charset parameter
        // follows it has always differed between the backends.
        expected.headers['content-type'] = mediaType(expected.headers['content-type']);
        actual.headers['content-type'] = mediaType(actual.headers['content-type']);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          differences[name] = { expected, actual };
        }
      }
      expect({ backend, differences }).toEqual({ backend, differences: {} });
      expect({ backend, closed: closedRequests[backend] }).toEqual({ backend, closed: 1 });
    }
  });

  describe.each(HELPER_BACKENDS)('on the %s backend', backend => {
    it('does not leave the client waiting when a handler fails after the response has started', async () => {
      const port = await boot(backend, a => {
        // No declared length: the body is chunked
        a.get('/late', async (_req: any, res: any) => {
          res.setHeader('Content-Type', 'text/plain');
          res.write('partial');
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error('failed after the first chunk');
        });
        // A declared length the handler never reaches
        a.get('/late-with-length', async (_req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
          res.write('partial');
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error('failed after the first chunk');
        });
        // The same failure from app.use() middleware, ahead of the router
        a.use(async (req: any, res: any, next: () => void) => {
          if (req.path !== '/late-middleware') return next();
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
          res.write('partial');
          await new Promise(resolve => setTimeout(resolve, 20));
          throw new Error('failed after the first chunk');
        });
        a.get('/done-then-throws', (_req: any, res: any) => {
          res.json({ done: true });
          throw new Error('after the response');
        });
      });

      // Short of its declared length: the connection is closed, so the client
      // sees a truncated transfer on every backend.
      for (const urlPath of ['/late-with-length', '/late-middleware']) {
        const out = await rawExchange(port, `GET ${urlPath} HTTP/1.1\r\nHost: t\r\n\r\n`);
        expect({ urlPath, closed: out.closed }).toEqual({ urlPath, closed: true });
        expect(out.text).toMatch(/^HTTP\/1\.1 200 /);
        expect(out.text.endsWith('partial')).toBe(true);
      }

      // Chunked: the response is over one way or the other. The Node server
      // drops the connection; the engine can only terminate the body.
      const chunked = await rawExchange(port, 'GET /late HTTP/1.1\r\nHost: t\r\n\r\n', 1000);
      expect(chunked.text).toContain('partial');
      expect(chunked.closed || chunked.text.endsWith('0\r\n\r\n')).toBe(true);

      // A response the handler finished is left alone, whatever it throws afterwards
      const done = await helperRequest(port, '/done-then-throws');
      expect(done.status).toBe(200);
      expect(JSON.parse(done.text)).toEqual({ done: true });
    });

    it('res.destroy() abandons a response instead of leaving it open', async () => {
      const port = await boot(backend, a => {
        a.get('/abandon', (_req: any, res: any) => {
          res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '100' });
          res.write('partial');
          res.destroy();
        });
      });

      // Closed by the server, well short of the 100 bytes it declared
      const out = await rawExchange(port, 'GET /abandon HTTP/1.1\r\nHost: t\r\n\r\n');
      expect(out.closed).toBe(true);
      expect(out.text.length).toBeLessThan(200);
    });

    it('res.download() never rejects, whatever it is called with', async () => {
      let outcome: Promise<string> | undefined;
      const port = await boot(backend, a => {
        a.get('/bad-call', (_req: any, res: any) => {
          outcome = res.download(undefined).then(
            () => 'resolved',
            () => 'rejected'
          );
        });
      });

      const res = await helperRequest(port, '/bad-call');
      expect(res.status).toBe(500);
      expect(await outcome).toBe('resolved');
    });

    it('the default 500 from app.use() middleware carries no representation headers', async () => {
      const port = await boot(backend, a => {
        a.use((req: any, res: any, next: () => void) => {
          if (req.path !== '/mw-boom') return next();
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Cache-Control', 'public, max-age=31536000');
          res.setHeader('ETag', '"abc"');
          res.setHeader('Access-Control-Allow-Origin', '*');
          throw new Error('boom');
        });
        a.get('/ok', () => ({ ok: true }));
      });

      const res = await helperRequest(port, '/mw-boom');
      expect(res.status).toBe(500);
      expect(JSON.parse(res.text)).toMatchObject({ success: false });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers['etag']).toBeUndefined();
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('a 204 from res.json() carries no Content-Length', async () => {
      const port = await boot(backend, a => {
        a.get('/no-content', (_req: any, res: any) => res.status(204).json({ a: 1 }));
      });

      const noContent = await rawExchange(
        port,
        'GET /no-content HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n'
      );
      expect(noContent.text).toMatch(/^HTTP\/1\.1 204 /);
      expect(noContent.text).not.toMatch(/content-length/i);
    });

    it('res.json() with compression on: a refused encoding and an undefined value', async () => {
      const big = { pad: 'x'.repeat(40000) };
      const port = await boot(
        backend,
        a => {
          a.get('/big', (_req: any, res: any) => res.json(big));
          a.get('/undefined', (_req: any, res: any) => res.status(202).json(undefined));
          a.get('/undefined-with-header', (_req: any, res: any) => {
            res.setHeader('X-Extra', '1');
            res.status(202).json(undefined);
          });
        },
        { performance: { compression: { enabled: true } } }
      );

      const refused = await helperRequest(port, '/big', {
        headers: { 'accept-encoding': 'gzip;q=0, identity' },
      });
      expect(refused.status).toBe(200);
      expect(refused.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(refused.text)).toEqual(big);

      const gzipped = await helperRequest(port, '/big', { headers: { 'accept-encoding': 'gzip' } });
      expect(gzipped.headers['content-encoding']).toBe('gzip');

      for (const urlPath of ['/undefined', '/undefined-with-header']) {
        const res = await helperRequest(port, urlPath, { headers: { 'accept-encoding': 'gzip' } });
        expect({ urlPath, status: res.status, body: res.text }).toEqual({
          urlPath,
          status: 202,
          body: '',
        });
        expect(String(res.headers['content-type'])).toContain('application/json');
      }
    });
  });
});

// server.trustProxy decides when X-Forwarded-For / -Proto / -Host count. The
// same request, sent straight to each server with those headers on it, must
// be read the same way by the Node server, the HTTP/2 server and the engine.
describe('server.trustProxy across backends', () => {
  type ProxyBackend = 'node' | 'http2' | 'moro';
  const PROXY_BACKENDS: ProxyBackend[] = [
    'node',
    'http2',
    ...(engineLoadable ? ['moro' as const] : []),
  ];

  // What a proxy chain client -> 10.0.0.2 -> this server would send, except
  // that the test itself (127.0.0.1) is the connected peer
  const FORWARDED = {
    'x-forwarded-for': '203.0.113.9, 10.0.0.2',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'public.example:8443',
  };

  let app: any;
  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    resetConfig();
  });

  async function boot(backend: ProxyBackend, trustProxy: unknown): Promise<number> {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      server: {
        engine: backend === 'moro' ? 'moro' : 'node',
        ...(backend === 'http2' ? { http2: true } : {}),
        ...(trustProxy === undefined ? {} : { trustProxy }),
      },
    } as any);
    app.get('/who', (req: any) => ({
      ip: req.ip,
      ips: req.ips,
      protocol: req.protocol,
      secure: req.secure,
      hostname: req.hostname,
      peer: req.socket.remoteAddress,
    }));
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    expect(app.getServerKind().server).toBe(backend === 'moro' ? 'engine' : backend);
    return port;
  }

  function who(backend: ProxyBackend, port: number): Promise<any> {
    if (backend !== 'http2') {
      return helperRequest(port, '/who', { headers: FORWARDED }).then(res => JSON.parse(res.text));
    }
    // Cleartext HTTP/2 (prior knowledge)
    return new Promise((resolve, reject) => {
      const session = http2.connect(`http://127.0.0.1:${port}`);
      session.once('error', reject);
      const req = session.request({ ':path': '/who', ...FORWARDED });
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.once('error', reject);
      req.once('end', () => {
        session.close();
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
      req.end();
    });
  }

  const direct = {
    ip: '127.0.0.1',
    ips: [],
    protocol: 'http',
    secure: false,
    hostname: '127.0.0.1',
  };
  const viaProxy = { protocol: 'https', secure: true, hostname: 'public.example' };

  // Not set: as before the setting existed. The address is the peer's, while
  // req.ips, req.protocol and req.secure read the headers from anyone.
  const notSet = { ...direct, ips: ['203.0.113.9', '10.0.0.2'], protocol: 'https', secure: true };

  const CASES: Array<[label: string, trustProxy: unknown, expected: Record<string, unknown>]> = [
    ['0 hops', 0, direct],
    ['true', true, { ...viaProxy, ip: '203.0.113.9', ips: ['203.0.113.9', '10.0.0.2'] }],
    ['1 hop', 1, { ...viaProxy, ip: '10.0.0.2', ips: ['10.0.0.2'] }],
    ['2 hops', 2, { ...viaProxy, ip: '203.0.113.9', ips: ['203.0.113.9', '10.0.0.2'] }],
    ['the peer by name', 'loopback', { ...viaProxy, ip: '10.0.0.2', ips: ['10.0.0.2'] }],
    [
      'the peer and the proxy behind it, as ranges',
      ['127.0.0.1/32', '10.0.0.0/8'],
      { ...viaProxy, ip: '203.0.113.9', ips: ['203.0.113.9', '10.0.0.2'] },
    ],
    // The connected peer is not in the list: nothing it sends is believed
    ['a list without the peer', ['10.0.0.0/8', '::1'], direct],
  ];

  it('trustProxy false trusts no proxy, which is not what leaving it unset does', async () => {
    for (const backend of PROXY_BACKENDS) {
      for (const [trustProxy, expected] of [
        [undefined, notSet],
        [false, direct],
      ] as const) {
        const port = await boot(backend, trustProxy);
        const seen = await who(backend, port);
        expect({ backend, trustProxy, ...seen }).toEqual({
          backend,
          trustProxy,
          ...expected,
          peer: '127.0.0.1',
        });
        await closeApp(app);
        app = undefined;
      }
    }
  });

  it.each(CASES)('trustProxy %s', async (_label, trustProxy, expected) => {
    for (const backend of PROXY_BACKENDS) {
      const port = await boot(backend, trustProxy);
      const seen = await who(backend, port);
      // The socket's own address is never replaced by a forwarded one
      expect({ backend, ...seen }).toEqual({ backend, ...expected, peer: '127.0.0.1' });
      await closeApp(app);
      app = undefined;
    }
  });
});

// A cookie set with no `secure` option is Secure when the request arrived
// over TLS: a TLS connection to this server, or https as reported by a proxy
// named in server.trustProxy. Over plain http, and behind a proxy nobody
// named, it is the cookie it always was.
describe('cookie Secure follows the connection across backends', () => {
  type CookieBackend = 'node' | 'http2' | 'moro';
  const COOKIE_BACKENDS: CookieBackend[] = [
    'node',
    'http2',
    ...(engineLoadable ? ['moro' as const] : []),
  ];
  const HTTPS = { 'x-forwarded-proto': 'https' };
  const COOKIE_SECRET = 'cookie-parity-secret';

  let app: any;
  afterEach(async () => {
    if (app) await closeApp(app);
    app = undefined;
    resetConfig();
  });

  async function boot(
    backend: CookieBackend,
    options: { trustProxy?: unknown; tls?: boolean; cookieMiddleware?: boolean } = {}
  ): Promise<number> {
    resetConfig();
    UnifiedRouter.reset();
    app = await createApp({
      logger: { level: 'fatal' },
      autoDiscover: false,
      server: {
        engine: backend === 'moro' ? 'moro' : 'node',
        ...(backend === 'http2' ? { http2: true } : {}),
        ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
        ...(options.tls
          ? { ssl: { key: fixture('localhost.key'), cert: fixture('localhost.pem') } }
          : {}),
      },
    } as any);
    // The cookie middleware replaces res.cookie() with its own writer
    if (options.cookieMiddleware) app.use(middleware.cookie({ secret: COOKIE_SECRET }));
    app.get('/set', setCookies);
    app.get('/every', setEveryCookie);
    app.get('/signed', (_req: any, res: any) => {
      res.cookie('signed', 'v', { signed: true, httpOnly: true });
      res.cookie('unsigned', 'v', { signed: false });
      res.json({ ok: true });
    });
    const port = testPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
    expect(app.getServerKind().server).toBe(backend === 'moro' ? 'engine' : backend);
    return port;
  }

  // The Set-Cookie values of GET /set, over the protocol the server speaks
  async function cookies(
    backend: CookieBackend,
    port: number,
    tls: boolean,
    headers: Record<string, string> = {},
    path = '/set'
  ): Promise<string[]> {
    if (backend === 'http2') {
      if (tls) return [(await h2Request(port, path, { headers })).headers['set-cookie']].flat();
      return new Promise((resolve, reject) => {
        const session = http2.connect(`http://127.0.0.1:${port}`);
        session.once('error', reject);
        const req = session.request({ ':path': path, ...headers });
        req.once('response', h => {
          req.resume();
          req.once('end', () => {
            session.close();
            resolve([h['set-cookie']].flat() as string[]);
          });
        });
        req.once('error', reject);
        req.end();
      });
    }
    const reply = tls
      ? await httpsRequest(port, path, { headers })
      : await helperRequest(port, path, { headers });
    return [reply.headers['set-cookie']].flat() as string[];
  }

  for (const cookieMiddleware of [false, true]) {
    const writer = cookieMiddleware ? 'middleware.cookie()' : 'res.cookie()';
    const flagsOf = async (
      backend: CookieBackend,
      port: number,
      tls: boolean,
      headers?: Record<string, string>
    ) => ({ backend, ...secureFlags(await cookies(backend, port, tls, headers)) });
    const stop = async () => {
      await closeApp(app);
      app = undefined;
    };

    it(`${writer}: Secure by default when the request arrived over TLS, and only then`, async () => {
      for (const backend of COOKIE_BACKENDS) {
        // Plain http: only an explicit `secure` counts
        let port = await boot(backend, { cookieMiddleware });
        const direct = await cookies(backend, port, false);
        expect({ backend, ...secureFlags(direct) }).toEqual({ backend, ...OVER_HTTP });
        // X-Forwarded-Proto from a peer nobody named: the very same cookies
        expect({ backend, cookies: await cookies(backend, port, false, HTTPS) }).toEqual({
          backend,
          cookies: direct,
        });
        await stop();

        // https as reported by a proxy named in server.trustProxy
        port = await boot(backend, { trustProxy: 'loopback', cookieMiddleware });
        expect(await flagsOf(backend, port, false, HTTPS)).toEqual({ backend, ...OVER_TLS });
        // The same proxy forwarding a plain http request, and no header at all
        expect(await flagsOf(backend, port, false, { 'x-forwarded-proto': 'http' })).toEqual({
          backend,
          ...OVER_HTTP,
        });
        expect(await flagsOf(backend, port, false)).toEqual({ backend, ...OVER_HTTP });
        await stop();

        // The connected peer is not one of the named proxies
        port = await boot(backend, { trustProxy: ['10.0.0.0/8'], cookieMiddleware });
        expect(await flagsOf(backend, port, false, HTTPS)).toEqual({ backend, ...OVER_HTTP });
        await stop();

        // A TLS connection to this server
        port = await boot(backend, { tls: true, cookieMiddleware });
        expect(await flagsOf(backend, port, true)).toEqual({ backend, ...OVER_TLS });
        await stop();

        // TLS only between a named proxy and this server: the client used http
        port = await boot(backend, { tls: true, trustProxy: true, cookieMiddleware });
        expect(await flagsOf(backend, port, true, { 'x-forwarded-proto': 'http' })).toEqual({
          backend,
          ...OVER_HTTP,
        });
        await stop();
      }
    });
  }

  // One table of calls (tests/utils/cookie-secure-parity.ts), and the bytes
  // the Node HTTP/1 server sends for each: every server sends the same, from
  // res.cookie() and from the writer the cookie middleware puts in its place.
  for (const cookieMiddleware of [false, true]) {
    const writer = cookieMiddleware ? 'middleware.cookie()' : 'res.cookie()';

    it(`${writer}: every option sends the same Set-Cookie on every backend`, async () => {
      for (const backend of COOKIE_BACKENDS) {
        const port = await boot(backend, { cookieMiddleware });
        const sent = await cookies(backend, port, false, {}, '/every');
        expect({ backend, ...byCall(sent) }).toEqual({ backend, ...EVERY_COOKIE });
        expect(sent).toHaveLength(Object.keys(EVERY_COOKIE).length);
        await closeApp(app);
        app = undefined;
      }
    });
  }

  it('middleware.cookie(): a signed cookie is the same Set-Cookie on every backend', async () => {
    const signed = encodeURIComponent(signCookieValue('v', COOKIE_SECRET));
    for (const backend of COOKIE_BACKENDS) {
      const port = await boot(backend, { cookieMiddleware: true });
      expect({ backend, sent: await cookies(backend, port, false, {}, '/signed') }).toEqual({
        backend,
        sent: [`signed=${signed}; HttpOnly; Path=/`, 'unsigned=v; Path=/'],
      });
      await closeApp(app);
      app = undefined;
    }
  });

  it('says once that SameSite=None without Secure is a cookie browsers drop', async () => {
    const port = await boot('node');
    app.get('/none', (_req: any, res: any) => {
      res.cookie('cross', '1', { sameSite: 'none' });
      res.cookie('cross2', '1', { sameSite: 'None' });
      res.cookie('fine', '1', { sameSite: 'none', secure: true });
      res.json({ ok: true });
    });
    // warn() is a noop below the active level: raise it and read the shared sink
    logger.setLevel('warn');
    const log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    try {
      await helperRequest(port, '/none');
      await helperRequest(port, '/none');
      const said = log.mock.calls.filter(
        ([level, message]) => level === 'warn' && /SameSite=None/.test(String(message))
      );
      expect(said).toHaveLength(1);
      expect(String(said[0][1])).toMatch(/'cross'.*without Secure/);
    } finally {
      log.mockRestore();
      logger.setLevel('error');
    }
  });
});
