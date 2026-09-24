// @ts-nocheck
// Unit Tests - MoroEngineServer engine-answered static routes.
//
// setStaticRoute() hands a fixed (method, path) reply to the engine, which
// then answers matching requests without calling into JS. Against the fake
// engine: the registration reaches the engine with the engine's method index
// and flattened headers, a matching request records one 'static' op and never
// reaches the router handler, other methods on the same path still do, the
// call is refused (false) without the capability / export / for an unindexed
// method, and every route is re-registered on the fresh native server that
// listen() creates after close().
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const STATIC_CAPS = {
  limits: true,
  tls: true,
  http2: false,
  wsDeflate: true,
  responseLimits: true,
  tlsPolicy: true,
  staticRoutes: true,
  responseTemplates: true,
  asyncNotify: true,
  workerThreads: true,
  fastCalls: true,
};

function createServer(engine: any, options: any = {}) {
  const capabilities = getEngineCapabilities(engine);
  return new MoroEngineServer({ engineModule: engine, capabilities, ...options });
}

describe('MoroEngineServer static routes', () => {
  it('registers with the engine and a matching request never reaches JS', async () => {
    const engine = createFakeEngine({ capabilities: STATIC_CAPS });
    const server = createServer(engine);
    let jsCalls = 0;
    server.setRouterHandler((_req, res) => {
      jsCalls++;
      res.end('from js');
      return true;
    });

    expect(server.staticRoutesEnabled).toBe(true);
    expect(server.setStaticRoute('GET', '/', 200, null, '')).toBe(true);
    expect(engine.staticCalls).toEqual([
      { serverId: server.serverId, method: 0, path: '/', status: 200, headersFlat: null, body: '' },
    ]);

    const hit = engine.simulate({ method: 'GET', path: '/' });
    await tick();
    expect(jsCalls).toBe(0);
    expect(engine.requests.get(hit).ops).toEqual([
      { type: 'static', status: 200, headersFlat: null, body: '' },
    ]);

    // Only an exact method match short-circuits; POST on the same path is JS.
    const miss = engine.simulate({ method: 'POST', path: '/' });
    await tick();
    expect(jsCalls).toBe(1);
    expect(engine.requests.get(miss).ops[0].type).not.toBe('static');
  });

  it('flattens header objects and replaces a re-registered (method, path)', () => {
    const engine = createFakeEngine({ capabilities: STATIC_CAPS });
    const server = createServer(engine);

    expect(
      server.setStaticRoute('POST', '/user', 201, { 'content-type': 'text/plain', 'x-n': 1 }, 'a')
    ).toBe(true);
    expect(server.setStaticRoute('post', '/user', 200, null, 'b')).toBe(true);
    expect(server.setStaticRoute('GET', '/list', 200, ['x-a', '1', 'x-a', '2'], null)).toBe(true);

    expect(
      engine.staticCalls.map(c => [c.method, c.path, c.status, c.headersFlat, c.body])
    ).toEqual([
      [1, '/user', 201, ['content-type', 'text/plain', 'x-n', '1'], 'a'],
      [1, '/user', 200, null, 'b'],
      [0, '/list', 200, ['x-a', '1', 'x-a', '2'], null],
    ]);
    // The engine keeps one entry per (method, path): the replacement won.
    expect(engine.staticRoutes.get(server.serverId).map(r => [r.path, r.body])).toEqual([
      ['/user', 'b'],
      ['/list', null],
    ]);
  });

  it('is refused without the capability, without the export, and for unindexed methods', () => {
    const noCaps = createServer(createFakeEngine());
    expect(noCaps.staticRoutesEnabled).toBe(false);
    expect(noCaps.setStaticRoute('GET', '/')).toBe(false);

    const noExport = createFakeEngine({
      capabilities: STATIC_CAPS,
      omitFunctions: ['setStaticRoute'],
    });
    expect(createServer(noExport).setStaticRoute('GET', '/')).toBe(false);

    const full = createFakeEngine({ capabilities: STATIC_CAPS });
    expect(createServer(full).setStaticRoute('PROPFIND', '/')).toBe(false);
    expect(full.staticCalls).toEqual([]);
  });

  it('re-registers every static route on the fresh server after close() + listen()', async () => {
    const engine = createFakeEngine({ capabilities: STATIC_CAPS });
    const server = createServer(engine);
    server.setRouterHandler((_req, res) => {
      res.end('js');
      return true;
    });
    server.setStaticRoute('GET', '/', 200, null, '');
    server.setStaticRoute('POST', '/user', 200, null, '');
    server.listen(0);
    const first = server.serverId;

    await new Promise<void>(resolve => server.close(() => resolve()));
    server.listen(0);
    expect(server.serverId).not.toBe(first);

    expect(engine.staticCalls.map(c => [c.serverId, c.method, c.path])).toEqual([
      [first, 0, '/'],
      [first, 1, '/user'],
      [server.serverId, 0, '/'],
      [server.serverId, 1, '/user'],
    ]);

    const hit = engine.simulate({ method: 'POST', path: '/user' });
    await tick();
    expect(engine.requests.get(hit).ops).toEqual([
      { type: 'static', status: 200, headersFlat: null, body: '' },
    ]);
  });

  it('is refused while compression is on (the engine cannot negotiate an encoding)', () => {
    const engine = createFakeEngine({ capabilities: STATIC_CAPS });
    const server = createServer(engine);
    server._compression.enabled = true;
    expect(server.setStaticRoute('GET', '/', 200, null, '')).toBe(false);
    expect(engine.staticCalls).toEqual([]);
  });

  it("a literal handler's static reply carries exactly the headers send() would emit", async () => {
    // compileStaticRoute spells out send()'s implied content-type; prove the
    // two agree by sending each body through the adapter on a plain engine
    // (no templates, so the respond op carries the header pair verbatim).
    const { compileStaticRoute } = await import('../../../src/core/routing/unified-router.js');
    for (const body of ['', 'hello', '{"a":1}', ' [1]', Buffer.from([1, 2, 3]), Buffer.alloc(0)]) {
      const engine = createFakeEngine();
      const server = createServer(engine);
      server.setRouterHandler((_req, res) => {
        // The literal handler itself: end() for an empty body, send() otherwise.
        if (body.length === 0) res.end();
        else res.send(body);
        return true;
      });
      const reqId = engine.simulate({ path: '/' });
      await tick();
      const sent = engine.requests.get(reqId).ops.find(op => op.type === 'respond');
      const fixed = compileStaticRoute({ method: 'GET', path: '/' }, body).static;
      expect(fixed.headers).toEqual(sent.headersFlat);
      expect(fixed.status).toBe(sent.status);
      expect(fixed.body).toBe(body);
    }
  });

  it('clearStaticRoutes() forgets them on the adapter and the engine', () => {
    const engine = createFakeEngine({ capabilities: STATIC_CAPS });
    const server = createServer(engine);
    server.setStaticRoute('GET', '/', 200, null, '');
    server.clearStaticRoutes();
    expect(engine.staticRoutes.get(server.serverId)).toBeUndefined();

    const reqId = engine.simulate({ method: 'GET', path: '/' });
    expect(engine.requests.get(reqId).ops.some(op => op.type === 'static')).toBe(false);
  });
});
