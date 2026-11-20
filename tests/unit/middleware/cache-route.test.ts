// Route-level .cache() - CacheCore, the store behind it.
//
// A function `key` is called with the request and its result is the entry's
// key; under the default key each signed-in user has entries of their own
// unless the route is marked shared; a stored response is replayed with the
// status it was sent with, and error statuses are not stored; the store holds
// at most maxEntries and drops expired entries as it goes.
import { describe, it, expect } from '@jest/globals';
import {
  CacheCore,
  createCacheMiddleware,
  sharedCacheCore,
  type CacheConfig,
} from '../../../src/core/middleware/built-in/cache/index.js';
import {
  UnifiedRouter,
  configureRouteCache,
  tryRouteCache,
} from '../../../src/core/routing/unified-router.js';

class FakeResponse {
  statusCode = 200;
  headersSent = false;
  headers: Record<string, any> = {};
  body: any;

  setHeader(name: string, value: any): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): any {
    return this.headers[name.toLowerCase()];
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(data: any): void {
    this.body = data;
    this.headersSent = true;
  }
}

function request(path: string, extra: Record<string, any> = {}) {
  return { method: 'GET', path, query: {}, params: {}, headers: {}, ...extra } as any;
}

/**
 * One request through the cache phase and a handler: `handler` supplies the
 * response when the cache did not answer.
 */
