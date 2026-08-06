// Enforcement contract for the rate-limit built-in.
// Drives RateLimitCore and the standard middleware directly with fake req/res
// objects. Time is driven deterministically by mocking Date.now() (RateLimitCore
// derives its monotonic clock from Date.now()), so there are no real sleeps.
import {
  RateLimitCore,
  createRateLimitMiddleware,
} from '../../../src/core/middleware/built-in/rate-limit/index.js';

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
