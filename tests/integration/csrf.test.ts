// Integration - CSRF protection (signed double-submit cookie).
//
//  - A state-changing request whose token does not match its cookie is
//    answered 403; it never reaches the route and is not a server error.
//  - The token is signed with the configured secret: a value that was only
//    written into both the cookie and the request does not pass.
//  - With a session, a token belongs to the session it was issued in.
//  - `req.csrfToken()` returns the request's token: the one the cookie already
//    carries, or the one issued for this request. It sets the cookie only when
//    it issues a token.
//
// Runs on the Node http server and on the native engine.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { createApp, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { createCSRFMiddleware, CSRFCore } from '../../src/core/middleware/built-in/csrf/index.js';
import { closeApp, createTestPort } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

const SECRET = 'csrf-test-secret';
/** A token as this version issues it: 32 random bytes in hex, a dot, an HMAC-SHA256 */
const SIGNED_TOKEN = /^[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/;
/** A token as earlier versions issued it: the random part alone */
const LEGACY_TOKEN = 'ab'.repeat(32);

/** `_csrf=<token>` from a response that set the cookie, if it did. */
function csrfCookie(res: FetchResponse): string | undefined {
  const all = res.headers.getSetCookie().filter(c => c.startsWith('_csrf='));
  return all[all.length - 1]?.split(';')[0];
}

function suite(engine: 'node' | 'moro') {
  let app: any;
  let base = '';
  let transfers = 0;

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const boot = async (
    options: { csrf?: Record<string, unknown>; cookie?: Record<string, unknown> } = {}
  ) => {
    transfers = 0;
    resetConfig();
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    await app.use(middleware.cookie(options.cookie as any));
    await app.use(middleware.csrf({ secret: SECRET, ...options.csrf }));

    app.get('/token', async (req: any) => ({ token: await req.csrfToken() }));
    app.get('/token-twice', async (req: any) => ({
      first: await req.csrfToken(),
      second: await req.csrfToken(),
    }));
    app.post('/transfer', () => {
      transfers++;
      return { ok: true };
    });

    const port = createTestPort();
    await listen(app, port);
    expect(app.engine?.server).toBe(engine === 'node' ? 'node' : 'engine');
    base = `http://127.0.0.1:${port}`;
  };

  /** A token and the cookie that carries it, as a browser would hold them. */
  const issue = async () => {
    const res = await fetch(`${base}/token`);
    const { token } = (await res.json()) as { token: string };
    const cookie = csrfCookie(res) as string;
    expect(cookie).toBe(`_csrf=${token}`);
    return { token, cookie };
  };

  it('answers 403 when a POST carries no token', async () => {
    await boot();
    const res = await fetch(`${base}/transfer`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Invalid CSRF token',
      code: 'CSRF_TOKEN_MISMATCH',
    });
    expect(transfers).toBe(0);
  });

  it('answers 403 when the token does not match the cookie', async () => {
    await boot();
    const { cookie } = await issue();
    const res = await fetch(`${base}/transfer`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': 'f'.repeat(64) },
    });

    expect(res.status).toBe(403);
    expect(transfers).toBe(0);
  });

  it('lets a POST through when the token matches the cookie', async () => {
    await boot();
    const { token, cookie } = await issue();
    const res = await fetch(`${base}/transfer`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': token },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(transfers).toBe(1);
  });

  it('finds the token under a header name configured in mixed case', async () => {
    await boot({ csrf: { headerName: 'X-XSRF-Token' } });
    const { token, cookie } = await issue();

    const res = await fetch(`${base}/transfer`, {
      method: 'POST',
      headers: { cookie, 'X-XSRF-Token': token },
    });
    expect(res.status).toBe(200);
    expect(transfers).toBe(1);

    // the default header name is not consulted once another is configured
    const other = await fetch(`${base}/transfer`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': token },
    });
    expect(other.status).toBe(403);
    expect(transfers).toBe(1);
  });

  it('works alongside a cookie middleware that signs', async () => {
    await boot({ cookie: { secret: 'cookie-signing-secret', signed: true } });
    const page = await fetch(`${base}/token`);
    const { token } = (await page.json()) as { token: string };
    const cookie = csrfCookie(page) as string;

    const res = await fetch(`${base}/transfer`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': token },
    });
    expect(res.status).toBe(200);
    expect(transfers).toBe(1);
  });

  it('returns the same token for every call within a request', async () => {
    await boot();
    const res = await fetch(`${base}/token-twice`);
    const body = (await res.json()) as { first: string; second: string };

    expect(body.first).toMatch(SIGNED_TOKEN);
    expect(body.second).toBe(body.first);
    expect(res.headers.getSetCookie().filter(c => c.startsWith('_csrf='))).toHaveLength(1);
  });

  it('returns the token the cookie already carries, without replacing the cookie', async () => {
    await boot();
    const { token, cookie } = await issue();

    const again = await fetch(`${base}/token`, { headers: { cookie } });
    expect(((await again.json()) as { token: string }).token).toBe(token);
    expect(csrfCookie(again)).toBeUndefined();

    // A token read before the second page was rendered is still valid
    const res = await fetch(`${base}/transfer`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': token },
    });
    expect(res.status).toBe(200);
  });

  it('issues a new token when the cookie does not hold one it issued', async () => {
    await boot();
    const res = await fetch(`${base}/token`, { headers: { cookie: '_csrf=not-a-token' } });
    const { token } = (await res.json()) as { token: string };

    expect(token).toMatch(SIGNED_TOKEN);
    expect(csrfCookie(res)).toBe(`_csrf=${token}`);
  });

  describe('signed tokens', () => {
    const post = (cookie: string, token: string, path = '/transfer') =>
      fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'x-csrf-token': token } });

    it('refuses a value that was only written into both the cookie and the request', async () => {
      await boot({ csrf: { legacyTokens: false } });
      const forged = `${'f'.repeat(64)}.${'A'.repeat(43)}`;

      expect((await post(`_csrf=${forged}`, forged)).status).toBe(403);
      expect(transfers).toBe(0);
    });

    it('refuses a token signed with another secret', async () => {
      await boot();
      const foreign = new CSRFCore({ secret: 'some-other-secret' }).generateToken();
      expect(foreign).toMatch(SIGNED_TOKEN);

      expect((await post(`_csrf=${foreign}`, foreign)).status).toBe(403);
      expect(transfers).toBe(0);
    });

    it('refuses a token whose random part or signature was altered', async () => {
      await boot();
      const { token } = await issue();
      const flipped = (token[0] === '0' ? '1' : '0') + token.slice(1);
      const resigned = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

      expect((await post(`_csrf=${flipped}`, flipped)).status).toBe(403);
      expect((await post(`_csrf=${resigned}`, resigned)).status).toBe(403);
      expect(transfers).toBe(0);
    });

    it('accepts an unsigned token of the earlier format unless legacyTokens is false', async () => {
      await boot();
      expect((await post(`_csrf=${LEGACY_TOKEN}`, LEGACY_TOKEN)).status).toBe(200);
      expect(transfers).toBe(1);
      await closeApp(app);

      await boot({ csrf: { legacyTokens: false } });
      expect((await post(`_csrf=${LEGACY_TOKEN}`, LEGACY_TOKEN)).status).toBe(403);
      expect(transfers).toBe(0);
    });

    it('replaces an unsigned token of the earlier format when a page asks for its token', async () => {
      await boot();
      const res = await fetch(`${base}/token`, { headers: { cookie: `_csrf=${LEGACY_TOKEN}` } });
      const { token } = (await res.json()) as { token: string };

      expect(token).toMatch(SIGNED_TOKEN);
      expect(csrfCookie(res)).toBe(`_csrf=${token}`);
    });
  });

  describe('token in the query string', () => {
    const postWithQueryToken = async () => {
      const { token, cookie } = await issue();
      return fetch(`${base}/transfer?_csrf=${token}`, { method: 'POST', headers: { cookie } });
    };

    it('is read only with allowQueryToken: true', async () => {
      await boot();
      expect((await postWithQueryToken()).status).toBe(403);
      expect(transfers).toBe(0);
      await closeApp(app);

      await boot({ csrf: { allowQueryToken: true } });
      expect((await postWithQueryToken()).status).toBe(200);
      expect(transfers).toBe(1);
    });
  });

  describe('with a session', () => {
    /** Every cookie a response set, as a Cookie header a browser would send back */
    const jar = (res: FetchResponse, previous = ''): string => {
      const cookies = new Map<string, string>();
      for (const pair of previous.split('; ').filter(Boolean)) {
        cookies.set(pair.slice(0, pair.indexOf('=')), pair);
      }
      for (const header of res.headers.getSetCookie()) {
        const pair = header.split(';')[0] as string;
        cookies.set(pair.slice(0, pair.indexOf('=')), pair);
      }
      return [...cookies.values()].join('; ');
    };

    const bootWithSession = async (order: 'session-first' | 'csrf-first' = 'session-first') => {
      transfers = 0;
      resetConfig();
      app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
      const session = middleware.session({ secret: 'session-test-secret' });
      const csrf = middleware.csrf({ secret: SECRET });
      await app.use(order === 'session-first' ? session : csrf);
      await app.use(order === 'session-first' ? csrf : session);

      app.get('/token', async (req: any) => ({ token: await req.csrfToken() }));
      app.get('/visit', (req: any) => {
        req.session.visits = (req.session.visits || 0) + 1;
        return { visits: req.session.visits };
      });
      app.get('/login', async (req: any) => {
        await req.session.regenerate();
        req.session.user = 'u1';
        return { token: await req.csrfToken() };
      });
      app.post('/transfer', () => {
        transfers++;
        return { ok: true };
      });

      const port = createTestPort();
      await listen(app, port);
      base = `http://127.0.0.1:${port}`;
    };

    /** A browser that has been given a token: its cookies and the token */
    const visitor = async () => {
      const res = await fetch(`${base}/token`);
      const { token } = (await res.json()) as { token: string };
      return { token, cookies: jar(res) };
    };

    const transfer = (cookie: string, token: string) =>
      fetch(`${base}/transfer`, { method: 'POST', headers: { cookie, 'x-csrf-token': token } });

    it('accepts a token in the session it was issued in, on every page of that session', async () => {
      await bootWithSession();
      const alice = await visitor();

      expect(alice.token).toMatch(SIGNED_TOKEN);
      expect((await transfer(alice.cookies, alice.token)).status).toBe(200);
      expect(transfers).toBe(1);

      // other session writes and later pages leave the token as it is
      const visit = await fetch(`${base}/visit`, { headers: { cookie: alice.cookies } });
      expect(await visit.json()).toEqual({ visits: 1 });
      const again = await fetch(`${base}/token`, { headers: { cookie: alice.cookies } });
      expect(((await again.json()) as { token: string }).token).toBe(alice.token);
      expect(csrfCookie(again)).toBeUndefined();
      expect((await transfer(alice.cookies, alice.token)).status).toBe(200);
    });

    it('refuses, in one session, a token issued in another', async () => {
      await bootWithSession();
      const alice = await visitor();
      const mallory = await visitor();

      // Mallory's genuine token and token cookie, planted beside Alice's session
      const aliceSession = alice.cookies.split('; ').find(c => c.startsWith('connect.sid='));
      const planted = `${aliceSession}; _csrf=${mallory.token}`;

      expect((await transfer(planted, mallory.token)).status).toBe(403);
      expect(transfers).toBe(0);
    });

    it('refuses a token that was issued without a session', async () => {
      await bootWithSession();
      const alice = await visitor();
      const sessionless = new CSRFCore({ secret: SECRET }).generateToken();
      const aliceSession = alice.cookies.split('; ').find(c => c.startsWith('connect.sid='));

      expect((await transfer(`${aliceSession}; _csrf=${sessionless}`, sessionless)).status).toBe(
        403
      );
      expect(transfers).toBe(0);
    });

    it('needs a new token once the session id is regenerated', async () => {
      await bootWithSession();
      const before = await visitor();

      const login = await fetch(`${base}/login`, { headers: { cookie: before.cookies } });
      const { token: after } = (await login.json()) as { token: string };
      const cookies = jar(login, before.cookies);
      expect(after).toMatch(SIGNED_TOKEN);
      expect(after).not.toBe(before.token);

      // the token from before the login no longer belongs to this session
      const stale = cookies.replace(/_csrf=[^;]+/, `_csrf=${before.token}`);
      expect((await transfer(stale, before.token)).status).toBe(403);
      expect((await transfer(cookies, after)).status).toBe(200);
      expect(transfers).toBe(1);
    });

    it('issues signed tokens that verify when the session middleware is registered after it', async () => {
      await bootWithSession('csrf-first');
      const alice = await visitor();

      expect(alice.token).toMatch(SIGNED_TOKEN);
      expect((await transfer(alice.cookies, alice.token)).status).toBe(200);
      expect(transfers).toBe(1);
    });
  });

  describe('Secure on the token cookie behind a proxy', () => {
    const bootBehindProxy = async (trustProxy?: unknown) => {
      resetConfig();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine, ...(trustProxy === undefined ? {} : { trustProxy }) },
      } as any);
      await app.use(middleware.csrf({ secret: SECRET }));
      app.get('/token', async (req: any) => ({ token: await req.csrfToken() }));
      const port = createTestPort();
      await listen(app, port);
      base = `http://127.0.0.1:${port}`;
    };
    const secureCookie = async (headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}/token`, { headers });
      const cookie = res.headers.getSetCookie().find(c => c.startsWith('_csrf=')) as string;
      return cookie.split(';').some(part => part.trim() === 'Secure');
    };
    const FORWARDED_HTTPS = { 'x-forwarded-proto': 'https' };

    it('follows X-Forwarded-Proto, but only from a trusted proxy once server.trustProxy is set', async () => {
      // no trustProxy: the header is believed from anyone, as it always was
      await bootBehindProxy();
      expect(await secureCookie(FORWARDED_HTTPS)).toBe(true);
      expect(await secureCookie()).toBe(false);
      await closeApp(app);

      // the test's own address (loopback) is not a trusted proxy here
      await bootBehindProxy('10.0.0.0/8');
      expect(await secureCookie(FORWARDED_HTTPS)).toBe(false);
      await closeApp(app);

      await bootBehindProxy('loopback');
      expect(await secureCookie(FORWARDED_HTTPS)).toBe(true);
      expect(await secureCookie()).toBe(false);
    });
  });
}

describe('CSRF protection (Node http server)', () => suite('node'));
describeEngine('CSRF protection (native engine)', () => suite('moro'));

describe('createCSRFMiddleware', () => {
  const makeRes = () => {
    const res: any = {
      statusCode: 200,
      headersSent: false,
      body: undefined,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        res.headersSent = true;
        return res;
      },
    };
    return res;
  };

  // A request served by a serverless adapter has no socket: its response
  // knows whether the platform reported https
  it('issues a token for a request that has no socket, Secure when the platform reports https', async () => {
    for (const https of [true, false]) {
      const mw = createCSRFMiddleware({ secret: 'csrf-test-secret' });
      const cookies: Array<{ name: string; options: Record<string, unknown> }> = [];
      const res = makeRes();
      res.cookie = (name: string, _value: string, options: Record<string, unknown>) => {
        cookies.push({ name, options });
        return res;
      };
      res._overTls = () => https;
      const req: any = { method: 'GET', headers: {}, cookies: {} };

      await mw(req, res, async () => {});
      expect(await req.csrfToken()).toEqual(expect.any(String));
      expect(cookies).toEqual([
        { name: '_csrf', options: expect.objectContaining({ httpOnly: true, secure: https }) },
      ]);
    }
  });

  it('answers 403 and does not call next when the token is missing', async () => {
    const mw = createCSRFMiddleware({ secret: 'csrf-test-secret' });
    const res = makeRes();
    const next = jest.fn(async () => {});

    await mw({ method: 'POST', headers: {}, cookies: {} } as any, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: 'Invalid CSRF token',
      code: 'CSRF_TOKEN_MISMATCH',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when the token matches the cookie', async () => {
    const mw = createCSRFMiddleware({ secret: 'csrf-test-secret' });
    const token = new CSRFCore({ secret: 'csrf-test-secret' }).generateToken();
    const res = makeRes();
    const next = jest.fn(async () => {});

    await mw(
      { method: 'POST', headers: { 'x-csrf-token': token }, cookies: { _csrf: token } } as any,
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('answers 403 for a matching pair that this secret did not sign', async () => {
    const mw = createCSRFMiddleware({ secret: 'csrf-test-secret', legacyTokens: false });
    const next = jest.fn(async () => {});

    for (const token of [
      new CSRFCore({ secret: 'another-secret' }).generateToken(),
      LEGACY_TOKEN,
      'anything',
    ]) {
      const res = makeRes();
      await mw(
        { method: 'POST', headers: { 'x-csrf-token': token }, cookies: { _csrf: token } } as any,
        res,
        next
      );
      expect(res.statusCode).toBe(403);
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('reads the token from the body, and from the query only when allowed', async () => {
    const token = new CSRFCore({ secret: 'csrf-test-secret' }).generateToken();
    const run = async (options: Record<string, unknown>, request: Record<string, unknown>) => {
      const res = makeRes();
      const next = jest.fn(async () => {});
      await createCSRFMiddleware({ secret: 'csrf-test-secret', ...options })(
        { method: 'POST', headers: {}, cookies: { _csrf: token }, ...request } as any,
        res,
        next
      );
      return next.mock.calls.length === 1;
    };

    expect(await run({}, { body: { _csrf: token } })).toBe(true);
    expect(await run({}, { query: { _csrf: token } })).toBe(false);
    expect(await run({ allowQueryToken: true }, { query: { _csrf: token } })).toBe(true);
  });
});
