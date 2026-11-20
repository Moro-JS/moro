// Unit tests - Session / SessionCore: id rotation reaches the response, the
// session object neither exposes nor lets a write replace its internals, the
// session cookie keeps its defaults when some options are given, and a store
// that cannot be read does not cost the browser its session id.
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const warn = jest.fn();
const debug = jest.fn();
const error = jest.fn();
jest.mock('../../../src/core/logger/index.js', () => ({
  createFrameworkLogger: () => ({
    debug,
    info: jest.fn(),
    warn,
    error,
  }),
}));

import { Session, SessionCore } from '../../../src/core/middleware/built-in/session/index.js';
import { sessionHelpers } from '../../../src/core/middleware/built-in/auth/helpers.js';
import { MemoryCacheAdapter } from '../../../src/core/middleware/built-in/cache/adapters/cache/memory.js';
import { RedisCacheAdapter } from '../../../src/core/middleware/built-in/cache/adapters/cache/redis.js';
import {
  signCookieValue,
  unsignCookieValue,
} from '../../../src/core/middleware/built-in/cookie/index.js';

const SECRET = 'unit-signing-secret';

interface CookieCall {
  name: string;
  value: string;
  options: Record<string, any>;
}

function makeRes() {
  const cookies: CookieCall[] = [];
  const res: any = {
    headersSent: false,
    cookies,
    cookie(name: string, value: string, options: Record<string, any> = {}) {
      cookies.push({ name, value, options });
      return res;
    },
  };
  return res as { headersSent: boolean; cookies: CookieCall[] };
}

const makeReq = (headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  ({ headers, cookies }) as any;

beforeEach(() => {
  warn.mockClear();
  debug.mockClear();
  error.mockClear();
});

describe('Session.regenerate()', () => {
  it('queues a cookie for the new id with the options of the first cookie and drops the old id', async () => {
    const core = new SessionCore({ secret: SECRET });
    const store = core.getStore();
    const req = makeReq();
    const res = makeRes();

    const session: any = await core.attachSession(req, res as any);
    const firstId: string = session.sessionID;
    session.cart = ['x'];
    await core.saveSession(session);
    expect(await store.get(firstId)).toEqual({ cart: ['x'] });
    expect(res.cookies).toHaveLength(1);

    const newId = await session.regenerate();
    expect(newId).not.toBe(firstId);
    expect(session.sessionID).toBe(newId);
    expect(session.cart).toBeUndefined();
    expect(await store.get(firstId)).toBeNull();

    expect(res.cookies).toHaveLength(2);
    const [first, rotated] = res.cookies as [CookieCall, CookieCall];
    expect(rotated.name).toBe('connect.sid');
    expect(unsignCookieValue(rotated.value, SECRET)).toBe(newId);
    expect(rotated.options).toEqual(first.options);
    expect(rotated.options).toEqual({
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });

    // Data written after rotation is saved under the new id only
    session.userId = 'u1';
    await core.saveSession(session);
    expect(await store.get(newId)).toEqual({ userId: 'u1' });
    expect(await store.get(firstId)).toBeNull();
  });

  it('rotates an existing session loaded from its cookie (no cookie was set on attach)', async () => {
    const core = new SessionCore({ name: 'sid' });
    await core.getStore().set('known-id', { cart: [1] }, 60);
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, 'known-id');
    expect(res.cookies).toHaveLength(0);
    expect(session.cart).toEqual([1]);

    const newId = await session.regenerate();
    expect(res.cookies).toEqual([
      {
        name: 'sid',
        value: newId, // no secret: the id as-is
        options: { maxAge: 86400000, httpOnly: true, sameSite: 'lax', path: '/' },
      },
    ]);
    expect(await core.getStore().get('known-id')).toBeNull();
  });

  it('keeps Secure when it came from the proxy header, and uses a custom genid', async () => {
    let n = 0;
    const core = new SessionCore({ proxy: true, genid: () => `generated-${++n}` });
    const res = makeRes();
    const session: any = await core.attachSession(
      makeReq({ 'x-forwarded-proto': 'https' }),
      res as any
    );
    await session.regenerate();
    expect(res.cookies.map(c => c.value)).toEqual(['generated-1', 'generated-2']);
    expect(res.cookies.map(c => c.options.secure)).toEqual([true, true]);
  });

  it('queues the cookie before its first await', async () => {
    const core = new SessionCore({});
    const res = makeRes();
    const session: any = await core.createSession(makeReq(), res as any, 'fixed');
    const pending = session.regenerate();
    // not awaited yet: the cookie and the new, empty session are already in place
    expect(res.cookies).toHaveLength(2);
    expect(session.sessionID).toBe((res.cookies[1] as CookieCall).value);
    await pending;
  });

  it('does not touch a response whose headers were already sent', async () => {
    const core = new SessionCore({});
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any);
    res.headersSent = true;
    await expect(session.regenerate()).resolves.toEqual(expect.any(String));
    expect(res.cookies).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be updated: response headers already sent'),
      'SessionCookie'
    );
  });

  it('still works for a session created without a response', async () => {
    const store = new MemoryCacheAdapter();
    await store.set('a', { k: 1 }, 60);
    const session: any = Session.create('a', store, {}, { k: 1 });
    const id = await session.regenerate();
    expect(id).not.toBe('a');
    expect(await store.get('a')).toBeNull();
    await session.destroy();
  });
});

