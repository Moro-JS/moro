// @ts-nocheck
// Unit Tests - MoroEngineServer batched pipelined dispatch (fake engine):
// onRequestBatch is registered only when the engine advertises
// batchDispatch and has getBatchBuffers/getPath; slots are dispatched in
// order following the control cell; the loop stops at the first async
// handler (returning the consumed count) and that request stays in flight;
// an uncacheable path is fetched through getPath(); a throwing handler
// answers 500 and the batch continues; the buffers are the engine's own
// objects fetched once.
//
// Batched dispatch also decides who upgrades a WebSocket handshake. The
// engine does it itself (setWsAutoUpgrade) only when batched dispatch is off
// or the engine advertises wsAutoUpgradeBatch; otherwise the handshake is
// upgraded from onRequest, as on engines that have no engine-side upgrade.
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

  describe('who upgrades a WebSocket handshake', () => {
    const WS_CAPS = { limits: true, wsAutoUpgrade: true };

    // The fake engine with the WebSocket natives the adapter looks for:
    // setWsAutoUpgrade and the handshake readers of an engine-side upgrade,
    // and upgradeToWebSocket, which fires onWsOpen as the engine does.
    function wsEngine(capabilities: Record<string, boolean>) {
      const engine = createFakeEngine({ capabilities });
      engine.autoUpgrade = [] as Array<{ serverId: number; on: boolean }>;
      engine.upgraded = [] as number[];
      engine.setWsAutoUpgrade = (serverId: number, on: boolean) =>
        engine.autoUpgrade.push({ serverId, on });
      engine.wsGetHeaders = () => undefined;
      engine.wsGetQuery = () => '';
      engine.wsGetRemoteAddress = () => '';
      engine.upgradeToWebSocket = (reqId: number) => {
        engine.upgraded.push(reqId);
        const wsId = 900 + reqId;
        engine.callbacks.onWsOpen(wsId, engine.requests.get(reqId).path);
        engine.requests.get(reqId).terminal = true;
        return wsId;
      };
      return engine;
    }

    function serveWebSockets(engine: any) {
      const server = createServer(engine);
      const opened: Array<{ wsId: number; path: string; info: any }> = [];
      const routed: string[] = [];
      server.setRouterHandler((req, res) => {
        routed.push(req.path);
        res.send('http');
        return true;
      });
      server.enableWebSocket({
        onOpen: (wsId: number, path: string, info?: any) => opened.push({ wsId, path, info }),
        onMessage: () => {},
        onClose: () => {},
      });
      return { server, opened, routed };
    }

    const handshake = {
      path: '/socket',
      query: 'room=7',
      remoteAddress: '10.0.0.9',
      headers: { upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    };

    it('upgrades in onRequest when batched dispatch is on and the engine does not vouch for the pair', () => {
      const engine = wsEngine({ ...WS_CAPS, batchDispatch: true });
      const { opened, routed } = serveWebSockets(engine);

      expect(typeof engine.callbacks.onRequestBatch).toBe('function');
      expect(engine.autoUpgrade).toEqual([]);

      const reqId = engine.simulate(handshake);
      expect(engine.upgraded).toEqual([reqId]);
      expect(routed).toEqual([]);
      // The handshake was read before the upgrade invalidated the request
      expect(opened).toEqual([
        {
          wsId: 900 + reqId,
          path: '/socket',
          info: {
            ip: '10.0.0.9',
            flat: ['upgrade', 'websocket', 'sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ=='],
            query: 'room=7',
          },
        },
      ]);

      // An ordinary request is still an ordinary request
      engine.simulate({ path: '/plain' });
      expect(routed).toEqual(['/plain']);
    });

    it('lets the engine upgrade when it advertises wsAutoUpgradeBatch', () => {
      const engine = wsEngine({ ...WS_CAPS, batchDispatch: true, wsAutoUpgradeBatch: true });
      const { server, routed } = serveWebSockets(engine);

      expect(typeof engine.callbacks.onRequestBatch).toBe('function');
      expect(engine.autoUpgrade).toEqual([{ serverId: (server as any).serverId, on: true }]);

      // A handshake that still reaches onRequest was refused by the engine:
      // it is not probed again, and is answered as a plain request.
      engine.simulate(handshake);
      expect(engine.upgraded).toEqual([]);
      expect(routed).toEqual(['/socket']);
    });

    it('lets the engine upgrade when batched dispatch is off', () => {
      const engine = wsEngine(WS_CAPS);
      const { server } = serveWebSockets(engine);

      expect(engine.callbacks.onRequestBatch).toBeUndefined();
      expect(engine.autoUpgrade).toEqual([{ serverId: (server as any).serverId, on: true }]);
    });

    it('upgrades in onRequest on an engine without engine-side upgrades', () => {
      const engine = wsEngine({ limits: true, batchDispatch: true });
      serveWebSockets(engine);

      expect(engine.autoUpgrade).toEqual([]);
      const reqId = engine.simulate(handshake);
      expect(engine.upgraded).toEqual([reqId]);
    });

    // A bridge with verifyUpgrade decides each handshake before it is
    // answered, so the upgrade has to stay where it can still be refused.
    function serveChecked(engine: any, verifyUpgrade: (request: any) => any) {
      const server = createServer(engine);
      const opened: Array<{ wsId: number; path: string; info: any }> = [];
      const routed: string[] = [];
      const asked: any[] = [];
      server.setRouterHandler((req, res) => {
        routed.push(req.path);
        res.send('http');
        return true;
      });
      server.enableWebSocket({
        onOpen: (wsId: number, path: string, info?: any) => opened.push({ wsId, path, info }),
        onMessage: () => {},
        onClose: () => {},
        verifyUpgrade: (request: any) => {
          asked.push(request);
          return verifyUpgrade(request);
        },
      });
      return { server, opened, routed, asked };
    }
    const lastOp = (engine: any, reqId: number) => engine.requests.get(reqId).ops.at(-1);

    it('keeps the upgrade in onRequest for a bridge that checks handshakes, though the engine could upgrade', () => {
      const engine = wsEngine(WS_CAPS);
      const { opened, asked } = serveChecked(engine, () => undefined);

      // Engine-side upgrades stay off: a handshake the engine answered could
      // no longer be refused.
      expect(engine.autoUpgrade).toEqual([]);

      const reqId = engine.simulate(handshake);
      expect(asked).toEqual([
        {
          ip: '10.0.0.9',
          flat: ['upgrade', 'websocket', 'sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ=='],
          query: 'room=7',
          path: '/socket',
          method: 'GET',
          secure: false,
        },
      ]);
      expect(engine.upgraded).toEqual([reqId]);
      expect(opened.map(o => o.info)).toEqual([
        {
          ip: '10.0.0.9',
          flat: ['upgrade', 'websocket', 'sec-websocket-key', 'dGhlIHNhbXBsZSBub25jZQ=='],
          query: 'room=7',
        },
      ]);
    });

    it('answers a refused handshake with its HTTP status and never upgrades it', () => {
      const engine = wsEngine(WS_CAPS);
      const { opened, routed } = serveChecked(engine, () => 403);

      const reqId = engine.simulate(handshake);
      expect(engine.upgraded).toEqual([]);
      expect(opened).toEqual([]);
      expect(routed).toEqual([]);
      expect(lastOp(engine, reqId)).toMatchObject({ type: 'respond', status: 403 });
      expect(JSON.parse(lastOp(engine, reqId).body)).toEqual({
        success: false,
        error: 'Forbidden',
      });

      // A request that is not an upgrade is not asked about
      engine.simulate({ path: '/plain' });
      expect(routed).toEqual(['/plain']);
    });

    it('answers a refused handshake that arrives pipelined between two requests, in order', () => {
      const engine = wsEngine({ ...WS_CAPS, batchDispatch: true });
      const { routed } = serveChecked(engine, () => 403);

      const { reqIds, consumed } = engine.simulateBatch([
        { path: '/before' },
        handshake,
        { path: '/after' },
      ]);
      expect(consumed).toBe(3);
      expect(engine.upgraded).toEqual([]);
      expect(routed).toEqual(['/before', '/after']);
      expect(reqIds.map((id: number) => lastOp(engine, id).status)).toEqual([200, 403, 200]);
    });

    it('waits for an asynchronous verdict before upgrading or refusing', async () => {
      const engine = wsEngine(WS_CAPS);
      const verdicts: Array<(status?: number) => void> = [];
      const { opened } = serveChecked(
        engine,
        () => new Promise<number | undefined>(resolve => verdicts.push(resolve))
      );

      const allowed = engine.simulate(handshake);
      const refused = engine.simulate(handshake);
      expect(engine.upgraded).toEqual([]);
      expect(engine.requests.get(allowed).ops).toEqual([]);

      verdicts[0]();
      verdicts[1](401);
      await tick();
      expect(engine.upgraded).toEqual([allowed]);
      expect(opened.map(o => o.wsId)).toEqual([900 + allowed]);
      expect(opened[0].info).toMatchObject({ ip: '10.0.0.9', query: 'room=7' });
      expect(lastOp(engine, refused)).toMatchObject({ type: 'respond', status: 401 });
    });

    it('drops a handshake whose client went away before the verdict', async () => {
      const engine = wsEngine(WS_CAPS);
      let verdict: (status?: number) => void = () => {};
      const { opened } = serveChecked(
        engine,
        () => new Promise<number | undefined>(resolve => (verdict = resolve))
      );

      const reqId = engine.simulate(handshake);
      engine.abort(reqId);
      verdict();
      await tick();
      // The request id is no longer this request's: nothing is done with it
      expect(engine.upgraded).toEqual([]);
      expect(opened).toEqual([]);
      expect(engine.requests.get(reqId).ops).toEqual([]);
    });

    it('routes a request the check let through as plain HTTP when it is not a valid handshake', async () => {
      const engine = wsEngine(WS_CAPS);
      engine.upgradeToWebSocket = () => -1; // the engine's answer to an invalid handshake
      const { routed, asked } = serveChecked(engine, request =>
        request.query === 'later' ? Promise.resolve(undefined) : undefined
      );

      const now = engine.simulate(handshake);
      const later = engine.simulate({ ...handshake, query: 'later' });
      await tick();
      expect(routed).toEqual(['/socket', '/socket']);
      // Asked once each: the request handed back to the router is not probed again
      expect(asked).toHaveLength(2);
      expect(lastOp(engine, now).status).toBe(200);
      expect(lastOp(engine, later).status).toBe(200);
    });
  });

  it('uses the same buffers the engine handed out', () => {
    const engine = createFakeEngine({ capabilities: BATCH_CAPS });
    const server = createServer(engine);
    expect((server as any)._batchDesc).toBe(engine.batch.descriptors);
    expect((server as any)._batchCtl).toBe(engine.batch.control);
    expect((server as any)._batchPaths).toBe(engine.batch.paths);
  });
});
