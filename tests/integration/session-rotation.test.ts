// Integration - session id rotation and what `req.session` exposes.
//
//  - `await req.session.regenerate()` sends the browser the new id (same cookie
//    options as the first cookie) and the old id stops working: the login step
//    that defeats session fixation.
//  - `req.session.destroy()` clears the cookie.
//  - serialising `req.session` does not include the signing secret or the
//    store options, and a write to `store` / `options` is ignored.
//
// Runs on the Node http server and on the native engine.
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp, middleware } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { closeApp, createTestPort, waitFor } from '../setup.js';
import { describeEngine } from './engine-test-utils.js';
import { fixture, httpsRequest } from '../utils/tls-client.js';

const SECRET = 'SESSION-SIGNING-SECRET';
const STORE_PASSWORD = 'STORE-PASSWORD';

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** Every Set-Cookie header of a response. */
const setCookies = (res: FetchResponse): string[] => res.headers.getSetCookie();
/** `name=value` of the session cookie in a response, if it set one. */
function sessionCookie(res: FetchResponse): string | undefined {
  const all = setCookies(res).filter(c => c.startsWith('connect.sid='));
  return all[all.length - 1]?.split(';')[0];
}
/** Attributes of a Set-Cookie header, without its `name=value` part. */
const attributes = (header: string) =>
  header
    .split(';')
    .slice(1)
    .map(part => part.trim())
    .sort();