describe('Session.destroy()', () => {
  it('clears the cookie with the original options and removes the stored session', async () => {
    const core = new SessionCore({ secret: SECRET, cookie: { path: '/app', sameSite: 'strict' } });
    await core.getStore().set('known-id', { userId: 'u1' }, 60);
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, 'known-id');

    const pending = session.destroy();
    // synchronous part: an un-awaited destroy() still clears the cookie
    expect(res.cookies).toHaveLength(1);
    await pending;

    const cleared = res.cookies[0] as CookieCall;
    expect(cleared.name).toBe('connect.sid');
    expect(cleared.value).toBe('');
    expect(cleared.options).toEqual({
      path: '/app',
      sameSite: 'strict',
      httpOnly: true,
      maxAge: 0,
      expires: new Date(0),
    });
    expect(session.userId).toBeUndefined();
    expect(await core.getStore().get('known-id')).toBeNull();
  });
});

describe('req.session internals', () => {
  const options = {
    secret: SECRET,
    storeOptions: { password: 'STORE-PASSWORD', host: 'redis.internal' },
  };

  it('does not serialise the store or the options', async () => {
    const core = new SessionCore(options);
    const session: any = await core.attachSession(makeReq(), makeRes() as any);
    session.views = 1;

    const json = JSON.stringify(session);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('STORE-PASSWORD');
    expect(JSON.parse(json)).toEqual({
      data: { views: 1 },
      id: session.sessionID,
      isNew: true,
      isModified: true,
    });
    expect(Object.keys(session)).toEqual(['data', 'id', 'isNew', 'isModified']);
    expect({ ...session }).not.toHaveProperty('options');
    expect({ ...session }).not.toHaveProperty('store');
    expect(Object.getOwnPropertySymbols({ ...session })).toEqual([]);
  });

  it('ignores a write to store / options and logs a warning', async () => {
    const core = new SessionCore(options);
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any);

    session.options = { secret: 'attacker' };
    session.store = { set: () => undefined };
    Object.assign(session, { options: 1, store: 2, theme: 'dark' });

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored a write to req.session.options'),
      'SessionReservedField'
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored a write to req.session.store'),
      'SessionReservedField'
    );
    // not stored as session data either
    expect(session.data).toEqual({ theme: 'dark' });

    // the real secret and the real store are still in use
    const id = await session.regenerate();
    expect(unsignCookieValue((res.cookies[1] as CookieCall).value, SECRET)).toBe(id);
    await core.saveSession(session);
    expect(await core.getStore().get(id)).toEqual({});
  });

  it('leaves reading id, data and ordinary keys behaving as before', async () => {
    const core = new SessionCore({});
    const session: any = await core.attachSession(makeReq(), makeRes() as any);
    session.userId = 'u1';
    expect(session.userId).toBe('u1');
    expect('userId' in session).toBe(true);
    expect(session.data).toEqual({ userId: 'u1' });
    delete session.userId;
    expect(session.userId).toBeUndefined();
    expect(typeof session.save).toBe('function');
    expect(session.sessionID).toBe(session.id);
  });

  it('deletes a field that is not set without an error, and keeps its own members', async () => {
    const core = new SessionCore({});
    const session: any = await core.attachSession(makeReq(), makeRes() as any);
    await core.saveSession(session);
    const id: string = session.id;

    // This file is strict code, where a refused delete is a TypeError
    expect(() => {
      delete session.neverSet;
    }).not.toThrow();
    expect(Reflect.deleteProperty(session, 'neverSet')).toBe(true);
    // Nothing was removed, so there is nothing to save
    expect(session.isModified).toBe(false);

    for (const member of ['id', 'data', 'isNew', 'save', 'destroy', 'regenerate', 'store']) {
      expect(Reflect.deleteProperty(session, member)).toBe(false);
    }
    expect(session.id).toBe(id);
    expect(session.data).toEqual({});
    expect(typeof session.save).toBe('function');
  });

  it('sessionHelpers.removeSessionData() saves the removal on an established session', async () => {
    // A store that keeps what it was given as text, as one on Redis or on
    // disk does: nothing is saved unless the session writes it
    const kept = new Map<string, string>();
    const store: any = {
      get: async (key: string) => (kept.has(key) ? JSON.parse(kept.get(key) as string) : null),
      set: async (key: string, value: unknown) => void kept.set(key, JSON.stringify(value)),
      del: async (key: string) => void kept.delete(key),
      clear: async () => kept.clear(),
      exists: async (key: string) => kept.has(key),
      ttl: async () => -1,
    };
    const core = new SessionCore({ secret: SECRET, store });
    const first: any = await core.attachSession(makeReq(), makeRes() as any);
    first.cart = ['x'];
    first.theme = 'dark';
    await core.saveSession(first);
    const id: string = first.id;
    expect(await store.get(id)).toEqual({ cart: ['x'], theme: 'dark' });

    // A later request of the same browser: the session is loaded, not new
    const later: any = await core.attachSession(makeReq(), makeRes() as any, id);
    expect(later.isNew).toBe(false);
    expect(later.cart).toEqual(['x']);

    await sessionHelpers.removeSessionData({ session: later }, 'cart');
    expect(later.cart).toBeUndefined();
    expect(await store.get(id)).toEqual({ theme: 'dark' });

    // A key that is not there is left alone, and so is a member of the session
    await sessionHelpers.removeSessionData({ session: later }, 'absent');
    await sessionHelpers.removeSessionData({ session: later }, 'id');
    expect(later.id).toBe(id);
    expect(await store.get(id)).toEqual({ theme: 'dark' });
  });

  it('gives a handler no way from req.session to the secret or the store', async () => {
    const core = new SessionCore(options);
    const session: any = await core.attachSession(makeReq(), makeRes() as any);

    expect(session.options).toBeUndefined();
    expect(session.store).toBeUndefined();
    expect('options' in session).toBe(false);
    expect('store' in session).toBe(false);

    // nor by walking everything the object carries, hidden properties included
    const seen = new Set<unknown>();
    const reachable = (value: unknown): string => {
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return typeof value === 'string' ? value : '';
      }
      if (seen.has(value)) return '';
      seen.add(value);
      return Reflect.ownKeys(value as object)
        .map(key => {
          const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
          return descriptor && 'value' in descriptor ? reachable(descriptor.value) : '';
        })
        .join('\n');
    };
    const text = reachable(session);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('STORE-PASSWORD');
  });

  it('ignores a write to id and keeps the session under its own id', async () => {
    const core = new SessionCore({ secret: SECRET });
    const store = core.getStore();
    await store.set('victim-id', { user: 'victim' }, 60);
    const session: any = await core.attachSession(makeReq(), makeRes() as any);
    const ownId: string = session.sessionID;

    session.id = 'victim-id';
    Object.assign(session, { id: 'victim-id', cart: ['x'] });

    expect(session.id).toBe(ownId);
    expect(session.sessionID).toBe(ownId);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored a write to req.session.id'),
      'SessionReservedField'
    );
    await core.saveSession(session);
    expect(await store.get(ownId)).toEqual({ cart: ['x'] });
    expect(await store.get('victim-id')).toEqual({ user: 'victim' });
  });

  it('ignores a write to data: fields are set by name, not replaced wholesale', async () => {
    const core = new SessionCore({});
    const session: any = await core.attachSession(makeReq(), makeRes() as any);
    session.user = 'u1';

    session.data = { user: 'admin' };
    Object.assign(session, { data: { user: 'admin' }, theme: 'dark' });

    expect(session.user).toBe('u1');
    expect(session.data).toEqual({ user: 'u1', theme: 'dark' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored a write to req.session.data'),
      'SessionReservedField'
    );
  });

  it('ignores a write to its methods and bookkeeping, which keep working', async () => {
    const core = new SessionCore({});
    const store = core.getStore();
    const session: any = await core.attachSession(makeReq(), makeRes() as any);

    Object.assign(session, {
      save: 'x',
      destroy: 'x',
      regenerate: 'x',
      isNew: false,
      isModified: false,
      sessionID: 'x',
      userId: 'u1',
    });
    session.__proto__ = { role: 'admin' };

    expect(session.role).toBeUndefined();
    expect(session.isNew).toBe(true);
    expect(session.isModified).toBe(true);
    await core.saveSession(session);
    expect(await store.get(session.sessionID)).toEqual({ userId: 'u1' });
    await expect(session.regenerate()).resolves.toEqual(expect.any(String));
    await expect(session.destroy()).resolves.toBeUndefined();
  });
});

