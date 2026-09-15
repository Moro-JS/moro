// @ts-nocheck
// Unit Tests - MoroEngineServer microtask drain.
//
// The engine calls onRequest with a plain V8 call, outside a Node callback
// scope, so a response completed through a bare microtask after the sync
// dispatch window is not flushed until the next Node-managed callback. The
// adapter arms one no-op setImmediate whenever a response is still in flight
// after dispatch; Node drains the microtask queue when that immediate's scope
// closes. Jest's own callback scope hides the stall itself, so this proves
// the arming: set while a response is pending, cleared once the immediate
// has run, never set for a response that completed synchronously, and
// coalesced across a burst.
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { createFakeEngine } from '../../utils/fake-engine.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function createServer(engine: any) {
  return new MoroEngineServer({
    engineModule: engine,
    capabilities: getEngineCapabilities(engine),
  });
}

describe('MoroEngineServer microtask drain', () => {
  it('arms one immediate while a response completes asynchronously, then clears it', async () => {
    const engine = createFakeEngine();
    const server = createServer(engine);
    const finishers: Array<() => void> = [];
    server.setRouterHandler((_req, res) => {
      new Promise<void>(resolve => finishers.push(resolve)).then(() => res.end('later'));
      return true;
    });

    const first = engine.simulate({ path: '/' });
    expect(server._drainArmed).toBe(true);
    const second = engine.simulate({ path: '/' }); // same burst: still one immediate
    expect(server._drainArmed).toBe(true);

    await tick();
    expect(server._drainArmed).toBe(false);

    for (const finish of finishers) finish();
    await tick();
    expect(engine.requests.get(first).ops.at(-1)).toMatchObject({ body: 'later' });
    expect(engine.requests.get(second).ops.at(-1)).toMatchObject({ body: 'later' });
  });

  it('does not arm for a response that ended inside the dispatch window', () => {
    const engine = createFakeEngine();
    const server = createServer(engine);
    server.setRouterHandler((_req, res) => {
      res.end('now');
      return true;
    });
    engine.simulate({ path: '/' });
    expect(server._drainArmed).toBe(false);
  });

  it('does not arm when the engine advertises callbackScope (it drains on return itself)', () => {
    const engine = createFakeEngine({ capabilities: { callbackScope: true } });
    const server = createServer(engine);
    server.setRouterHandler(() => false);
    engine.simulate({ path: '/nope' });
    expect(server._drainArmed).toBe(false);
  });

  it('arms for a router miss (the 404 is sent after an await)', () => {
    const engine = createFakeEngine();
    const server = createServer(engine);
    server.setRouterHandler(() => false);
    engine.simulate({ path: '/nope' });
    expect(server._drainArmed).toBe(true);
  });
});