function suite(engine: 'node' | 'moro') {
  let app: any;
  let base = '';

  afterEach(async () => {
    resetConfig();
    if (app) {
      await closeApp(app);
      app = null;
    }
  });

  const boot = async () => {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    await app.use(
      middleware.session({
        secret: SECRET,
        store: 'memory',
        storeOptions: { password: STORE_PASSWORD },
      })
    );

    app.post('/cart', (req: any) => {
      req.session.cart = ['x'];
      return { ok: true };
    });
    app.post('/login', async (req: any) => {
      const before = req.session.sessionID;
      const id = await req.session.regenerate();
      req.session.userId = 'victim';
      return { before, after: req.session.sessionID, returned: id };
    });
    app.post('/login-without-rotation', (req: any) => {
      req.session.userId = 'victim';
      return { ok: true };
    });
    app.get('/me', (req: any) => ({
      userId: req.session.userId ?? null,
      cart: req.session.cart ?? null,
    }));
    app.post('/logout', async (req: any) => {
      await req.session.destroy();
      return { ok: true };
    });
    // The documented logout: destroy() not awaited
    app.post('/logout-sync', (req: any) => {
      req.session.destroy();
      return { ok: true };
    });
    app.get('/dump', (req: any, res: any) => {
      req.session.views = (req.session.views || 0) + 1;
      res.json(req.session);
    });
    app.post('/prefs', (req: any) => {
      // An application copying request keys onto the session
      for (const [key, value] of Object.entries(req.body)) req.session[key] = value;
      return { keys: Object.keys(req.session), theme: req.session.theme };
    });

    const port = createTestPort();
    await listen(app, port);
    base = `http://127.0.0.1:${port}`;
  };

  const call = (path: string, cookie?: string, body?: unknown) =>
    fetch(base + path, {
      method: body !== undefined || (path !== '/me' && path !== '/dump') ? 'POST' : 'GET',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const me = async (cookie?: string) => (await (await call('/me', cookie)).json()) as any;

  /** A pre-login session that holds data, and its cookie. */
  const preLogin = async () => {
    const first = await call('/cart');
    const cookie = sessionCookie(first) as string;
    expect(cookie).toBeTruthy();
    await waitFor(async () => (await me(cookie)).cart !== null, {
      description: 'the pre-login session to be saved',
    });
    return { cookie, header: setCookies(first).find(c => c.startsWith('connect.sid=')) as string };
  };

  it('regenerate() sends the new id with the original cookie options and invalidates the old id', async () => {
    await boot();
    const planted = await preLogin();

    const login = await call('/login', planted.cookie);
    const ids = (await login.json()) as any;
    expect(ids.after).not.toBe(ids.before);
    expect(ids.returned).toBe(ids.after);

    const issued = setCookies(login).filter(c => c.startsWith('connect.sid='));
    expect(issued).toHaveLength(1);
    const rotated = sessionCookie(login) as string;
    expect(rotated).not.toBe(planted.cookie);
    // signed like the first cookie, and carrying the new id
    expect(decodeURIComponent(rotated)).toContain(`s:${ids.after}.`);
    expect(attributes(issued[0] as string)).toEqual(attributes(planted.header));
    expect(attributes(issued[0] as string)).toEqual(
      expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=lax'])
    );

    // The browser that logged in is logged in on its next request...
    await waitFor(async () => (await me(rotated)).userId === 'victim', {
      description: 'the rotated session to be saved',
    });
    // ...with a fresh session (regenerate starts empty)
    expect((await me(rotated)).cart).toBeNull();
    // ...and whoever planted the old id gets nothing from it
    expect(await me(planted.cookie)).toEqual({ userId: null, cart: null });
  });

  it('without regenerate() the planted id keeps working (what rotation prevents)', async () => {
    await boot();
    const planted = await preLogin();
    const login = await call('/login-without-rotation', planted.cookie);
    expect(sessionCookie(login)).toBeUndefined();
    await waitFor(async () => (await me(planted.cookie)).userId === 'victim', {
      description: 'the login to be saved',
    });
  });

  it('destroy() clears the cookie, awaited or not', async () => {
    await boot();
    for (const route of ['/logout', '/logout-sync']) {
      const session = await preLogin();
      const logout = await call(route, session.cookie);
      const cleared = setCookies(logout).filter(c => c.startsWith('connect.sid='));
      expect(cleared).toHaveLength(1);
      const header = cleared[0] as string;
      expect(header.startsWith('connect.sid=;')).toBe(true);
      expect(header).toContain('Max-Age=0');
      expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      expect(attributes(header)).toEqual(
        expect.arrayContaining(['HttpOnly', 'Path=/', 'SameSite=lax'])
      );
      await waitFor(async () => (await me(session.cookie)).cart === null, {
        description: 'the destroyed session to be gone',
      });
    }
  });

  it('serialising req.session leaves out the secret and the store options', async () => {
    await boot();
    const res = await call('/dump');
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(STORE_PASSWORD);
    const body = JSON.parse(text);
    expect(Object.keys(body)).toEqual(['data', 'id', 'isNew', 'isModified']);
    expect(body.data).toEqual({ views: 1 });
    expect(typeof body.id).toBe('string');
  });

  it('ignores writes to req.session.store / .options and keeps the session working', async () => {
    await boot();
    const first = await call('/prefs', undefined, {
      options: { secret: 'attacker-secret', name: 'evil' },
      store: 'not-a-store',
      theme: 'dark',
    });
    const body = (await first.json()) as any;
    expect(body.theme).toBe('dark');
    expect(body.keys).toEqual(['data', 'id', 'isNew', 'isModified']);
    const cookie = sessionCookie(first) as string;

    // Still saved through the real store and still verified with the real secret
    await waitFor(
      async () => {
        const dump = (await (await call('/dump', cookie)).json()) as any;
        return dump.data.theme === 'dark';
      },
      { description: 'the session to be saved under its signed id' }
    );
    const dump = (await (await call('/dump', cookie)).json()) as any;
    expect(dump.data.options).toBeUndefined();
    expect(dump.data.store).toBeUndefined();
  });

  describe('session({ proxy: true }) and X-Forwarded-Proto', () => {
    const bootBehindProxy = async (trustProxy?: unknown) => {
      resetConfig();
      app = await createApp({
        logger: { level: 'fatal' },
        server: { engine, ...(trustProxy === undefined ? {} : { trustProxy }) },
      } as any);
      await app.use(middleware.session({ secret: SECRET, proxy: true }));
      app.get('/visit', (req: any) => ({ id: req.session.sessionID }));
      const port = createTestPort();
      await listen(app, port);
      base = `http://127.0.0.1:${port}`;
    };
    /** Whether the session cookie of a new visitor is marked Secure */
    const secureCookie = async (headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}/visit`, { headers });
      const cookie = setCookies(res).find(c => c.startsWith('connect.sid=')) as string;
      return attributes(cookie).includes('Secure');
    };
    const FORWARDED_HTTPS = { 'x-forwarded-proto': 'https' };

    it('marks the cookie Secure for the header, but only from a trusted proxy once server.trustProxy is set', async () => {
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

  describe('Secure on the session cookie without session({ proxy })', () => {
    let port = 0;
    const bootWith = async (
      server: Record<string, unknown>,
      cookie?: Record<string, unknown>
    ): Promise<void> => {
      resetConfig();
      app = await createApp({ logger: { level: 'fatal' }, server: { engine, ...server } } as any);
      await app.use(middleware.session({ secret: SECRET, ...(cookie ? { cookie } : {}) }));
      app.get('/visit', (req: any) => ({ id: req.session.sessionID }));
      port = createTestPort();
      await listen(app, port);
    };
    const TLS = { ssl: { key: fixture('localhost.key'), cert: fixture('localhost.pem') } };
    const isSecure = (header: string | undefined) =>
      attributes(header as string).includes('Secure');
    const overTls = async () =>
      isSecure(
        [(await httpsRequest(port, '/visit')).headers['set-cookie']]
          .flat()
          .find(c => c?.startsWith('connect.sid='))
      );
    const overHttp = async (headers: Record<string, string> = {}) =>
      isSecure(
        setCookies(await fetch(`http://127.0.0.1:${port}/visit`, { headers })).find(c =>
          c.startsWith('connect.sid=')
        )
      );

    it('follows the connection when cookie.secure is not given', async () => {
      await bootWith(TLS);
      expect(await overTls()).toBe(true);
      await closeApp(app);

      // An explicit false is kept
      await bootWith(TLS, { secure: false });
      expect(await overTls()).toBe(false);
      await closeApp(app);

      // Plain http, also behind a proxy nobody named
      await bootWith({});
      expect(await overHttp()).toBe(false);
      expect(await overHttp({ 'x-forwarded-proto': 'https' })).toBe(false);
      await closeApp(app);

      // https as a proxy named in server.trustProxy reports it
      await bootWith({ trustProxy: 'loopback' });
      expect(await overHttp({ 'x-forwarded-proto': 'https' })).toBe(true);
      expect(await overHttp()).toBe(false);
    });
  });
}

describe('Session rotation and serialisation (Node http server)', () => suite('node'));
describeEngine('Session rotation and serialisation (native engine)', () => suite('moro'));