describe('session cookie options', () => {
  const cookieOf = async (options: Record<string, any>) => {
    const core = new SessionCore(options);
    const res = makeRes();
    await core.attachSession(makeReq(), res as any);
    return (res.cookies[0] as CookieCall).options;
  };
  const DEFAULTS = {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  };

  it.each([
    ['maxAge', { maxAge: 60_000 }],
    ['secure', { secure: true }],
    ['domain', { domain: 'example.com' }],
    ['path', { path: '/app' }],
    ['sameSite', { sameSite: 'strict' }],
  ])('keeps the other defaults when only %s is given', async (_name, cookie) => {
    expect(await cookieOf({ cookie })).toEqual({ ...DEFAULTS, ...cookie });
  });

  it('lets HttpOnly and SameSite be changed on purpose', async () => {
    expect(await cookieOf({ cookie: { httpOnly: false, sameSite: 'none', secure: true } })).toEqual(
      { ...DEFAULTS, httpOnly: false, sameSite: 'none', secure: true }
    );
  });

  // res.cookie() decides Secure for a cookie that names no `secure`: it is
  // Secure when the request arrived over TLS
  it('leaves Secure to the connection unless cookie.secure says otherwise', async () => {
    expect('secure' in (await cookieOf({}))).toBe(false);
    expect('secure' in (await cookieOf({ cookie: { secure: undefined } }))).toBe(false);
    expect((await cookieOf({ cookie: { secure: false } })).secure).toBe(false);
    expect((await cookieOf({ cookie: { secure: true } })).secure).toBe(true);
  });

  it('treats a key given as undefined as not given', async () => {
    expect(await cookieOf({ cookie: { httpOnly: undefined, maxAge: undefined } })).toEqual(
      DEFAULTS
    );
  });

  it('sends no Max-Age for maxAge: null and keeps the stored session for 24 hours', async () => {
    const core = new SessionCore({ cookie: { maxAge: null } });
    const set = jest.spyOn(core.getStore(), 'set');
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any);
    expect((res.cookies[0] as CookieCall).options).toEqual({ ...DEFAULTS, maxAge: null });

    session.views = 1;
    await core.saveSession(session);
    expect(set).toHaveBeenCalledWith(session.sessionID, { views: 1 }, 86400);
  });
});

