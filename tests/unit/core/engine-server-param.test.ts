// @ts-nocheck
// Unit Tests - MoroEngineServer engine-answered parameter routes.
//
// setParamRoute() hands (method, prefix, suffix) to the engine, which then
// answers a matching request with the segment as the body, without JS.
// Against the fake engine: the registration reaches the engine, a matching
// request records one 'param' op and never reaches the router, non-matching
// shapes do, the call is refused without the capability / export / for an
// unindexed method / with compression on, and routes are re-registered on
// the fresh native server that listen() creates after close(). Like static
// routes, the engine holds them only while no global middleware and no
// request / response hook is registered.
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';
import { HookManager } from '../../../src/core/utilities/hooks.js';

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

  it('takes its parameter routes back from the engine while global middleware or a hook is registered', async () => {
    const engine = createFakeEngine({ capabilities: PARAM_CAPS });
    const server = createServer(engine);
    const hooks = new HookManager();
    server.setHookManager(hooks);
    const seen: string[] = [];
    server.setRouterHandler((req, res) => {
      seen.push(`route ${req.path}`);
      res.end('js');
      return true;
    });
    server.setParamRoute('GET', '/user/', '', 200, null);
    server.listen(0);
    const direct = engine.simulate({ method: 'GET', path: '/user/1' });
    expect(engine.requests.get(direct).ops[0].type).toBe('param');

    // A hook comes and goes: the routes follow it.
    const hook = () => {
      seen.push('hook');
    };
    hooks.before('request', hook);
    expect(engine.paramRoutes.get(server.serverId)).toBeUndefined();
    engine.simulate({ method: 'GET', path: '/user/2' });
    await tick();
    await tick();
    expect(seen).toEqual(['hook', 'route /user/2']);
    hooks.removeHook('request', hook);
    expect(engine.paramRoutes.get(server.serverId)).toHaveLength(1);

    // Middleware registered on the running server stays in front for good.
    seen.length = 0;
    server.use((req, _res, next) => {
      seen.push(`middleware ${req.path}`);
      next();
    });
    expect(engine.paramRoutes.get(server.serverId)).toBeUndefined();
    const guarded = engine.simulate({ method: 'GET', path: '/user/3' });
    await tick();
    expect(seen).toEqual(['middleware /user/3', 'route /user/3']);
    expect(engine.requests.get(guarded).ops.some(op => op.type === 'param')).toBe(false);

    // A route registered now is accepted, and stays in JS as well.
    const before = engine.paramCalls.length;
    expect(server.setParamRoute('GET', '/item/', '', 200, null)).toBe(true);
    expect(engine.paramCalls).toHaveLength(before);
  });

  it('is refused by an engine that could not be asked to give the routes back', () => {
    const noClear = createFakeEngine({
      capabilities: PARAM_CAPS,
      omitFunctions: ['clearParamRoutes'],
    });
    const server = createServer(noClear);
    expect(server.paramRoutesEnabled).toBe(false);
    expect(server.setParamRoute('GET', '/user/', '')).toBe(false);
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