async function exchange(
  core: CacheCore,
  config: CacheConfig,
  req: any,
  handler: (res: FakeResponse) => void
) {
  const res = new FakeResponse();
  const hit = await core.tryGet(req, res as any, config);
  if (!hit) handler(res);
  return { res, hit };
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('route .cache() - CacheCore', () => {
  describe('key', () => {
    it('calls a function key with the request', async () => {
      const core = new CacheCore();
      const config: CacheConfig = { ttl: 60, key: req => `profile:${req.params.id}` };
      const profile = (id: string) => request(`/users/${id}`, { params: { id } });

      await exchange(core, config, profile('1'), res => res.json({ user: 'alice' }));

      const other = await exchange(core, config, profile('2'), res => res.json({ user: 'bob' }));
      expect(other.hit).toBe(false);
      expect(other.res.body).toEqual({ user: 'bob' });

      const again = await exchange(core, config, profile('1'), () => undefined);
      expect(again.hit).toBe(true);
      expect(again.res.body).toEqual({ user: 'alice' });
      expect(core.get('profile:1')).toEqual({ user: 'alice' });
      expect(core.get('profile:2')).toEqual({ user: 'bob' });
    });

    it('takes a string key as given', async () => {
      const core = new CacheCore();
      const config: CacheConfig = { ttl: 60, key: 'report' };

      await exchange(core, config, request('/report'), res => res.json({ total: 1 }));
      const again = await exchange(core, config, request('/report?x=1'), () => undefined);
      expect(again.hit).toBe(true);
      expect(core.get('report')).toEqual({ total: 1 });
    });

    it('does not cache when the key function throws or returns nothing usable', async () => {
      const core = new CacheCore();
      const broken: CacheConfig = {
        ttl: 60,
        key: () => {
          throw new Error('no key');
        },
      };
      const empty: CacheConfig = { ttl: 60, key: (() => undefined) as any };

      for (const config of [broken, empty]) {
        const first = await exchange(core, config, request('/x'), res => res.json({ n: 1 }));
        const second = await exchange(core, config, request('/x'), res => res.json({ n: 2 }));
        expect(first.hit).toBe(false);
        expect(second.hit).toBe(false);
        expect(second.res.body).toEqual({ n: 2 });
      }
      expect(core.size).toBe(0);
    });
  });

  describe('signed-in users', () => {
    const config: CacheConfig = { ttl: 60 };
    const as = (user: unknown) => request('/me', { user });

    it('gives each user id an entry of its own under the default key', async () => {
      const core = new CacheCore();

      await exchange(core, config, as({ id: 'alice' }), res => res.json({ secret: 'of alice' }));

      const bob = await exchange(core, config, as({ id: 'bob' }), res =>
        res.json({ secret: 'of bob' })
      );
      expect(bob.hit).toBe(false);
      expect(bob.res.body).toEqual({ secret: 'of bob' });

      const anonymous = await exchange(core, config, request('/me'), res =>
        res.json({ secret: null })
      );
      expect(anonymous.hit).toBe(false);
      expect(anonymous.res.body).toEqual({ secret: null });

      const alice = await exchange(core, config, as({ id: 'alice' }), () => undefined);
      expect(alice.hit).toBe(true);
      expect(alice.res.body).toEqual({ secret: 'of alice' });
    });

    it('reads the user from req.auth.user as well', async () => {
      const core = new CacheCore();
      const viaAuth = (id: number) => request('/me', { auth: { user: { id } } });

      await exchange(core, config, viaAuth(1), res => res.json({ id: 1 }));
      const two = await exchange(core, config, viaAuth(2), res => res.json({ id: 2 }));
      expect(two.hit).toBe(false);
      const one = await exchange(core, config, viaAuth(1), () => undefined);
      expect(one.hit).toBe(true);
      expect(one.res.body).toEqual({ id: 1 });
    });

    it('keeps the ids 1 and "1" apart', async () => {
      const core = new CacheCore();
      await exchange(core, config, as({ id: 1 }), res => res.json({ who: 'number' }));
      const text = await exchange(core, config, as({ id: '1' }), res => res.json({ who: 'text' }));
      expect(text.hit).toBe(false);
    });

    it.each([[{ name: 'no id' }], [{ id: '' }], [{ id: null }], [{ id: {} }], ['alice']])(
      'does not cache for a user without a usable id: %j',
      async user => {
        const core = new CacheCore();
        const first = await exchange(core, config, as(user), res => res.json({ n: 1 }));
        expect(first.res.getHeader('x-cache')).toBeUndefined();
        const second = await exchange(core, config, as(user), res => res.json({ n: 2 }));
        expect(second.hit).toBe(false);
        expect(second.res.body).toEqual({ n: 2 });
        expect(core.size).toBe(0);
      }
    );

    it('shares one entry among signed-in users with shared: true', async () => {
      const core = new CacheCore();
      const shared: CacheConfig = { ttl: 60, shared: true };

      await exchange(core, shared, as({ id: 'alice' }), res => res.json({ menu: ['a', 'b'] }));
      const bob = await exchange(core, shared, as({ id: 'bob' }), () => undefined);
      expect(bob.hit).toBe(true);
      expect(bob.res.body).toEqual({ menu: ['a', 'b'] });
      const noId = await exchange(core, shared, as({ name: 'no id' }), () => undefined);
      expect(noId.hit).toBe(true);
    });

    it('uses a developer-supplied key as given, user or not', async () => {
      const core = new CacheCore();
      const keyed: CacheConfig = { ttl: 60, key: 'catalogue' };

      await exchange(core, keyed, as({ id: 'alice' }), res => res.json({ items: 3 }));
      const bob = await exchange(core, keyed, as({ id: 'bob' }), () => undefined);
      expect(bob.hit).toBe(true);
    });

    it('keys anonymous requests by method, path and query', async () => {
      const core = new CacheCore();
      await exchange(core, config, request('/list', { query: { page: '2' } }), res =>
        res.json({ page: 2 })
      );
      expect(core.get('GET:/list:{"page":"2"}')).toEqual({ page: 2 });
    });
  });

  describe('status', () => {
    const config: CacheConfig = { ttl: 60 };

    it('replays a stored response with the status it was sent with', async () => {
      const core = new CacheCore();
      await exchange(core, config, request('/item/2'), res =>
        res.status(404).json({ error: 'not found' })
      );

      const replay = await exchange(core, config, request('/item/2'), () => undefined);
      expect(replay.hit).toBe(true);
      expect(replay.res.statusCode).toBe(404);
      expect(replay.res.body).toEqual({ error: 'not found' });
      expect(core.getEntry('GET:/item/2:{}')).toMatchObject({ status: 404 });
    });

    it.each([401, 403, 407, 429, 500, 502])('does not store a %i', async status => {
      const core = new CacheCore();
      await exchange(core, config, request('/flaky'), res =>
        res.status(status).json({ error: status })
      );
      expect(core.size).toBe(0);

      const next = await exchange(core, config, request('/flaky'), res => res.json({ ok: true }));
      expect(next.hit).toBe(false);
      expect(next.res.statusCode).toBe(200);
      expect(next.res.body).toEqual({ ok: true });
    });
  });

  describe('store bounds', () => {
    it('holds at most maxEntries, dropping the least recently used', () => {
      const core = new CacheCore({ maxEntries: 3 });
      core.set('a', 1, 60);
      core.set('b', 2, 60);
      core.set('c', 3, 60);
      expect(core.get('a')).toBe(1); // a is now the most recently used
      core.set('d', 4, 60);

      expect(core.size).toBe(3);
      expect(core.get('b')).toBeUndefined();
      expect(core.get('a')).toBe(1);
      expect(core.get('d')).toBe(4);
    });

    it('defaults to 5,000 entries', () => {
      const core = new CacheCore();
      for (let i = 0; i < 6000; i++) core.set(`k${i}`, i, 60);
      expect(core.size).toBe(5000);
      expect(core.get('k5999')).toBe(5999);
      expect(core.get('k0')).toBeUndefined();
    });

    it('removes expired entries as new ones are added, without a timer', async () => {
      const core = new CacheCore();
      for (let i = 0; i < 300; i++) core.set(`short${i}`, i, 0.01);
      expect(core.size).toBe(300);
      await delay(30);

      // Nothing reads the expired keys again; adding other entries is what
      // clears them out
      for (let i = 0; i < 700; i++) core.set(`long${i}`, i, 60);
      expect(core.size).toBe(700);
      expect(core.get('long0')).toBe(0);
    });

    it('sweep() drops what has expired and keeps the rest', async () => {
      const core = new CacheCore();
      core.set('gone', 1, 0.01);
      core.set('kept', 2, 60);
      await delay(30);
      core.sweep();
      expect(core.size).toBe(1);
      expect(core.get('kept')).toBe(2);
    });
  });

  describe('default lifetime and reconfiguring', () => {
    it('gives an entry stored without a ttl the defaultTtl', async () => {
      const core = new CacheCore({ defaultTtl: 0.02 });
      const untimed: CacheConfig = { key: 'untimed' };
      const timed: CacheConfig = { ttl: 60, key: 'timed' };

      await exchange(core, untimed, request('/u'), res => res.json({ n: 1 }));
      await exchange(core, timed, request('/t'), res => res.json({ n: 2 }));
      expect((await exchange(core, untimed, request('/u'), () => undefined)).hit).toBe(true);
      await delay(40);

      const later = await exchange(core, untimed, request('/u'), res => res.json({ n: 3 }));
      expect(later.hit).toBe(false);
      expect(later.res.body).toEqual({ n: 3 });
      // A ttl of the entry's own is not replaced by the default
      expect((await exchange(core, timed, request('/t'), () => undefined)).hit).toBe(true);
    });

    it('configure() applies a new cap to what is held and to what follows', () => {
      const core = new CacheCore();
      for (let i = 0; i < 10; i++) core.set(`k${i}`, i, 60);

      core.configure({ maxEntries: 4 });
      expect(core.size).toBe(4);
      expect(core.get('k9')).toBe(9);
      expect(core.get('k5')).toBeUndefined();
      core.set('more', 1, 60);
      expect(core.size).toBe(4);

      // Called with nothing it is the default cap again
      core.configure();
      for (let i = 0; i < 10; i++) core.set(`again${i}`, i, 60);
      expect(core.size).toBe(14);
    });

    it('configureRouteCache() sizes the route store until the router is reset', async () => {
      const config = (key: string): CacheConfig => ({ ttl: 60, key });
      const store = async (key: string) => {
        const res = new FakeResponse();
        if (!(await tryRouteCache(request('/r'), res as any, config(key)))) res.json({ key });
      };
      const held = async (key: string) => {
        const res = new FakeResponse();
        return tryRouteCache(request('/r'), res as any, config(key));
      };

      configureRouteCache({ maxEntries: 1 });
      await store('route-store:a');
      await store('route-store:b');
      expect(await held('route-store:a')).toBe(false);
      expect(await held('route-store:b')).toBe(true);

      // The next app in the process does not inherit the cap
      UnifiedRouter.reset();
      await store('route-store:c');
      await store('route-store:d');
      expect(await held('route-store:c')).toBe(true);
      expect(await held('route-store:d')).toBe(true);
    });
  });

  describe('createCacheMiddleware', () => {
    it('applies the same key and status rules', async () => {
      sharedCacheCore.clear();
      const mw = createCacheMiddleware({ ttl: 60, key: req => `mw:${req.params.id}` });
      const run = async (id: string, handler: (res: FakeResponse) => void) => {
        const res = new FakeResponse();
        let nextCalled = false;
        await (mw as any)(request(`/t/${id}`, { params: { id } }), res, () => {
          nextCalled = true;
        });
        if (nextCalled) handler(res);
        return { res, nextCalled };
      };

      await run('1', res => res.status(404).json({ error: 'none' }));
      const other = await run('2', res => res.json({ id: 2 }));
      expect(other.nextCalled).toBe(true);
      expect(other.res.body).toEqual({ id: 2 });

      const replay = await run('1', () => undefined);
      expect(replay.nextCalled).toBe(false);
      expect(replay.res.statusCode).toBe(404);
      expect(replay.res.body).toEqual({ error: 'none' });
      sharedCacheCore.clear();
    });
  });
});

describe('route cache: Authorization header without a user object', () => {
  it('is not cached unless the route is shared or supplies a key', () => {
    const core = new CacheCore();
    const req = (extra: Record<string, unknown> = {}) =>
      ({
        method: 'GET',
        path: '/me',
        query: {},
        headers: { authorization: 'Bearer token-a' },
        ...extra,
      }) as any;

    expect(core.keyFor(req(), { ttl: 60 })).toBeNull();
    expect(core.keyFor(req(), { ttl: 60, shared: true })).toBe('GET:/me:{}');
    expect(core.keyFor(req(), { ttl: 60, key: 'fixed' })).toBe('fixed');
    // With a user object the request is keyed per user as before.
    expect(core.keyFor(req({ user: { id: 7 } }), { ttl: 60 })).toBe('user:7:GET:/me:{}');
    // No credentials at all: the shared anonymous key.
    expect(
      core.keyFor({ method: 'GET', path: '/me', query: {}, headers: {} } as any, { ttl: 60 })
    ).toBe('GET:/me:{}');
  });

  it('keys an entry on the host it was asked under, except for a shared route', () => {
    const core = new CacheCore();
    const req = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
      ({ method: 'GET', path: '/home', query: {}, headers, ...extra }) as any;

    expect(core.keyFor(req({ host: 'Tenant-A.example' }), { ttl: 60 })).toBe(
      'GET:tenant-a.example/home:{}'
    );
    expect(core.keyFor(req({ host: 'tenant-b.example' }), { ttl: 60 })).toBe(
      'GET:tenant-b.example/home:{}'
    );
    // A forwarded host a handler may build links from is part of the key too
    expect(
      core.keyFor(req({ host: 'site.example', 'x-forwarded-host': 'Other.example' }), { ttl: 60 })
    ).toBe('GET:site.example,other.example/home:{}');
    // A signed-in user's entry is that user's on that host
    expect(core.keyFor(req({ host: 'tenant-a.example' }, { user: { id: 7 } }), { ttl: 60 })).toBe(
      'user:7:GET:tenant-a.example/home:{}'
    );

    // shared: one entry for every caller, under every host name
    expect(core.keyFor(req({ host: 'tenant-a.example' }), { ttl: 60, shared: true })).toBe(
      'GET:/home:{}'
    );
    // and it reads nothing from the request headers
    const unread = {
      method: 'GET',
      path: '/home',
      query: {},
      get headers(): never {
        throw new Error('headers were read');
      },
    } as any;
    expect(core.keyFor(unread, { ttl: 60, shared: true })).toBe('GET:/home:{}');
    expect(core.keyFor(unread, { ttl: 60, key: 'fixed' })).toBe('fixed');
  });

  // The native engine fetches a request's headers the first time they are
  // read. A signed-in user's key takes the host from them when they are at
  // hand, and does not fetch them for it.
  it('does not fetch request headers for the host of a signed-in user', () => {
    const core = new CacheCore();
    let fetched = 0;
    const engineRequest = (read: Record<string, string> | undefined) =>
      ({
        method: 'GET',
        path: '/me',
        query: {},
        user: { id: 7 },
        _headersIfRead: read,
        get headers() {
          fetched++;
          return { host: 'tenant-a.example' };
        },
      }) as any;

    expect(core.keyFor(engineRequest({ host: 'tenant-a.example' }), { ttl: 60 })).toBe(
      'user:7:GET:tenant-a.example/me:{}'
    );
    expect(core.keyFor(engineRequest(undefined), { ttl: 60 })).toBe('user:7:GET:/me:{}');
    expect(fetched).toBe(0);
  });
});