describe('session secret rotation', () => {
  const NEW = 'new-signing-secret';
  const OLD = 'old-signing-secret';

  it('signs the id with the first secret', async () => {
    const core = new SessionCore({ secret: [NEW, OLD] });
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any);
    const value = (res.cookies[0] as CookieCall).value;

    expect(unsignCookieValue(value, NEW)).toBe(session.sessionID);
    expect(unsignCookieValue(value, OLD)).toBeNull();
  });

  it('accepts an id signed with any listed secret, and none signed with another', async () => {
    const core = new SessionCore({ secret: [NEW, OLD] });
    const idFrom = (secret: string) =>
      core.readSessionId(makeReq({}, { 'connect.sid': signCookieValue('the-id', secret) }));

    expect(idFrom(NEW)).toBe('the-id');
    expect(idFrom(OLD)).toBe('the-id');
    expect(idFrom('retired-secret')).toBeUndefined();
    // an unsigned id is still refused once any secret is configured
    expect(core.readSessionId(makeReq({}, { 'connect.sid': 'the-id' }))).toBeUndefined();
  });

  it('treats an empty list as no secret', async () => {
    const core = new SessionCore({ secret: [] });
    expect(core.readSessionId(makeReq({}, { 'connect.sid': 'the-id' }))).toBe('the-id');
  });
});

