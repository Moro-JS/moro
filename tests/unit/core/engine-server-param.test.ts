// @ts-nocheck
// Unit Tests - MoroEngineServer engine-answered parameter routes.
//
// setParamRoute() hands (method, prefix, suffix) to the engine, which then
// answers a matching request with the segment as the body, without JS.
// Against the fake engine: the registration reaches the engine, a matching
// request records one 'param' op and never reaches the router, non-matching
// shapes do, the call is refused without the capability / export / for an
// unindexed method / with compression on, and routes are re-registered on
// the fresh native server that listen() creates after close().
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

const PARAM_CAPS = {
  limits: true,
  tls: true,
  http2: false,
  wsDeflate: true,
  responseLimits: true,
  tlsPolicy: true,
  staticRoutes: true,
  paramRoutes: true,
  responseTemplates: true,
  asyncNotify: true,
  workerThreads: true,
  fastCalls: true,
};

function createServer(engine: any, options: any = {}) {
  const capabilities = getEngineCapabilities(engine);
  return new MoroEngineServer({ engineModule: engine, capabilities, ...options });
}

describe('MoroEngineServer parameter routes', () => {
  it('registers with the engine and a matching request never reaches JS', async () => {
    const engine = createFakeEngine({ capabilities: PARAM_CAPS });
    const server = createServer(engine);
    let jsCalls = 0;
    server.setRouterHandler((_req, res) => {
      jsCalls++;
      res.end('from js');
      return true;
    });

    expect(server.paramRoutesEnabled).toBe(true);
    expect(server.setParamRoute('GET', '/user/', '', 200, null)).toBe(true);
    expect(engine.paramCalls).toEqual([
      {
        serverId: server.serverId,
        method: 0,
        prefix: '/user/',
        suffix: '',
        status: 200,
        headersFlat: null,
      },
    ]);

    const hit = engine.simulate({ method: 'GET', path: '/user/42' });
    await tick();
    expect(jsCalls).toBe(0);
    expect(engine.requests.get(hit).ops).toEqual([
      { type: 'param', status: 200, headersFlat: null, body: '42' },
    ]);

    // Non-matching shapes reach JS: empty segment, a second slash, another method.
    for (const sim of [
      { method: 'GET', path: '/user/' },
      { method: 'GET', path: '/user/1/2' },
      { method: 'POST', path: '/user/42' },
    ]) {
      const miss = engine.simulate(sim);
      await tick();
      expect(engine.requests.get(miss).ops[0].type).not.toBe('param');
    }
    expect(jsCalls).toBe(3);
  });

  it('honours a suffix and replaces a re-registered (method, prefix, suffix)', async () => {
    const engine = createFakeEngine({ capabilities: PARAM_CAPS });
    const server = createServer(engine);
    server.setRouterHandler(() => false);
    expect(
      server.setParamRoute('GET', '/files/', '.json', 200, { 'content-type': 'application/json' })
    ).toBe(true);
    expect(server.setParamRoute('get', '/files/', '.json', 203, null)).toBe(true);
    expect(engine.paramRoutes.get(server.serverId)).toEqual([
      { method: 0, prefix: '/files/', suffix: '.json', status: 203, headersFlat: null },
    ]);
    const hit = engine.simulate({ method: 'GET', path: '/files/report.json' });
    await tick();
    expect(engine.requests.get(hit).ops).toEqual([
      { type: 'param', status: 203, headersFlat: null, body: 'report' },
    ]);
  });

  it('is refused without the capability, the export, for unindexed methods, and under compression', () => {
    expect(createServer(createFakeEngine()).setParamRoute('GET', '/user/', '')).toBe(false);
    const noExport = createFakeEngine({
      capabilities: PARAM_CAPS,
      omitFunctions: ['setParamRoute'],
    });
    expect(createServer(noExport).setParamRoute('GET', '/user/', '')).toBe(false);
    const full = createFakeEngine({ capabilities: PARAM_CAPS });
    const server = createServer(full);
    expect(server.setParamRoute('PROPFIND', '/user/', '')).toBe(false);
    server._compression.enabled = true;
    expect(server.setParamRoute('GET', '/user/', '')).toBe(false);
    expect(full.paramCalls).toEqual([]);
  });

  it('re-registers parameter routes on the fresh server after close() + listen()', async () => {
    const engine = createFakeEngine({ capabilities: PARAM_CAPS });
    const server = createServer(engine);
    server.setRouterHandler(() => false);
    server.setParamRoute('GET', '/user/', '', 200, null);
    server.listen(0);
    const first = server.serverId;
    await new Promise<void>(resolve => server.close(() => resolve()));
    server.listen(0);
    expect(server.serverId).not.toBe(first);
    expect(engine.paramCalls.map(c => c.serverId)).toEqual([first, server.serverId]);
    const hit = engine.simulate({ method: 'GET', path: '/user/9' });
    await tick();
    expect(engine.requests.get(hit).ops).toEqual([
      { type: 'param', status: 200, headersFlat: null, body: '9' },
    ]);
  });

  it('clearParamRoutes() hands the routes back to JS', async () => {
    const engine = createFakeEngine({ capabilities: PARAM_CAPS });
    const server = createServer(engine);
    let jsCalls = 0;
    server.setRouterHandler((_req, res) => {
      jsCalls++;
      res.end('js');
      return true;
    });
    server.setParamRoute('GET', '/user/', '', 200, null);
    server.clearParamRoutes();
    expect(engine.paramRoutes.get(server.serverId)).toBeUndefined();
    engine.simulate({ method: 'GET', path: '/user/1' });
    await tick();
    expect(jsCalls).toBe(1);
  });
});
