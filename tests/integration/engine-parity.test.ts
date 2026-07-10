/* eslint-disable */
// @ts-nocheck
// Integration Tests - behavioral parity between the native @morojs/engine HTTP
// backend and the Node http backend. The SAME representative requests (JSON GET,
// POST echo, 404, route params, query, custom headers) run against
// createApp({ server: { engine: 'moro' } }) and createApp({ server: { engine:
// 'node' } }); their status, body and key headers must match - proving the
// engine adapter is a drop-in for the Node path.
//
// The two engines run in SEPARATE phases (never simultaneously): UnifiedRouter
// is a process-wide singleton, so we reset it between phases and keep only one
// app alive at a time. Skipped entirely when the native engine can't load (a
// parity test without the engine leg is meaningless).
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const testPort = () => 10100 + Math.floor(Math.random() * 5000);

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// Register the identical route surface on either engine
function registerRoutes(app: any): void {
  app.get('/json', () => ({ hello: 'world', n: 1, list: [1, 2, 3] }));
  app.post('/echo', (req: any) => ({ received: req.body }));
  app.get('/users/:id', (req: any) => ({ id: req.params.id }));
  app.get('/search', (req: any) => ({ query: req.query }));
  app.get('/hdr', (req: any) => ({ h: req.headers['x-test-header'] ?? null }));
}

// Normalize a response for cross-engine comparison. Content-type is reduced to
// its media type (the Node path appends "; charset=utf-8" to JSON, the engine
// does not - a cosmetic difference, not a behavioral one).
async function grab(p: Promise<Response>) {
  const r = await p;
  const ct = r.headers.get('content-type');
  return {
    status: r.status,
    contentType: ct ? ct.split(';')[0].trim() : null,
    body: await r.json().catch(() => null),
  };
}

async function collect(port: number) {
  const base = `http://localhost:${port}`;
  return {
    jsonGet: await grab(fetch(`${base}/json`)),
    postEcho: await grab(
      fetch(`${base}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1, b: 'two', nested: { x: true, arr: [9, 8] } }),
      })
    ),
    notFound: await grab(fetch(`${base}/nope`)),
    params: await grab(fetch(`${base}/users/abc123`)),
    query: await grab(fetch(`${base}/search?a=1&b=2&c=hello&d=`)),
    headers: await grab(fetch(`${base}/hdr`, { headers: { 'x-test-header': 'parity-value' } })),
  };
}

describeEngine('Engine <-> Node behavioral parity', () => {
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
    UnifiedRouter.reset(); // singleton router - isolate the two phases
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    registerRoutes(app);
    const port = testPort();
    await listen(app, port);
    const results = await collect(port);
    await closeApp(app);
    app = null;
    return results;
  }

  it('produces matching status, body and key headers on both engines', async () => {
    const nodeResults = await runPhase('node');
    const moroResults = await runPhase('moro');

    // Sanity: the Node baseline behaved as expected before comparing
    expect(nodeResults.jsonGet.status).toBe(200);
    expect(nodeResults.jsonGet.body).toEqual({ hello: 'world', n: 1, list: [1, 2, 3] });
    expect(nodeResults.notFound.status).toBe(404);
    expect(nodeResults.params.body).toEqual({ id: 'abc123' });

    // Full cross-engine parity across every representative request
    for (const key of Object.keys(nodeResults) as Array<keyof typeof nodeResults>) {
      expect(moroResults[key].status).toBe(nodeResults[key].status);
      expect(moroResults[key].body).toEqual(nodeResults[key].body);
      expect(moroResults[key].contentType).toBe(nodeResults[key].contentType);
    }
  }, 30000);
});