describe('a session store that cannot be read', () => {
  const ID = 'existing-session-id';
  const STORED = { user: { id: 'u1' }, cart: ['x'] };

  /** A store holding one session, with a switch that makes every read fail. */
  function outageStore() {
    const inner = new MemoryCacheAdapter();
    const state = { down: false, sets: [] as Array<[string, unknown]> };
    const store: any = {
      get: async (key: string) => {
        if (state.down) throw new Error('store unreachable');
        return inner.get(key);
      },
      set: async (key: string, value: unknown, ttl?: number) => {
        state.sets.push([key, value]);
        return inner.set(key, value, ttl);
      },
      del: (key: string) => inner.del(key),
      clear: () => inner.clear(),
      exists: (key: string) => inner.exists(key),
      ttl: (key: string) => inner.ttl(key),
    };
    return { store, state, inner };
  }

  it('keeps the session id, sets no cookie, and serves the request without session data', async () => {
    const { store, state, inner } = outageStore();
    await inner.set(ID, STORED, 60);
    const core = new SessionCore({ store });

    state.down = true;
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, ID);
    expect(session.sessionID).toBe(ID);
    expect(session.user).toBeUndefined();
    expect(res.cookies).toEqual([]);

    // The same browser, once the store is back, is still signed in
    state.down = false;
    const res2 = makeRes();
    const again: any = await core.attachSession(makeReq(), res2 as any, ID);
    expect(again.sessionID).toBe(ID);
    expect(again.user).toEqual({ id: 'u1' });
    expect(res2.cookies).toEqual([]);
  });

  it('does not write over the stored session with what the request was given', async () => {
    const { store, state, inner } = outageStore();
    await inner.set(ID, STORED, 60);
    const core = new SessionCore({ store, resave: true, rolling: true });

    state.down = true;
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, ID);
    // rolling re-sends the id the browser already has, never a new one
    expect(res.cookies.map(c => c.value)).toEqual([ID]);

    session.lastSeen = 123;
    state.down = false; // the store is back before the response is finished
    await session.touch();
    await core.saveSession(session);

    expect(state.sets).toEqual([]);
    expect(await inner.get(ID)).toEqual(STORED);
  });

  it('saves again after regenerate(), under the new id', async () => {
    const { store, state, inner } = outageStore();
    await inner.set(ID, STORED, 60);
    const core = new SessionCore({ store });

    state.down = true;
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, ID);
    state.down = false;
    const newId = await session.regenerate();
    session.user = { id: 'u2' };
    await core.saveSession(session);

    expect(newId).not.toBe(ID);
    expect(res.cookies.map(c => c.value)).toEqual([newId]);
    expect(await inner.get(newId)).toEqual({ user: { id: 'u2' } });
  });

  it('still starts a new session when the store answers that there is none', async () => {
    const { store } = outageStore();
    const core = new SessionCore({ store });

    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, ID);
    expect(session.sessionID).not.toBe(ID);
    expect(res.cookies.map(c => c.value)).toEqual([session.sessionID]);
  });

  it('recognises a failed read of the built-in Redis store, which answers get() with null', async () => {
    const values = new Map<string, string>([[`sess:${ID}`, JSON.stringify(STORED)]]);
    const client: any = {
      isOpen: true,
      down: false,
      on() {},
      async get(key: string) {
        if (client.down) throw new Error('ECONNRESET');
        return values.get(key) ?? null;
      },
      async set(key: string, value: string) {
        values.set(key, value);
        return 'OK';
      },
      async del(key: string) {
        values.delete(key);
        return 1;
      },
    };
    const store = new RedisCacheAdapter({ client, keyPrefix: 'sess:' });
    const core = new SessionCore({ store });

    client.down = true;
    expect(await store.get(ID)).toBeNull();
    const res = makeRes();
    const session: any = await core.attachSession(makeReq(), res as any, ID);
    expect(session.sessionID).toBe(ID);
    expect(res.cookies).toEqual([]);
    // The public loader keeps answering null for a failed load
    expect(await core.loadSession(ID)).toBeNull();

    client.down = false;
    const again: any = await core.attachSession(makeReq(), makeRes() as any, ID);
    expect(again.sessionID).toBe(ID);
    expect(again.cart).toEqual(['x']);
  });
});

