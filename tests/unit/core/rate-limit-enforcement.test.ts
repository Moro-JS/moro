// Enforcement contract for the rate-limit built-in.
// Drives RateLimitCore and the standard middleware directly with fake req/res
// objects. Time is driven deterministically by mocking Date.now() (RateLimitCore
// derives its monotonic clock from Date.now()), so there are no real sleeps.
// What a request is counted under (its route, not its URL) needs the router,
// so that part runs real apps on the Node http server and on the native engine.
import {
  RateLimitCore,
  createRateLimitMiddleware,
} from '../../../src/core/middleware/built-in/rate-limit/index.js';
import { createApp, middleware } from '../../../src/index.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { UnifiedRouter } from '../../../src/core/routing/unified-router.js';
import { closeApp, createTestPort } from '../../setup.js';
import { describeEngine } from '../../integration/engine-test-utils.js';

describe('rate-limit enforcement', () => {
  describe('RateLimitCore.check', () => {
    it('allows the first N requests in the window and rejects request N+1', () => {
      const core = new RateLimitCore();
      const requests = 3;
      const window = 60000;
      try {
        expect(core.check('client-a', 'GET:/api', requests, window)).toBe(true); // 1
        expect(core.check('client-a', 'GET:/api', requests, window)).toBe(true); // 2
        expect(core.check('client-a', 'GET:/api', requests, window)).toBe(true); // 3
        expect(core.check('client-a', 'GET:/api', requests, window)).toBe(false); // 4 -> rejected
        expect(core.check('client-a', 'GET:/api', requests, window)).toBe(false); // still rejected
      } finally {
        core.clear();
      }
    });

    it('tracks limits independently per client and per route', () => {
      const core = new RateLimitCore();
      try {
        expect(core.check('c1', 'GET:/a', 1, 60000)).toBe(true);
        expect(core.check('c1', 'GET:/a', 1, 60000)).toBe(false); // c1 on /a exhausted
        expect(core.check('c2', 'GET:/a', 1, 60000)).toBe(true); // different client -> own bucket
        expect(core.check('c1', 'GET:/b', 1, 60000)).toBe(true); // same client, different route
      } finally {
        core.clear();
      }
    });

    it('reports a positive retry-after (in seconds, bounded by the window) once limited', () => {
      const core = new RateLimitCore();
      try {
        core.check('c', 'GET:/x', 1, 10000);
        core.check('c', 'GET:/x', 1, 10000); // exceed
        const retry = core.getRetryAfter('c', 'GET:/x');
        expect(retry).toBeGreaterThan(0);
        expect(retry).toBeLessThanOrEqual(10);
      } finally {
        core.clear();
      }
    });

    it('allows requests again after the window resets', () => {
      const core = new RateLimitCore();
      let fakeNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      try {
        expect(core.check('c', 'GET:/x', 2, 1000)).toBe(true);
        expect(core.check('c', 'GET:/x', 2, 1000)).toBe(true);
        expect(core.check('c', 'GET:/x', 2, 1000)).toBe(false); // window full
        fakeNow += 1001; // cross the window boundary
        expect(core.check('c', 'GET:/x', 2, 1000)).toBe(true); // reset -> allowed
        expect(core.check('c', 'GET:/x', 2, 1000)).toBe(true);
        expect(core.check('c', 'GET:/x', 2, 1000)).toBe(false); // full again
      } finally {
        nowSpy.mockRestore();
        core.clear();
      }
    });
  });

  describe('the counter store', () => {
    it('keeps a counter that is refusing requests when the store fills up', () => {
      const core = new RateLimitCore();
      try {
        expect(core.check('attacker', 'POST:/login', 1, 60000)).toBe(true);
        expect(core.check('attacker', 'POST:/login', 1, 60000)).toBe(false);

        // more new keys than the store holds
        for (let i = 0; i < 100_050; i++) core.check(`client-${i}`, 'GET:/x', 5, 60000);

        expect(core.check('attacker', 'POST:/login', 1, 60000)).toBe(false);
        expect(core.size).toBeLessThanOrEqual(100_000);
      } finally {
        core.clear();
      }
    });

    it('makes room by dropping the oldest counter that is not refusing requests', () => {
      const core = new RateLimitCore({ maxEntries: 3 });
      try {
        core.check('exhausted', 'GET:/x', 1, 60000); // 1 of 1: refusing from here on
        core.check('half', 'GET:/x', 2, 60000); // 1 of 2
        core.check('other', 'GET:/x', 2, 60000);

        core.check('new', 'GET:/x', 2, 60000); // store is full: 'half' makes room
        expect(core.size).toBe(3);
        expect(core.check('exhausted', 'GET:/x', 1, 60000)).toBe(false);

        // 'half' starts over: two more requests fit, where one would have
        expect(core.check('half', 'GET:/x', 2, 60000)).toBe(true);
        expect(core.check('half', 'GET:/x', 2, 60000)).toBe(true);
        expect(core.check('half', 'GET:/x', 2, 60000)).toBe(false);
      } finally {
        core.clear();
      }
    });

    it('drops an expired counter before a live one', () => {
      const core = new RateLimitCore({ maxEntries: 2 });
      let fakeNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
      try {
        core.check('live', 'GET:/x', 3, 60000);
        core.check('short', 'GET:/x', 1, 1000); // exhausted, but only for a second
        fakeNow += 1500;

        core.check('new', 'GET:/x', 3, 60000);
        expect(core.size).toBe(2);
        // 'live' kept its count: two more fit, not three
        expect(core.check('live', 'GET:/x', 3, 60000)).toBe(true);
        expect(core.check('live', 'GET:/x', 3, 60000)).toBe(true);
        expect(core.check('live', 'GET:/x', 3, 60000)).toBe(false);
      } finally {
        nowSpy.mockRestore();
        core.clear();
      }
    });

    it('lets a new key through uncounted when every counter is refusing requests', () => {
      const core = new RateLimitCore({ maxEntries: 2 });
      try {
        for (const client of ['a', 'b']) {
          core.check(client, 'POST:/login', 1, 60000);
          expect(core.check(client, 'POST:/login', 1, 60000)).toBe(false);
        }

        // not refused (that would shut every new client out), and not stored
        expect(core.check('c', 'POST:/login', 1, 60000)).toBe(true);
        expect(core.check('c', 'POST:/login', 1, 60000)).toBe(true);
        expect(core.size).toBe(2);
        // the limits already in force stay in force
        expect(core.check('a', 'POST:/login', 1, 60000)).toBe(false);
        expect(core.check('b', 'POST:/login', 1, 60000)).toBe(false);
      } finally {
        core.clear();
      }
    });
  });

  describe('createRateLimitMiddleware', () => {
    const makeReq = (ip: string, method = 'GET', path = '/mw') =>
      ({ ip, method, path, connection: {} }) as any;

    const makeRes = () => {
      const res: any = {
        statusCode: 0,
        body: undefined,
        headersSent: false,
        headers: {} as Record<string, any>,
        setHeader(name: string, value: any) {
          this.headers[name.toLowerCase()] = value;
          return this;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: any) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        // No event emitter here, so skipSuccessfulRequests takes the
        // wrapped-end() path — the same one the HTTP/2 response uses.
        end() {
          this.headersSent = true;
          return this;
        },
      };
      return res;
    };

    it('calls next() while under the limit and returns HTTP 429 once exceeded', async () => {
      const mw = createRateLimitMiddleware({ requests: 2, window: 60000 });
      // Unique client id so we do not collide with the shared core used by other tests.
      const ip = 'mw-client-unique-1';
      let nextCount = 0;
      const next = (() => {
        nextCount++;
      }) as () => Promise<void>;

      const res1 = makeRes();
      await mw(makeReq(ip), res1, next);
      const res2 = makeRes();
      await mw(makeReq(ip), res2, next);

      // Under the limit: next() called for both, no 429 sent.
      expect(nextCount).toBe(2);
      expect(res1.statusCode).toBe(0);
      expect(res2.statusCode).toBe(0);

      // Third request in the window is rejected.
      const res3 = makeRes();
      await mw(makeReq(ip), res3, next);
      expect(nextCount).toBe(2); // next() NOT called again
      expect(res3.statusCode).toBe(429);
      expect(res3.body).toMatchObject({ success: false, error: 'Rate limit exceeded' });
      expect(typeof res3.body.retryAfter).toBe('number');
      // Clients need to know when to come back
      expect(res3.headers['retry-after']).toBe(String(res3.body.retryAfter));
    });

    it('refunds successful responses when skipSuccessfulRequests is set', async () => {
      const mw = createRateLimitMiddleware({
        requests: 2,
        window: 60000,
        skipSuccessfulRequests: true,
      });
      const ip = 'mw-client-skip-success';
      const next = (() => {}) as () => Promise<void>;

      // Every response finishes with a 200, so nothing is ever counted
      for (let i = 0; i < 5; i++) {
        const res = makeRes();
        res.statusCode = 200;
        await mw(makeReq(ip), res, next);
        expect(res.statusCode).toBe(200);
        res.end();
      }

      // Failures still count: two of them fill the window
      for (let i = 0; i < 2; i++) {
        const res = makeRes();
        res.statusCode = 500;
        await mw(makeReq(ip), res, next);
        res.end();
      }

      const blocked = makeRes();
      await mw(makeReq(ip), blocked, next);
      expect(blocked.statusCode).toBe(429);
    });

    it('refunds failed responses when skipFailedRequests is set', async () => {
      const mw = createRateLimitMiddleware({
        requests: 2,
        window: 60000,
        skipFailedRequests: true,
      });
      const ip = 'mw-client-skip-failed';
      const next = (() => {}) as () => Promise<void>;

      // Failures are refunded, so they never fill the window
      for (let i = 0; i < 5; i++) {
        const res = makeRes();
        res.statusCode = 404;
        await mw(makeReq(ip), res, next);
        expect(res.statusCode).toBe(404);
        res.end();
      }

      // Successes still count
      for (let i = 0; i < 2; i++) {
        const res = makeRes();
        res.statusCode = 200;
        await mw(makeReq(ip), res, next);
        res.end();
      }

      const blocked = makeRes();
      await mw(makeReq(ip), blocked, next);
      expect(blocked.statusCode).toBe(429);
    });

    it('counts per keyGenerator result when one is given', async () => {
      const mw = createRateLimitMiddleware({
        requests: 1,
        window: 60000,
        keyGenerator: req => req.headers?.['x-api-key'] as string | undefined,
      });
      const send = async (ip: string, apiKey?: string) => {
        const req = makeReq(ip, 'GET', '/mw-keyed');
        req.headers = apiKey ? { 'x-api-key': apiKey } : {};
        const res = makeRes();
        await mw(req, res, (async () => {}) as () => Promise<void>);
        return res.statusCode === 429 ? 429 : 200;
      };

      // one account behind two addresses shares a counter
      expect(await send('10.0.0.1', 'key-A')).toBe(200);
      expect(await send('10.0.0.2', 'key-A')).toBe(429);
      // two accounts behind one address do not
      expect(await send('10.0.0.1', 'key-B')).toBe(200);
      // no key: the client address is used
      expect(await send('10.0.0.3')).toBe(200);
      expect(await send('10.0.0.3')).toBe(429);
      expect(await send('10.0.0.4')).toBe(200);
    });

    it('is a passthrough (always calls next) when misconfigured', async () => {
      const mw = createRateLimitMiddleware({} as any);
      let nextCalled = false;
      const res = makeRes();
      await mw(makeReq('mw-client-unique-2'), res, (() => {
        nextCalled = true;
      }) as () => Promise<void>);
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(0);
    });
  });
});

