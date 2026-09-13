 
// @ts-nocheck
// Unit Tests - MoroEngineServer batched pipelined dispatch (fake engine):
// onRequestBatch is registered only when the engine advertises
// batchDispatch and has getBatchBuffers/getPath; slots are dispatched in
// order following the control cell; the loop stops at the first async
// handler (returning the consumed count) and that request stays in flight;
// an uncacheable path is fetched through getPath(); a throwing handler
// answers 500 and the batch continues; the buffers are the engine's own
// objects fetched once.
import { describe, it, expect } from '@jest/globals';
import { MoroEngineServer } from '../../../src/core/http/moro-engine-server.js';
import { getEngineCapabilities } from '../../../src/core/utilities/package-utils.js';
import { createFakeEngine } from '../../utils/fake-engine.js';

const BATCH_CAPS = { limits: true, batchDispatch: true };
const tick = () => new Promise(r => setImmediate(r));

function createServer(engine: any) {
  const capabilities = getEngineCapabilities(engine);
  return new MoroEngineServer({ engineModule: engine, capabilities });
}

describe('MoroEngineServer batched dispatch (fake engine)', () => {
  it('registers onRequestBatch only with the capability and the functions', () => {
    const on = createFakeEngine({ capabilities: BATCH_CAPS });
    createServer(on);
    expect(typeof on.callbacks.onRequestBatch).toBe('function');

    const off = createFakeEngine({ capabilities: { limits: true } });
    createServer(off);
    expect(off.callbacks.onRequestBatch).toBeUndefined();

    const noFn = createFakeEngine({ capabilities: BATCH_CAPS, omitFunctions: ['getBatchBuffers'] });
    createServer(noFn);
    expect(noFn.callbacks.onRequestBatch).toBeUndefined();
  });

  it('dispatches every slot in order when the handlers are synchronous', async () => {
    const engine = createFakeEngine({ capabilities: BATCH_CAPS });
    const server = createServer(engine);
    const seen: string[] = [];
    server.setRouterHandler((req, res) => {
      seen.push(req.path);
      res.send('ok ' + req.path);
      return true;
    });
    const { reqIds, consumed } = engine.simulateBatch([
      { path: '/a' },
      { path: '/b' },
      { path: '/c', uncacheable: true },
    ]);
    expect(consumed).toBe(3);
    expect(seen).toEqual(['/a', '/b', '/c']);
    for (const id of reqIds) {
      const ops = engine.requests.get(id).ops;
      expect(ops[ops.length - 1].type === 'respond' || ops[ops.length - 1].type === 'end').toBe(
        true
      );
    }
    expect(engine.batch.control[0]).toBe(3);
  });

  it('stops at the first async handler and leaves it in flight', async () => {
    const engine = createFakeEngine({ capabilities: BATCH_CAPS });
    const server = createServer(engine);
    const seen: string[] = [];
    let release: () => void = () => {};
    server.setRouterHandler((req, res) => {
      seen.push(req.path);
      if (req.path === '/slow') {
        return new Promise<boolean>(resolve => {
          release = () => {
            res.send('late');
            resolve(true);
          };
        });
      }
      res.send('fast');
      return true;
    });
    const { reqIds, consumed } = engine.simulateBatch([
      { path: '/x' },
      { path: '/slow' },
      { path: '/y' },
    ]);
    expect(consumed).toBe(2);
    expect(seen).toEqual(['/x', '/slow']);
    expect(engine.requests.get(reqIds[2]).ops).toEqual([]); // never dispatched
    expect(engine.requests.get(reqIds[1]).terminal).toBe(false);
    release();
    await tick();
    expect(engine.requests.get(reqIds[1]).terminal).toBe(true);
  });

  it('a synchronous throw answers 500 and the batch continues', async () => {
    const engine = createFakeEngine({ capabilities: BATCH_CAPS });
    const server = createServer(engine);
    server.setRouterHandler((req, res) => {
      if (req.path === '/boom') throw new Error('boom');
      res.send('ok');
      return true;
    });
    // The adapter's async error boundary normally catches route errors; force
    // a synchronous escape by breaking the request constructor path instead.
    (server as any).requestDecorationKeys = ['x'];
    (server as any).requestDecorations = {
      get x() {
        throw new Error('decoration boom');
      },
    };
    const { reqIds, consumed } = engine.simulateBatch([{ path: '/1' }, { path: '/2' }]);
    expect(consumed).toBe(2);
    for (const id of reqIds) {
      const last = engine.requests.get(id).ops.at(-1);
      expect(last.type).toBe('respond');
      expect(last.status).toBe(500);
    }
  });

  it('uses the same buffers the engine handed out', () => {
    const engine = createFakeEngine({ capabilities: BATCH_CAPS });
    const server = createServer(engine);
    expect((server as any)._batchDesc).toBe(engine.batch.descriptors);
    expect((server as any)._batchCtl).toBe(engine.batch.control);
    expect((server as any)._batchPaths).toBe(engine.batch.paths);
  });
});
