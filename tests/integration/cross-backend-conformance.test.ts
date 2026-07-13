// @ts-nocheck
// Integration Tests - cross-backend HTTP conformance harness. One table-driven
// suite asserts that the SAME request produces the SAME response across every
// HTTP backend available on this platform:
//   - 'node' : the Node.js http server            (always present)
//   - 'moro' : the native @morojs/engine          (when it loads)
//   - 'uws'  : uWebSockets.js                      (only when resolvable/loadable)
//
// This makes Moro's parity guarantee explicit and executable. The route surface
// deliberately covers the shapes the audit found diverging between uWS and the
// others - notably a route that sets TWO cookies (the uWS Set-Cookie *folding*
// bug: two cookies collapsed into one header) and the { success, data } fast-path
// response shape.
//
// UnifiedRouter is a process-wide singleton, so backends are exercised one at a
// time (reset + create + listen + collect + close per phase) and their captured
// responses are compared afterwards - never two live servers at once. A requested
// backend that silently falls back to Node (missing prebuilt binary, ABI
// mismatch) is EXCLUDED from the cross-comparison rather than compared against
// itself, so the parity assertion can never be vacuously satisfied. When only one
// backend is available the suite still runs and asserts that backend is correct.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';

// uWebSockets.js is a legacy user-installed peer; probe it directly (a
// candidate-override load bypasses the default-engine memoization).
const uwsLoadable = (() => {
  try {
    return loadNativeEngine({ candidates: ['uWebSockets.js'] }) !== null;
  } catch {
    return false;
  }
})();

const testPort = () => 10100 + Math.floor(Math.random() * 5000);
const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));
const log = (line: string) => process.stdout.write(line + '\n');

type BackendId = 'node' | 'moro' | 'uws';

// The package each engine backend MUST boot for its results to count as that
// backend (guards against a silent fallback to Node polluting the comparison).
const EXPECTED_PACKAGE: Record<Exclude<BackendId, 'node'>, string> = {
  moro: '@morojs/engine',
  uws: 'uWebSockets.js',
};

const CANDIDATE_BACKENDS: Array<{ id: BackendId; label: string; available: boolean }> = [
  { id: 'node', label: 'node http', available: true },
  { id: 'moro', label: '@morojs/engine', available: engineLoadable },
  { id: 'uws', label: 'uWebSockets.js', available: uwsLoadable },
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

  // Every backend must set each cookie as its own header (the uWS folding guard).
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