function countedPerRoute(engine: 'node' | 'moro') {
  let app: any;
  let base = '';
  let handled = 0;
  // Route-level counters are shared by every app in the process, so each
  // backend gets routes of its own.
  const at = `/${engine}`;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const boot = async (setup: (app: any) => void | Promise<void>) => {
    handled = 0;
    resetConfig();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    await setup(app);
    const port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, () => resolve()));
    expect(app.engine?.server).toBe(engine === 'node' ? 'node' : 'engine');
    base = `http://127.0.0.1:${port}`;
  };

  const statuses = async (paths: string[], init?: Parameters<typeof fetch>[1]) => {
    const seen: number[] = [];
    for (const path of paths) seen.push((await fetch(`${base}${path}`, init)).status);
    return seen;
  };

  it('holds every value of a path parameter to one route-level limit', async () => {
    await boot(a => {
      a.get(`${at}/otp/:code`)
        .rateLimit({ requests: 3, window: 60000 })
        .handler((req: any) => {
          handled++;
          return { code: req.params.code };
        });
    });

    expect(
      await statuses(['1', '2?try=a', '3', '4', '5?try=b', '6'].map(code => `${at}/otp/${code}`))
    ).toEqual([200, 200, 200, 429, 429, 429]);
    expect(handled).toBe(3);
  });

  it('names a route-level counter from the route itself, without a second lookup', async () => {
    await boot(a => {
      a.get(`${at}/own/:id`)
        .rateLimit({ requests: 2, window: 60000 })
        .handler((req: any) => ({ id: req.params.id }));
      a.get(`${at}/own-static`)
        .rateLimit({ requests: 1, window: 60000 })
        .handler(() => ({ ok: true }));
    });

    const lookups = jest.spyOn(UnifiedRouter.prototype, 'matchRoute');
    try {
      expect(await statuses(['/own/1', '/own/2', '/own/3'].map(p => at + p))).toEqual([
        200, 200, 429,
      ]);
      expect(await statuses(['/own-static', '/own-static?again=1'].map(p => at + p))).toEqual([
        200, 429,
      ]);
      // The route that is running knows its own pattern
      expect(lookups).not.toHaveBeenCalled();
    } finally {
      lookups.mockRestore();
    }
  });

  it('keeps routes that share one limit object apart', async () => {
    const limit = { requests: 1, window: 60000 };
    await boot(a => {
      a.get(`${at}/a/:id`)
        .rateLimit(limit)
        .handler(() => ({ route: 'a' }));
      a.get(`${at}/b/:id`)
        .rateLimit(limit)
        .handler(() => ({ route: 'b' }));
    });

    expect(await statuses(['/a/1', '/b/1', '/a/2', '/b/2'].map(p => at + p))).toEqual([
      200, 200, 429, 429,
    ]);
  });

  it('holds every value of a path parameter to one global limit', async () => {
    await boot(async a => {
      await a.use(middleware.rateLimit({ requests: 3, window: 60000 }));
      a.get('/items/:id', (req: any) => {
        handled++;
        return { id: req.params.id };
      });
      a.get('/health', () => ({ ok: true }));
    });

    expect(
      await statuses(['/items/1', '/items/2?x=1', '/items/3', '/items/4', '/items/5?x=2'])
    ).toEqual([200, 200, 200, 429, 429]);
    expect(handled).toBe(3);
    // another route has a counter of its own, as before
    expect(await statuses(['/health'])).toEqual([200]);
    // and a request that matches no route is counted under its path
    expect(
      await statuses(['/missing', '/missing?a=1', '/missing?a=2', '/missing?a=3', '/elsewhere'])
    ).toEqual([404, 404, 404, 429, 404]);
  });

  it('counts per keyGenerator result on the global limiter', async () => {
    await boot(async a => {
      await a.use(
        middleware.rateLimit({
          requests: 1,
          window: 60000,
          keyGenerator: (req: any) => req.headers['x-api-key'],
        })
      );
      a.get('/data', () => ({ ok: true }));
    });

    const as = (key: string) => statuses(['/data'], { headers: { 'x-api-key': key } });
    expect(await as('key-A')).toEqual([200]);
    expect(await as('key-B')).toEqual([200]);
    expect(await as('key-A')).toEqual([429]);
  });
}

describe('rate limit: counted per route (Node http server)', () => countedPerRoute('node'));
describeEngine('rate limit: counted per route (native engine)', () => countedPerRoute('moro'));