describe('session ids in log lines', () => {
  /** Everything handed to the logger so far, at every level, as one text */
  const logged = () =>
    JSON.stringify([...debug.mock.calls, ...warn.mock.calls, ...error.mock.calls]);

  it('never writes a session id, at debug level included', async () => {
    const core = new SessionCore({ secret: SECRET });
    const res = makeRes();

    const session: any = await core.attachSession(makeReq(), res as any);
    const firstId: string = session.sessionID;
    session.cart = ['x'];
    await core.saveSession(session);
    await core.loadSession(firstId);
    const secondId: string = await session.regenerate();
    session.userId = 'u1';
    await core.saveSession(session);
    await session.destroy();

    // the lines are there, and say which session by a tag, not by its id
    const text = logged();
    expect(text).toContain('Session saved: #');
    expect(text).toContain('Session loaded: #');
    expect(text).toContain('Session regenerated: #');
    expect(text).not.toContain(firstId);
    expect(text).not.toContain(secondId);
  });

  it('never writes the id of a session whose store could not be read', async () => {
    const id = 'a-session-id-that-cannot-be-loaded';
    const store: any = {
      get: async () => {
        throw new Error('store is down');
      },
      set: async () => undefined,
      del: async () => undefined,
    };
    const core = new SessionCore({ store });
    const session: any = await core.attachSession(makeReq(), makeRes() as any, id);
    session.views = 1;
    await core.saveSession(session);

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Failed to load session: #[0-9a-f]{8}\(34\)$/),
      'SessionLoadError',
      expect.anything()
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Session #[0-9a-f]{8}\(34\) was not saved/),
      'SessionSave'
    );
    expect(logged()).not.toContain(id);
  });

  it('tells a built-in adapter it was handed as the store to keep its keys out of the log', () => {
    const memory = new MemoryCacheAdapter();
    const redis = new RedisCacheAdapter({ client: { isOpen: true }, keyPrefix: 'sess:' });
    expect([memory.redactKeys, redis.redactKeys]).toEqual([false, false]);

    new SessionCore({ store: memory });
    new SessionCore({ store: redis });
    expect([memory.redactKeys, redis.redactKeys]).toEqual([true, true]);
    // and the stores it creates itself
    expect((new SessionCore({}).getStore() as MemoryCacheAdapter).redactKeys).toBe(true);
  });
});
