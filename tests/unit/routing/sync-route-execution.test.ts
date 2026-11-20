// @ts-nocheck
// Unit Tests - a route with middleware runs synchronously for as long as it
// is synchronous. handleRequest returns `true` (not a promise) when every
// middleware and the handler returned plain values, and the response has been
// sent by then; the first promise anywhere hands the rest of the route to the
// asynchronous continuation with order, early answers and errors unchanged.
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import { EventEmitter } from 'node:events';

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

// routing.strictMiddleware: a three-parameter middleware passes the request on
// only by calling next(), now or later. Everything else about a route -
// synchronous dispatch, next(err), a middleware that answers - is as without it.
describe('UnifiedRouter: routing.strictMiddleware', () => {
  let router: UnifiedRouter;
  let log: any;
  const logged = (level: string, text: string) =>
    log.mock.calls
      .filter(call => call[0] === level && String(call[1]).includes(text))
      .map(call => String(call[1]));
  const refusals = () => logged('error', 'without calling next()');
  const reminders = () => logged('warn', 'has not called next()');

  beforeEach(() => {
    UnifiedRouter.reset();
    router = UnifiedRouter.createForApp(undefined, { routing: { strictMiddleware: true } } as any);
    globalLogger.setLevel('debug');
    log = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    log.mockRestore();
    globalLogger.setLevel('fatal');
    UnifiedRouter.reset();
  });

  const handler = (order: string[]) => (_req: any, res: any) => {
    order.push('handler');
    res.send('done');
  };
  // A response that also says when it has been sent, as the servers' do
  const eventedRes = () => {
    const res = fakeRes();
    const events = new EventEmitter();
    res.once = (event: string, listener: () => void) => events.once(event, listener);
    res.removeListener = (event: string, listener: () => void) =>
      events.removeListener(event, listener);
    res.emit = (event: string) => events.emit(event);
    res.listenerCount = (event: string) => events.listenerCount(event);
    return res;
  };
  const useFakeTimers = () =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

  it('waits for next(): a chain that calls it stays synchronous, one that calls it from a callback goes on then', async () => {
    const order: string[] = [];
    let fromCallback: () => void = () => {};
    router.addRoute('GET', '/s', handler(order), [
      (_req, _res, next) => {
        order.push('a');
        next();
      },
      (_req, _res, next) => {
        order.push('b');
        next();
      },
    ]);
    router.addRoute('GET', '/store/:id', handler(order), [
      function loadRecord(_req, _res, next) {
        order.push('loadRecord');
        fromCallback = next;
      },
      (_req, _res, next) => {
        order.push('after');
        next();
      },
    ]);

    // Every middleware calls next(): the route still answers inside the call
    const passed = fakeRes();
    expect(router.handleRequest(fakeReq('/s'), passed)).toBe(true);
    expect(order).toEqual(['a', 'b', 'handler']);
    expect(passed.sent).toEqual(['done']);

    // Returned without next(): nothing runs until the callback calls it
    order.length = 0;
    const res = fakeRes();
    const pending = router.handleRequest(fakeReq('/store/7'), res);
    await tick();
    expect(order).toEqual(['loadRecord']);
    expect(res.headersSent).toBe(false);

    fromCallback();
    expect(await pending).toBe(true);
    expect(order).toEqual(['loadRecord', 'after', 'handler']);
    expect(res.sent).toEqual(['done']);
    // Called again, it does nothing
    fromCallback();
    expect(order).toEqual(['loadRecord', 'after', 'handler']);
    expect(refusals()).toEqual([]);
  });

  it('names, once and after 30 seconds, a middleware that neither calls next() nor answers; the handler does not run', async () => {
    useFakeTimers();
    const order: string[] = [];
    let lateNext: () => void = () => {};
    router.addRoute('GET', '/users/:id', handler(order), [
      function ownerOnly(_req, _res, next) {
        order.push('ownerOnly');
        lateNext = next;
      },
    ]);
    const res = fakeRes();
    void router.handleRequest(fakeReq('/users/7'), res);

    jest.advanceTimersByTime(29_999);
    expect(reminders()).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toContain(
      "Middleware 'ownerOnly' on GET /users/:id has not called next() or sent a response 30 seconds"
    );
    jest.advanceTimersByTime(120_000);
    expect(reminders()).toHaveLength(1);
    expect(order).toEqual(['ownerOnly']);
    expect(res.headersSent).toBe(false);
    expect(refusals()).toEqual([]);

    // It is still waited for: a next() that does come passes the request on
    lateNext();
    await tick();
    expect(order).toEqual(['ownerOnly', 'handler']);
  });

  it('stops the 30-second clock when next() is called, and when the response is sent or the connection closes', async () => {
    useFakeTimers();
    const order: string[] = [];
    const calls: Array<{ res: any; next: () => void }> = [];
    router.addRoute('GET', '/w', handler(order), [
      function waits(_req, res, next) {
        calls.push({ res, next });
      },
    ]);
    const start = () => {
      const res = eventedRes();
      void router.handleRequest(fakeReq('/w'), res);
      return calls[calls.length - 1];
    };

    // next() from a callback
    const called = start();
    expect(jest.getTimerCount()).toBe(1);
    called.next();
    expect(jest.getTimerCount()).toBe(0);
    expect(called.res.listenerCount('finish') + called.res.listenerCount('close')).toBe(0);
    await tick();
    expect(order).toEqual(['handler']);

    // An answer from a callback: the chain ends, and a next() after it is ignored
    const answered = start();
    answered.res.status(403).json({ denied: true });
    answered.res.emit('finish');
    expect(jest.getTimerCount()).toBe(0);
    answered.next();
    await tick();
    expect(order).toEqual(['handler']);
    expect(answered.res.sent).toEqual([{ denied: true }]);

    // The client went away with nothing sent: nothing more runs for the request
    const gone = start();
    gone.res.emit('close');
    expect(jest.getTimerCount()).toBe(0);
    gone.next();
    await tick();
    expect(order).toEqual(['handler']);

    jest.advanceTimersByTime(60_000);
    expect(reminders()).toEqual([]);
  });

  it('answers 500 when the promise resolves without next(); a function with fewer parameters has none to call', async () => {
    const order: string[] = [];
    router
      .get('/async')
      .before(
        async () => {
          order.push('none');
        },
        (req: any, _res: any) => {
          order.push('two');
          req.seen = true;
        },
        async (_req: any, _res: any, next: any) => {
          order.push('three');
          // Too late: the promise has resolved by then
          setImmediate(next);
        }
      )
      .handler(handler(order));
    const res = fakeRes();
    await router.handleRequest(fakeReq('/async'), res);
    await tick();

    expect(order).toEqual(['none', 'two', 'three']);
    expect(res.statusCode).toBe(500);
    expect(res.sent).toEqual([{ success: false, error: 'Internal server error', requestId: 'r1' }]);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('Middleware #3 on GET /async finished without');
  });

  it('refuses only that: a middleware still answers, fails the request with next(err), or calls next() mid-way', async () => {
    const order: string[] = [];
    const seen: any[] = [];
    router.setErrorHandler((err, _req, res) => {
      seen.push(err.message);
      res.status(418).json({ handled: err.message });
    });
    const forgetful = async (_req: any, _res: any, _next: any) => {};
    router.addRoute('GET', '/forgetful', handler(order), [forgetful]);
    router.addRoute('GET', '/denied', handler(order), [
      (_req, res, _next) => {
        res.status(403).json({ denied: true });
      },
    ]);
    router.addRoute('GET', '/failed', handler(order), [
      (_req, _res, next) => next(new Error('no')),
    ]);
    router.addRoute('GET', '/failed-later', handler(order), [
      async (_req, _res, next) => {
        await tick();
        next(new Error('later'));
      },
      (_req, _res, next) => {
        setImmediate(() => next(new Error('from a callback')));
      },
    ]);
    router.addRoute('GET', '/awaited', handler(order), [
      async (_req, _res, next) => {
        await tick();
        order.push('awaited');
        next();
      },
    ]);

    const refused = fakeRes();
    await router.handleRequest(fakeReq('/forgetful'), refused);
    expect(refused.statusCode).toBe(500);
    expect(refusals()).toHaveLength(1);

    const denied = fakeRes();
    expect(router.handleRequest(fakeReq('/denied'), denied)).toBe(true);
    expect(denied.sent).toEqual([{ denied: true }]);
    const failed = fakeRes();
    await router.handleRequest(fakeReq('/failed'), failed);
    expect(failed.sent).toEqual([{ handled: 'no' }]);
    const failedLater = fakeRes();
    await router.handleRequest(fakeReq('/failed-later'), failedLater);
    expect(failedLater.sent).toEqual([{ handled: 'later' }]);
    expect(seen).toEqual(['no', 'later']);
    expect(order).toEqual([]);

    const awaited = fakeRes();
    await router.handleRequest(fakeReq('/awaited'), awaited);
    expect(order).toEqual(['awaited', 'handler']);
    expect(refusals()).toHaveLength(1);
  });

  it('applies to every phase and form, without touching the lists it was given', async () => {
    const forgetful = async (_req: any, _res: any, _next: any) => {};
    const given = [forgetful];
    router
      .get('/before')
      .before(forgetful)
      .handler(() => ({}));
    router
      .get('/after')
      .after(forgetful)
      .handler(() => ({}));
    router
      .get('/transform')
      .transform(forgetful)
      .handler(() => ({}));
    router.addRoute('GET', '/list', () => ({}), given);
    router.route({ method: 'GET', path: '/schema', middleware: given, handler: () => ({}) });

    for (const path of ['/before', '/after', '/transform', '/list', '/schema']) {
      const res = fakeRes();
      await router.handleRequest(fakeReq(path), res);
      expect([path, res.statusCode]).toEqual([path, 500]);
    }
    expect(given).toEqual([forgetful]);
    expect(given[0]).toBe(forgetful);
  });

  it('is decided by the configuration of the app the router belongs to', async () => {
    const forgetful = async (_req: any, _res: any, _next: any) => {};
    const statusWith = async (config: unknown, registerFirst = false) => {
      UnifiedRouter.reset();
      // A route registered before the app exists is that app's route too
      const early = registerFirst ? UnifiedRouter.getInstance() : undefined;
      early
        ?.get('/r')
        .before(forgetful)
        .handler(() => ({ reached: true }));
      const appRouter = UnifiedRouter.createForApp(undefined, config as any);
      if (!registerFirst) {
        appRouter
          .get('/r')
          .before(forgetful)
          .handler(() => ({ reached: true }));
      }
      const res = fakeRes();
      await appRouter.handleRequest(fakeReq('/r'), res);
      return res.statusCode;
    };

    expect(await statusWith({ routing: { strictMiddleware: true } })).toBe(500);
    expect(await statusWith({ routing: { enabled: false, strictMiddleware: true } }, true)).toBe(
      500
    );
    expect(await statusWith(undefined)).toBe(200);
    expect(await statusWith({ routing: true })).toBe(200);
    expect(await statusWith({ routing: { enabled: true } })).toBe(200);
    expect(await statusWith({ routing: { strictMiddleware: false } }, true)).toBe(200);
  });
});
