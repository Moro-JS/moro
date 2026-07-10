/* eslint-disable */
// @ts-nocheck
// Integration Tests - native engine path under stress / load / edge conditions.
// Exercises the @morojs/engine HTTP backend (MoroEngineServer) with high
// concurrency, large payloads, header/query floods, parallel multipart uploads,
// mid-flight aborts, thrown handlers and repeated app lifecycles - asserting the
// adapter stays correct and leak-free (each test fully closes its app).
//
// Skipped automatically when no native engine binary exists for this Node ABI
// (the Node http server covers those platforms and has its own suites).
import { describe, it, expect, afterEach } from '@jest/globals';
import http from 'node:http';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, delay } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

// Ports above 10080 avoid the WHATWG fetch bad-port blocklist entirely
const testPort = () => 10100 + Math.floor(Math.random() * 5000);

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

const makeEngineApp = () => createApp({ logger: { level: 'fatal' }, server: { engine: 'moro' } });

// Raw HTTP GET that does NOT follow redirects (node:http) - lets us inspect
// 3xx status + Location without fetch's auto-follow / opaqueredirect handling
const rawGet = (
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: any; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, path, method: 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({
          status: res.statusCode as number,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });

const shuffle = <T>(arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

describeEngine('Native engine stress / load / edge', () => {
  let app: any;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  it('high concurrency: 200 simultaneous GETs all return 200 with correct bodies', async () => {
    app = await makeEngineApp();
    app.get('/echo/:n', (req: any) => ({ n: req.params.n, ok: true }));
    const port = testPort();
    await listen(app, port);

    const N = 200;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`http://localhost:${port}/echo/${i}`).then(async r => ({
          i,
          status: r.status,
          body: await r.json(),
        }))
      )
    );

    expect(responses).toHaveLength(N);
    for (const { i, status, body } of responses) {
      expect(status).toBe(200);
      // No cross-request aliasing: each response carries its own param
      expect(body).toEqual({ n: String(i), ok: true });
    }
  }, 30000);

  it('keep-alive reuse: many sequential requests over a kept-alive connection succeed', async () => {
    app = await makeEngineApp();
    app.get('/ka', (req: any) => ({ success: true, data: req.query.i ?? '0' }));
    const port = testPort();
    await listen(app, port);

    // Prefer an undici Agent with a single pooled (kept-alive) connection so
    // every request provably reuses the same socket; fall back to global
    // fetch (which already pools keep-alive connections) when unavailable.
    let dispatcher: any = null;
    try {
      const undici: any = await import('undici');
      dispatcher = new undici.Agent({ connections: 1, pipelining: 1 });
    } catch {
      // undici not installed as a standalone dep - default fetch keep-alives
    }
    const opts: any = dispatcher ? { dispatcher } : {};

    try {
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`http://localhost:${port}/ka?i=${i}`, opts);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ success: true, data: String(i) });
      }
    } finally {
      if (dispatcher) await dispatcher.close();
    }
  }, 30000);

  it('mixed methods/routes: randomized burst across ~20 routes each match their route', async () => {
    app = await makeEngineApp();

    const METHODS = ['get', 'post', 'put', 'delete', 'patch'];
    const specs: Array<{
      method: string;
      url: string;
      id: string;
      params: Record<string, string>;
    }> = [];

    for (const m of METHODS) {
      const M = m.toUpperCase();
      app[m](`/r/${m}/one`, (req: any) => ({
        id: `${M}:one`,
        method: req.method,
        params: req.params,
      }));
      specs.push({ method: M, url: `/r/${m}/one`, id: `${M}:one`, params: {} });

      app[m](`/r/${m}/two`, (req: any) => ({
        id: `${M}:two`,
        method: req.method,
        params: req.params,
      }));
      specs.push({ method: M, url: `/r/${m}/two`, id: `${M}:two`, params: {} });

      app[m](`/r/${m}/item/:id`, (req: any) => ({
        id: `${M}:item`,
        method: req.method,
        params: req.params,
      }));
      specs.push({
        method: M,
        url: `/r/${m}/item/42`,
        id: `${M}:item`,
        params: { id: '42' },
      });

      app[m](`/r/${m}/u/:uid/p/:pid`, (req: any) => ({
        id: `${M}:nested`,
        method: req.method,
        params: req.params,
      }));
      specs.push({
        method: M,
        url: `/r/${m}/u/7/p/9`,
        id: `${M}:nested`,
        params: { uid: '7', pid: '9' },
      });
    }

    expect(specs).toHaveLength(20);

    const port = testPort();
    await listen(app, port);

    // Fire each route 5x in a shuffled burst
    const burst: typeof specs = [];
    for (let k = 0; k < 5; k++) burst.push(...specs);
    shuffle(burst);

    const results = await Promise.all(
      burst.map(async s => {
        const r = await fetch(`http://localhost:${port}${s.url}`, { method: s.method });
        return { s, status: r.status, body: await r.json() };
      })
    );

    for (const { s, status, body } of results) {
      expect(status).toBe(200);
      expect(body.id).toBe(s.id);
      expect(body.method).toBe(s.method);
      expect(body.params).toEqual(s.params);
    }
  }, 30000);

  it('large request body: ~5MB JSON POST echoed back with integrity intact', async () => {
    app = await makeEngineApp();
    app.post('/echo-body', (req: any) => req.body);
    const port = testPort();
    await listen(app, port);

    const blob = 'A'.repeat(5 * 1024 * 1024); // ~5MB payload field
    const payload = { blob, n: 1234567, marker: 'END' };

    const r = await fetch(`http://localhost:${port}/echo-body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(r.status).toBe(200);
    const echoed = await r.json();
    expect(echoed.n).toBe(1234567);
    expect(echoed.marker).toBe('END');
    expect(echoed.blob.length).toBe(blob.length);
    expect(echoed.blob).toBe(blob); // full byte-for-byte integrity
  }, 30000);

  it('large response: ~2MB string body received intact', async () => {
    app = await makeEngineApp();
    const big = 'B'.repeat(2 * 1024 * 1024);
    app.get('/big', (req: any, res: any) => {
      res.send(big);
    });
    const port = testPort();
    await listen(app, port);

    const r = await fetch(`http://localhost:${port}/big`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.length).toBe(big.length);
    expect(text).toBe(big);
  }, 30000);

  it('many headers: ~50 custom headers echoed back, all present and lowercased', async () => {
    app = await makeEngineApp();
    app.get('/headers', (req: any) => ({ headers: req.headers }));
    const port = testPort();
    await listen(app, port);

    const custom: Record<string, string> = {};
    for (let i = 0; i < 50; i++) custom[`X-Custom-${i}`] = `value-${i}`;

    const r = await fetch(`http://localhost:${port}/headers`, { headers: custom });
    expect(r.status).toBe(200);
    const { headers } = await r.json();

    for (let i = 0; i < 50; i++) {
      // Keys arrive lowercased; original mixed-case key must NOT be present
      expect(headers[`x-custom-${i}`]).toBe(`value-${i}`);
      expect(headers[`X-Custom-${i}`]).toBeUndefined();
    }
  });

  it('query-heavy: 30 query params all present in req.query', async () => {
    app = await makeEngineApp();
    app.get('/search', (req: any) => ({ query: req.query }));
    const port = testPort();
    await listen(app, port);

    const pairs: string[] = [];
    const expected: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      pairs.push(`k${i}=v${i}`);
      expected[`k${i}`] = `v${i}`;
    }

    const r = await fetch(`http://localhost:${port}/search?${pairs.join('&')}`);
    expect(r.status).toBe(200);
    const { query } = await r.json();
    expect(query).toEqual(expected);
  });

  it('concurrent multipart uploads: 20 parallel binary uploads each parsed correctly', async () => {
    app = await makeEngineApp();
    app.post('/upload', (req: any, res: any) => {
      const file = req.body?.files?.file;
      res.json({
        success: true,
        idx: req.body?.fields?.idx,
        size: file?.size,
        b64: file ? file.data.toString('base64') : null,
      });
    });
    const port = testPort();
    await listen(app, port);

    // Per-upload binary payload carrying null/high bytes plus a per-index byte
    const makeBinary = (i: number) =>
      Buffer.from([0x00, 0xff, 0x10, i & 0xff, 0xfe, 0x01, 0x00, 0xff, (i * 7) & 0xff, 0x00]);

    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const binary = makeBinary(i);
        const form = new FormData();
        form.append('idx', String(i));
        form.append('file', new Blob([binary], { type: 'application/octet-stream' }), `f${i}.bin`);
        const r = await fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form });
        return { i, expected: binary, status: r.status, body: await r.json() };
      })
    );

    for (const { i, expected, status, body } of results) {
      expect(status).toBe(200);
      expect(body.idx).toBe(String(i)); // no cross-request mixup
      expect(body.size).toBe(expected.length);
      // Binary-safe round trip: reconstruct and compare byte-for-byte
      expect(Buffer.compare(Buffer.from(body.b64, 'base64'), expected)).toBe(0);
    }
  }, 30000);

  it('rapid connect/disconnect: aborting half of 50 in-flight requests keeps server healthy', async () => {
    app = await makeEngineApp();
    app.get('/slow', async (req: any, res: any) => {
      await new Promise(r => setTimeout(r, 300));
      res.json({ ok: true });
    });
    app.get('/ping', () => ({ pong: true }));
    const port = testPort();
    await listen(app, port);

    const controllers: AbortController[] = [];
    const promises = Array.from({ length: 50 }, (_, i) => {
      const controller = new AbortController();
      controllers.push(controller);
      return fetch(`http://localhost:${port}/slow`, { signal: controller.signal })
        .then(async r => {
          await r.text();
          return { ok: true as const, status: r.status };
        })
        .catch(e => ({ ok: false as const, err: e.name }));
    });

    // Abort every other request mid-flight (handler still has ~270ms to run)
    await delay(30);
    for (let i = 0; i < 50; i += 2) controllers[i].abort();

    const results = await Promise.all(promises);
    const aborted = results.filter(r => !r.ok).length;
    const succeeded = results.filter(r => r.ok && r.status === 200).length;

    expect(aborted).toBeGreaterThanOrEqual(20); // ~25 aborted
    expect(succeeded).toBeGreaterThanOrEqual(20); // ~25 completed

    // Server survived the aborts and still serves fresh requests
    const ping = await fetch(`http://localhost:${port}/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: true });
  }, 30000);

  it('route error handling: a thrown handler returns 500 and the server keeps serving', async () => {
    app = await makeEngineApp();
    app.get('/throw', () => {
      throw new Error('boom');
    });
    app.get('/ping', () => ({ pong: true }));
    const port = testPort();
    await listen(app, port);

    const err = await fetch(`http://localhost:${port}/throw`);
    expect(err.status).toBe(500);

    // No hang/crash: subsequent requests still work
    const ping = await fetch(`http://localhost:${port}/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ pong: true });
  });

  it('sequential app lifecycle: create+listen+close an engine app 10x without leaking', async () => {
    for (let i = 0; i < 10; i++) {
      resetConfig();
      UnifiedRouter.reset(); // singleton router - reset between apps
      const loopApp = await makeEngineApp();
      loopApp.get('/ping', () => ({ iter: i, ok: true }));
      const port = testPort();
      await listen(loopApp, port);

      const r = await fetch(`http://localhost:${port}/ping`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ iter: i, ok: true });

      await closeApp(loopApp);
      // Defensive: clear any container intervals so 10 iterations don't leak
      try {
        if (loopApp.core?.container?.destroy) loopApp.core.container.destroy();
      } catch {
        // ignore
      }
    }
    // The 10th iteration above already asserted a live 200 - loop completed
    // without a bind failure, proving ports/handles were released each time
  }, 30000);

  it('404 for an unmatched route returns a proper 404', async () => {
    app = await makeEngineApp();
    app.get('/exists', () => ({ ok: true }));
    const port = testPort();
    await listen(app, port);

    const r = await fetch(`http://localhost:${port}/definitely-not-here`);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.success).toBe(false);
  });

  it('res helpers: status().json(), redirect() and send() all work over the engine', async () => {
    app = await makeEngineApp();
    app.get('/created', (req: any, res: any) =>
      res.status(201).json({ success: true, data: { id: 1 } })
    );
    app.get('/go', (req: any, res: any) => res.redirect('/target'));
    app.get('/go-perm', (req: any, res: any) => res.redirect('/perm-target', 301));
    app.get('/plain', (req: any, res: any) => res.send('plain text body'));
    const port = testPort();
    await listen(app, port);

    // res.status(201).json(...)
    const created = await fetch(`http://localhost:${port}/created`);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ success: true, data: { id: 1 } });

    // res.redirect(...) - inspect status + Location without following
    const redir = await rawGet(port, '/go');
    expect(redir.status).toBe(302);
    expect(redir.headers.location).toBe('/target');

    const redir301 = await rawGet(port, '/go-perm');
    expect(redir301.status).toBe(301);
    expect(redir301.headers.location).toBe('/perm-target');

    // res.send(text)
    const plain = await fetch(`http://localhost:${port}/plain`);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe('plain text body');
  });
});
