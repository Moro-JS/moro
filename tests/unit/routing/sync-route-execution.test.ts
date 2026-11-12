// @ts-nocheck
// Unit Tests - a route with middleware runs synchronously for as long as it
// is synchronous. handleRequest returns `true` (not a promise) when every
// middleware and the handler returned plain values, and the response has been
// sent by then; the first promise anywhere hands the rest of the route to the
// asynchronous continuation with order, early answers and errors unchanged.
import { describe, it, expect, beforeEach } from '@jest/globals';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';

function fakeRes() {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    sent: [] as any[],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.sent.push(body);
      res.headersSent = true;
    },
    send(body: any) {
      res.sent.push(body);
      res.headersSent = true;
    },
  };
  return res;
}
const fakeReq = (path: string, method = 'GET') =>
  ({ method, path, params: {}, requestId: 'r1' }) as any;
const tick = () => new Promise(resolve => setImmediate(resolve));

describe('UnifiedRouter: routes with middleware stay synchronous until something is not', () => {
  let router: UnifiedRouter;
  beforeEach(() => {
    router = UnifiedRouter.getInstance();
    router.clearAllRoutes();
    router.setErrorHandler(undefined as any);
  });

  it('sync middleware and a sync handler answer inside the dispatch call', () => {
    const order: string[] = [];
    router.addRoute(
      'GET',
      '/s',
      (_req, res) => {
        order.push('handler');
        res.send('done');
      },
      [
        (_req, _res, next) => {
          order.push('a');
          next();
        },
        () => {
          order.push('b'); // returns without calling next(): auto-advanced
        },
      ]
    );
    const res = fakeRes();
    const result = router.handleRequest(fakeReq('/s'), res);
    expect(result).toBe(true); // a boolean, not a promise
    expect(order).toEqual(['a', 'b', 'handler']);
    expect(res.sent).toEqual(['done']); // already sent when handleRequest returned
  });

  it('a returned value is sent as JSON, synchronously, and params are set on a dynamic route', () => {
    router.addRoute('GET', '/u/:id', req => ({ id: req.params.id }), [(_q, _s, next) => next()]);
    const req = fakeReq('/u/42');
    const res = fakeRes();
    expect(router.handleRequest(req, res)).toBe(true);
    expect(res.sent).toEqual([{ id: '42' }]);
  });

  it('a middleware that answers stops the chain and the handler, still synchronously', () => {
    const order: string[] = [];
    router.addRoute('GET', '/stop', () => order.push('handler'), [
      (_req, res) => {
        order.push('gate');
        res.status(401).json({ error: 'no' });
      },
      () => order.push('never'),
    ]);
    const res = fakeRes();
    expect(router.handleRequest(fakeReq('/stop'), res)).toBe(true);
    expect(order).toEqual(['gate']);
    expect(res.statusCode).toBe(401);
  });

  it('an async middleware in the middle: the rest runs behind it, in order', async () => {
    const order: string[] = [];
    router.addRoute(
      'GET',
      '/mixed',
      () => {
        order.push('handler');
        return { ok: true };
      },
      [
        () => order.push('sync-1'),
        async () => {
          await tick();
          order.push('async');
        },
        () => order.push('sync-2'),
      ]
    );
    const res = fakeRes();
    const result = router.handleRequest(fakeReq('/mixed'), res);
    expect(typeof (result as any).then).toBe('function');
    expect(order).toEqual(['sync-1']); // nothing past the async one has run yet
    expect(await result).toBe(true);
    expect(order).toEqual(['sync-1', 'async', 'sync-2', 'handler']);
    expect(res.sent).toEqual([{ ok: true }]);
  });

  it('an async handler behind sync middleware resolves to its JSON reply', async () => {
    router.addRoute('GET', '/ah', async () => ({ late: 1 }), [(_q, _s, next) => next()]);
    const res = fakeRes();
    const result = router.handleRequest(fakeReq('/ah'), res);
    expect(typeof (result as any).then).toBe('function');
    expect(res.sent).toEqual([]);
    expect(await result).toBe(true);
    expect(res.sent).toEqual([{ late: 1 }]);
  });

  it('a throw from sync middleware, a sync handler or an async handler reaches the error handler', async () => {
    const seen: string[] = [];
    router.setErrorHandler((err, _req, res) => {
      seen.push(err.message);
      res.status(418).json({ handled: err.message });
    });
    router.addRoute('GET', '/e1', () => 'unreached', [
      () => {
        throw new Error('mw');
      },
    ]);
    router.addRoute(
      'GET',
      '/e2',
      () => {
        throw new Error('handler');
      },
      [(_q, _s, next) => next()]
    );
    router.addRoute(
      'GET',
      '/e3',
      async () => {
        throw new Error('async-handler');
      },
      [(_q, _s, next) => next()]
    );
    for (const path of ['/e1', '/e2', '/e3']) {
      const res = fakeRes();
      expect(await router.handleRequest(fakeReq(path), res)).toBe(true);
      expect(res.statusCode).toBe(418);
    }
    expect(seen).toEqual(['mw', 'handler', 'async-handler']);
  });

  it('without an error handler a failing route answers 500 with the request id', async () => {
    router.addRoute(
      'GET',
      '/e500',
      () => {
        throw new Error('boom');
      },
      [(_q, _s, next) => next()]
    );
    const res = fakeRes();
    expect(await router.handleRequest(fakeReq('/e500'), res)).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.sent).toEqual([{ success: false, error: 'Internal server error', requestId: 'r1' }]);
  });

  it('phase middleware (before / after) follows the same rule', async () => {
    const order: string[] = [];
    router.route({
      method: 'GET',
      path: '/phases',
      handler: (_req, res) => {
        order.push('handler');
        res.send('ok');
      },
      middleware: {
        before: [() => order.push('before')],
        after: [() => order.push('after')],
      },
    });
    const res = fakeRes();
    const result = router.handleRequest(fakeReq('/phases'), res);
    expect(result).toBe(true);
    expect(order[0]).toBe('before');
    expect(order).toContain('handler');
    expect(res.sent).toEqual(['ok']);
  });
});
