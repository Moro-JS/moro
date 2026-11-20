// Global cache middleware (middleware.cache()) - what it stores, what it
// replays and to whom.
//
// A stored response is shared by every caller of the same URL, so the store
// only takes what is safe to share: Set-Cookie is never stored or replayed,
// requests that carry credentials (Authorization, a Cookie, a header the
// application names) bypass the store unless the strategy keys them itself,
// and errors and responses marked private or no-store are left out. What is
// stored is replayed with its status and body intact.
import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import type { CacheAdapter, CachedResponse } from '../../../src/types/cache.js';

// One shared logger double, so warnings logged when the middleware is created
// can be read back (the real loggers are module-level instances).
jest.mock('../../../src/core/logger/index.js', () => {
  const shared = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createFrameworkLogger: () => shared };
});

type CacheModule = typeof import('../../../src/core/middleware/built-in/cache/hook.js');
type MemoryModule =
  typeof import('../../../src/core/middleware/built-in/cache/adapters/cache/memory.js');

let cache: CacheModule['cache'];
let MemoryCacheAdapter: MemoryModule['MemoryCacheAdapter'];
let log: { warn: jest.Mock; error: jest.Mock; debug: jest.Mock; info: jest.Mock };

beforeAll(async () => {
  // tests/setup.ts has already loaded the framework - this middleware included
  // - against the real logger. Load it again, against the double above.
  jest.resetModules();
  ({ cache } = await import('../../../src/core/middleware/built-in/cache/hook.js'));
  ({ MemoryCacheAdapter } =
    await import('../../../src/core/middleware/built-in/cache/adapters/cache/memory.js'));
  const { createFrameworkLogger } = await import('../../../src/core/logger/index.js');
  log = createFrameworkLogger('test') as unknown as typeof log;
});

/** The warnings logged so far, as text */
const warnings = (): string[] => log.warn.mock.calls.map(call => String(call[0]));

/**
 * Response double. `nodeStyle` reproduces how the Node backend finishes a
 * response: json() and send() end up in end() with the serialized body, so
 * the middleware's wrappers see one response more than once.
 */
class FakeResponse {
  statusCode = 200;
  headersSent = false;
  headers: Record<string, any> = {};
  sentWith: 'json' | 'send' | 'end' | undefined;
  body: any;

  constructor(private nodeStyle = true) {}

  setHeader(name: string, value: any): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): any {
    return this.headers[name.toLowerCase()];
  }
  getHeaders(): Record<string, any> {
    return { ...this.headers };
  }
  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  json(data: any): void {
    this.sentWith = 'json';
    this.body = data;
    if (this.nodeStyle) {
      this.setHeader('Content-Type', 'application/json');
      // The method as it is on the instance now: a wrapper, when one is installed
      (this as any).end(JSON.stringify(data));
    }
    this.headersSent = true;
  }
  send(data: any): void {
    this.sentWith = 'send';
    this.body = data;
    if (this.nodeStyle) (this as any).end(data);
    this.headersSent = true;
  }
  end(data?: any): void {
    if (this.sentWith === undefined) {
      this.sentWith = 'end';
      this.body = data;
    }
    this.headersSent = true;
  }
}

function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return { method, path, query: {}, headers } as any;
}

/** A Map-backed adapter that shows what was stored */
function spyAdapter() {
  const store = new Map<string, CachedResponse>();
  const ttls = new Map<string, number | undefined>();
  const adapter: CacheAdapter = {
    get: async key => store.get(key) ?? null,
    set: async (key, value, ttl) => {
      store.set(key, value);
      ttls.set(key, ttl);
    },
    del: async key => {
      store.delete(key);
    },
    clear: async () => store.clear(),
    exists: async key => store.has(key),
    ttl: async () => -1,
  };
  return { adapter, store, ttls };
}

type Hook = (context: { request: any; response: any }) => Promise<void>;

/** Install the middleware against a hooks double and hand back its request hook */
async function installed(options?: Parameters<CacheModule['cache']>[0]): Promise<Hook> {
  const hooks: Hook[] = [];
  const mw = cache(options);
  await mw.install({ before: (_event: string, fn: Hook) => hooks.push(fn) } as any, {});
  return hooks[0] as Hook;
}

/** Storing is fire-and-forget behind the response; let it land */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * One request through the hook and a handler. Returns the response and
 * whether the handler ran (it does not on a cache hit).
 */
async function exchange(
  hook: Hook,
  req: any,
  handler: (res: FakeResponse) => void,
  nodeStyle = true
) {
  const res = new FakeResponse(nodeStyle);
  await hook({ request: req, response: res });
  const handled = !res.headersSent;
  if (handled) handler(res);
  await settle();
  return { res, ranHandler: handled };
}

describe('middleware.cache() - global response cache', () => {
  beforeEach(() => {
    log.warn.mockClear();
    log.error.mockClear();
  });

  describe('Set-Cookie', () => {
    it('is never stored and never replayed', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      const first = await exchange(hook, request('/page'), res => {
        res.setHeader('Set-Cookie', ['sid=SESSION-OF-ALICE; HttpOnly']);
        res.setHeader('X-Custom', 'kept');
        res.json({ page: 1 });
      });
      expect(first.ranHandler).toBe(true);
      // the caller it was meant for still gets it
      expect(first.res.getHeader('set-cookie')).toEqual(['sid=SESSION-OF-ALICE; HttpOnly']);

      const stored = [...store.values()][0] as CachedResponse;
      expect(stored).toBeDefined();
      expect(Object.keys(stored.headers).map(h => h.toLowerCase())).not.toContain('set-cookie');
      expect(JSON.stringify(stored)).not.toContain('SESSION-OF-ALICE');

      const second = await exchange(hook, request('/page'), () => {
        throw new Error('handler must not run on a hit');
      });
      expect(second.ranHandler).toBe(false);
      expect(second.res.getHeader('x-cache')).toBe('HIT');
      expect(second.res.getHeader('set-cookie')).toBeUndefined();
      expect(second.res.getHeader('x-custom')).toBe('kept');
      expect(second.res.body).toEqual({ page: 1 });
    });

    it('is dropped from a stored entry that carries it', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });
      store.set('moro:cache:GET:/legacy', {
        body: 'old',
        status: 200,
        headers: { 'set-cookie': ['sid=STALE'], 'x-kept': '1' },
        timestamp: Date.now(),
      });

      const { res, ranHandler } = await exchange(hook, request('/legacy'), () => undefined);
      expect(ranHandler).toBe(false);
      expect(res.getHeader('set-cookie')).toBeUndefined();
      expect(res.getHeader('x-kept')).toBe('1');
    });
  });

  describe('requests that carry Authorization', () => {
    it('are not answered from the store and are not stored', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });
      const me = (name: string) => (res: FakeResponse) => res.json({ user: name });

      const alice = await exchange(
        hook,
        request('/api/me', { authorization: 'Bearer alice' }),
        me('alice')
      );
      expect(alice.ranHandler).toBe(true);
      expect(alice.res.getHeader('x-cache')).toBe('BYPASS');
      expect(store.size).toBe(0);

      // an anonymous caller is not handed alice's answer
      const anonymous = await exchange(hook, request('/api/me'), res =>
        res.status(401).json({ error: 'sign in' })
      );
      expect(anonymous.ranHandler).toBe(true);
      expect(anonymous.res.body).toEqual({ error: 'sign in' });

      // and an entry made by an anonymous caller is not handed to bob
      await exchange(hook, request('/api/list'), res => res.json({ list: 'public' }));
      expect(store.size).toBe(1);
      const bob = await exchange(hook, request('/api/list', { authorization: 'Bearer bob' }), res =>
        res.json({ list: 'for bob' })
      );
      expect(bob.ranHandler).toBe(true);
      expect(bob.res.body).toEqual({ list: 'for bob' });
      expect(store.size).toBe(1);
    });

    it('are cached when the matched strategy keys them itself', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({
        adapter,
        strategies: {
          '^/api/me$': { ttl: 30, key: (req: any) => `me:${req.headers.authorization}` },
        },
      });
      const headers = { authorization: 'Bearer alice' };

      const first = await exchange(hook, request('/api/me', headers), res =>
        res.json({ user: 'alice' })
      );
      expect(first.ranHandler).toBe(true);
      expect([...store.keys()]).toEqual(['moro:cache:me:Bearer alice']);

      const again = await exchange(hook, request('/api/me', headers), () => undefined);
      expect(again.ranHandler).toBe(false);
      expect(again.res.body).toEqual({ user: 'alice' });

      const bob = await exchange(hook, request('/api/me', { authorization: 'Bearer bob' }), res =>
        res.json({ user: 'bob' })
      );
      expect(bob.ranHandler).toBe(true);
      expect(bob.res.body).toEqual({ user: 'bob' });
    });
  });

  describe('requests that carry a Cookie', () => {
    const me = (name: string) => (res: FakeResponse) => res.json({ user: name });

    it('are not answered from the store and are not stored', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      const alice = await exchange(hook, request('/account', { cookie: 'sid=alice' }), me('alice'));
      expect(alice.ranHandler).toBe(true);
      expect(alice.res.getHeader('x-cache')).toBe('BYPASS');
      expect(store.size).toBe(0);

      // the next signed-in user gets an answer of their own
      const bob = await exchange(hook, request('/account', { cookie: 'sid=bob' }), me('bob'));
      expect(bob.ranHandler).toBe(true);
      expect(bob.res.body).toEqual({ user: 'bob' });

      // and so does a caller with no cookie at all
      const anonymous = await exchange(hook, request('/account'), res =>
        res.status(401).json({ error: 'sign in' })
      );
      expect(anonymous.ranHandler).toBe(true);
      expect(anonymous.res.body).toEqual({ error: 'sign in' });
      expect(store.size).toBe(0);
    });

    it('are not handed an entry stored for callers without one', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/home'), res => res.json({ greeting: 'hello, guest' }));
      expect(store.size).toBe(1);

      const alice = await exchange(hook, request('/home', { cookie: 'sid=alice' }), res =>
        res.json({ greeting: 'hello, alice' })
      );
      expect(alice.ranHandler).toBe(true);
      expect(alice.res.body).toEqual({ greeting: 'hello, alice' });

      // callers without a cookie still share the stored entry
      const guest = await exchange(hook, request('/home'), () => undefined);
      expect(guest.ranHandler).toBe(false);
      expect(guest.res.getHeader('x-cache')).toBe('HIT');
    });

    it('are marked private for the caches downstream', async () => {
      const hook = await installed({ adapter: spyAdapter().adapter });

      const withCookie = await exchange(hook, request('/home', { cookie: 'sid=alice' }), res =>
        res.json({})
      );
      expect(withCookie.res.getHeader('cache-control')).toBe('private, max-age=300');

      const without = await exchange(hook, request('/other'), res => res.json({}));
      expect(without.res.getHeader('cache-control')).toBe('public, max-age=300');
    });

    it('are cached, and marked public, when the matched strategy keys them itself', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({
        adapter,
        strategies: {
          // the same page for everyone, whatever cookies the browser sends
          '^/pricing$': { ttl: 60, key: (req: any) => `page:${req.path}` },
        },
      });

      const first = await exchange(hook, request('/pricing', { cookie: '_ga=1' }), res =>
        res.json({ plan: 'pro' })
      );
      expect(first.ranHandler).toBe(true);
      expect(first.res.getHeader('x-cache')).toBe('MISS');
      expect(first.res.getHeader('cache-control')).toBe('public, max-age=300');
      expect([...store.keys()]).toEqual(['moro:cache:page:/pricing']);

      const second = await exchange(
        hook,
        request('/pricing', { cookie: '_ga=2' }),
        () => undefined
      );
      expect(second.ranHandler).toBe(false);
      expect(second.res.body).toEqual({ plan: 'pro' });

      // the same request without such a strategy is the caller's own
      const plain = await installed({ adapter: spyAdapter().adapter });
      const bypassed = await exchange(plain, request('/pricing', { cookie: '_ga=1' }), res =>
        res.json({ plan: 'pro' })
      );
      expect(bypassed.res.getHeader('x-cache')).toBe('BYPASS');
    });
  });

  describe('requests the application authenticates another way', () => {
    it('bypass the store when they carry a header named in credentialHeaders', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter, credentialHeaders: ['X-API-Key'] });

      const keyed = await exchange(hook, request('/report', { 'x-api-key': 'k-alice' }), res =>
        res.json({ owner: 'alice' })
      );
      expect(keyed.res.getHeader('x-cache')).toBe('BYPASS');
      expect(store.size).toBe(0);

      const anonymous = await exchange(hook, request('/report'), res =>
        res.status(401).json({ error: 'key required' })
      );
      expect(anonymous.ranHandler).toBe(true);
      expect(anonymous.res.statusCode).toBe(401);
      expect(warnings()).toEqual([]);
    });

    it('do not store a response once the application has identified the caller', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      // nothing on the request says "credentials" (a token in a custom header),
      // but by the time the handler answers, auth middleware has set req.user
      for (const identify of [
        (req: any) => (req.user = { id: 'alice' }),
        (req: any) => (req.auth = { user: { id: 'alice' } }),
      ]) {
        const req = request('/dashboard', { 'x-token': 't-alice' });
        const res = new FakeResponse();
        await hook({ request: req, response: res });
        identify(req);
        res.json({ owner: 'alice' });
        await settle();
        expect(store.size).toBe(0);
      }

      const anonymous = await exchange(hook, request('/dashboard'), res =>
        res.status(401).json({ error: 'sign in' })
      );
      expect(anonymous.ranHandler).toBe(true);
    });
  });

  describe('vary', () => {
    it('keeps a separate entry per value of the named headers', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter, vary: ['Accept-Language'] });
      const greet = (text: string) => (res: FakeResponse) => res.json({ text });

      const english = await exchange(
        hook,
        request('/hello', { 'accept-language': 'en' }),
        greet('hello')
      );
      expect(english.ranHandler).toBe(true);

      // a different language is not answered with the English entry
      const french = await exchange(
        hook,
        request('/hello', { 'accept-language': 'fr' }),
        greet('bonjour')
      );
      expect(french.ranHandler).toBe(true);
      expect(french.res.body).toEqual({ text: 'bonjour' });
      expect(store.size).toBe(2);

      // the same language is
      const again = await exchange(
        hook,
        request('/hello', { 'accept-language': 'fr' }),
        greet('?')
      );
      expect(again.ranHandler).toBe(false);
      expect(again.res.body).toEqual({ text: 'bonjour' });

      // and a request without the header has an entry of its own
      const none = await exchange(hook, request('/hello'), greet('hi'));
      expect(none.ranHandler).toBe(true);
      expect(store.size).toBe(3);
    });

    it('applies to a strategy with its own key as well', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({
        adapter,
        vary: ['x-country'],
        strategies: { '^/geo': { key: () => 'geo', ttl: 60 } },
      });

      await exchange(hook, request('/geo', { 'x-country': 'US' }), res => res.json({ c: 'US' }));
      const other = await exchange(hook, request('/geo', { 'x-country': 'DE' }), res =>
        res.json({ c: 'DE' })
      );
      expect(other.ranHandler).toBe(true);
      expect(other.res.body).toEqual({ c: 'DE' });
      expect([...store.keys()]).toEqual([
        'moro:cache:geo|vary|x-country=US',
        'moro:cache:geo|vary|x-country=DE',
      ]);
    });

    it('leaves the key alone when vary is not configured', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/plain', { 'accept-language': 'en' }), res => res.json({}));
      expect([...store.keys()]).toEqual(['moro:cache:GET:/plain']);
    });
  });

  describe('varyBy', () => {
    const report = (owner: string) => (res: FakeResponse) => res.json({ owner });

    it('keeps an entry per caller, under a digest of the header and not its value', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter, varyBy: ['X-API-Key'] });

      const alice = await exchange(
        hook,
        request('/report', { 'x-api-key': 'k-alice' }),
        report('alice')
      );
      expect(alice.ranHandler).toBe(true);
      expect(alice.res.getHeader('x-cache')).toBe('MISS');

      // another caller is not handed alice's entry
      const bob = await exchange(hook, request('/report', { 'x-api-key': 'k-bob' }), report('bob'));
      expect(bob.ranHandler).toBe(true);
      expect(bob.res.body).toEqual({ owner: 'bob' });

      // the same caller is answered from the store
      const again = await exchange(
        hook,
        request('/report', { 'x-api-key': 'k-alice' }),
        report('?')
      );
      expect(again.ranHandler).toBe(false);
      expect(again.res.body).toEqual({ owner: 'alice' });

      // callers without the header share one entry, apart from both
      const anonymous = await exchange(hook, request('/report'), report('nobody'));
      expect(anonymous.ranHandler).toBe(true);
      expect((await exchange(hook, request('/report'), report('?'))).res.body).toEqual({
        owner: 'nobody',
      });

      const keys = [...store.keys()];
      expect(keys).toHaveLength(3);
      expect(keys.filter(key => /^moro:cache:GET:\/report\|by\|[\w-]{22}$/.test(key))).toHaveLength(
        2
      );
      expect(keys).toContain('moro:cache:GET:/report');
      expect(keys.join(' ')).not.toContain('k-alice');
      expect(String(alice.res.getHeader('x-cache-key'))).not.toContain('k-alice');
    });

    it('marks a keyed response private and announces the header in Vary, beside those of vary', async () => {
      const hook = await installed({ varyBy: ['x-api-key'], vary: ['Accept-Language'] });

      const keyed = await exchange(hook, request('/report', { 'x-api-key': 'k' }), report('a'));
      expect(keyed.res.getHeader('cache-control')).toBe('private, max-age=300');
      expect(keyed.res.getHeader('vary')).toBe('Accept-Language, x-api-key');

      const anonymous = await exchange(hook, request('/report'), report('nobody'));
      expect(anonymous.res.getHeader('cache-control')).toBe('public, max-age=300');
      expect(anonymous.res.getHeader('vary')).toBe('Accept-Language, x-api-key');
    });

    it('stores for a caller the application has identified, when the request is keyed on them', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter, varyBy: ['x-api-key'] });
      const identified = async (key: string | undefined, owner: string) => {
        const req = request('/dashboard', key ? { 'x-api-key': key } : {});
        const res = new FakeResponse();
        await hook({ request: req, response: res });
        const ranHandler = !res.headersSent;
        if (ranHandler) {
          req.user = { id: owner };
          res.json({ owner });
        }
        await settle();
        return { res, ranHandler };
      };

      await identified('k-alice', 'alice');
      expect(store.size).toBe(1);
      expect((await identified('k-alice', '?')).ranHandler).toBe(false);
      expect((await identified('k-bob', 'bob')).res.body).toEqual({ owner: 'bob' });

      // identified by something the key does not hold: not stored, as without varyBy
      await identified(undefined, 'carol');
      expect(store.size).toBe(2);
    });

    it('keys a credential header named in it instead of bypassing, and still bypasses the others', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter, varyBy: ['authorization'] });

      const alice = await exchange(
        hook,
        request('/me', { authorization: 'Bearer alice' }),
        report('alice')
      );
      expect(alice.res.getHeader('x-cache')).toBe('MISS');
      const again = await exchange(
        hook,
        request('/me', { authorization: 'Bearer alice' }),
        report('?')
      );
      expect(again.ranHandler).toBe(false);
      const bob = await exchange(
        hook,
        request('/me', { authorization: 'Bearer bob' }),
        report('bob')
      );
      expect(bob.res.body).toEqual({ owner: 'bob' });
      expect([...store.keys()].join(' ')).not.toContain('alice');

      // a Cookie is not named: such a request stays out of the store
      const withCookie = await exchange(
        hook,
        request('/me', { authorization: 'Bearer alice', cookie: 'sid=1' }),
        report('alice')
      );
      expect(withCookie.res.getHeader('x-cache')).toBe('BYPASS');
      expect(store.size).toBe(2);
    });

    it('applies to a strategy with its own key as well', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({
        adapter,
        varyBy: ['x-api-key'],
        strategies: { '^/geo': { key: () => 'geo', ttl: 60 } },
      });

      await exchange(hook, request('/geo', { 'x-api-key': 'a' }), report('a'));
      const other = await exchange(hook, request('/geo', { 'x-api-key': 'b' }), report('b'));
      expect(other.ranHandler).toBe(true);
      expect(store.size).toBe(2);
    });
  });

  describe('the default key', () => {
    const page = (text: string) => (res: FakeResponse) => res.json({ text });

    it('keeps the hosts an application answers for apart', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/home', { host: 'Tenant-A.example' }), page('A'));
      const other = await exchange(hook, request('/home', { host: 'tenant-b.example' }), page('B'));
      expect(other.ranHandler).toBe(true);
      expect(other.res.body).toEqual({ text: 'B' });

      const again = await exchange(hook, request('/home', { host: 'tenant-a.example' }), page('?'));
      expect(again.ranHandler).toBe(false);
      expect(again.res.body).toEqual({ text: 'A' });
      expect([...store.keys()]).toEqual([
        'moro:cache:GET:tenant-a.example/home',
        'moro:cache:GET:tenant-b.example/home',
      ]);
    });

    it('keeps a response built for one X-Forwarded-Host from callers that sent another', async () => {
      const hook = await installed({});
      const host = 'site.example';

      await exchange(
        hook,
        request('/links', { host, 'x-forwarded-host': 'evil.example' }),
        page('https://evil.example/reset')
      );
      const direct = await exchange(hook, request('/links', { host }), page('ok'));
      expect(direct.ranHandler).toBe(true);
      expect(direct.res.body).toEqual({ text: 'ok' });
    });

    it('tells apart query values that a parser made arrays or objects', async () => {
      const hook = await installed({});
      const withQuery = (query: Record<string, unknown>) => ({ ...request('/search'), query });

      await exchange(hook, withQuery({ filter: { tag: 'a' } }), page('a'));
      const other = await exchange(hook, withQuery({ filter: { tag: 'b' } }), page('b'));
      expect(other.ranHandler).toBe(true);

      await exchange(hook, withQuery({ id: ['1', '2'] }), page('two ids'));
      const joined = await exchange(hook, withQuery({ id: '1,2' }), page('one id'));
      expect(joined.ranHandler).toBe(true);

      // string values are keyed as they always were
      const { adapter, store } = spyAdapter();
      const plain = await installed({ adapter });
      await exchange(plain, withQuery({ q: 'a b', page: '2' }), page('x'));
      expect([...store.keys()]).toEqual(['moro:cache:GET:/search?q=a+b&page=2']);
    });
  });

  describe('status', () => {
    it.each([401, 403, 407, 429, 500, 503])('does not store a %i', async status => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/flaky'), res => res.status(status).json({ error: status }));
      expect(store.size).toBe(0);

      const next = await exchange(hook, request('/flaky'), res => res.json({ ok: true }));
      expect(next.ranHandler).toBe(true);
      expect(next.res.statusCode).toBe(200);
      expect(next.res.body).toEqual({ ok: true });
    });

    it('replays a stored response with the status it was sent with', async () => {
      const { adapter } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/gone'), res => res.status(404).json({ error: 'not found' }));
      const replay = await exchange(hook, request('/gone'), () => undefined);
      expect(replay.ranHandler).toBe(false);
      expect(replay.res.statusCode).toBe(404);
      expect(replay.res.body).toEqual({ error: 'not found' });
    });
  });

  describe('response Cache-Control', () => {
    it.each(['private', 'private, max-age=60', 'no-store', 'no-cache', 'max-age=0, No-Store'])(
      'does not store a response the handler marked "%s"',
      async value => {
        const { adapter, store } = spyAdapter();
        const hook = await installed({ adapter });

        await exchange(hook, request('/account'), res => {
          res.setHeader('Cache-Control', value);
          res.json({ balance: 10 });
        });
        expect(store.size).toBe(0);
        const again = await exchange(hook, request('/account'), res => res.json({ balance: 20 }));
        expect(again.ranHandler).toBe(true);
      }
    );

    it("stores a response that only carries the middleware's own default", async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      const first = await exchange(hook, request('/public'), res => res.json({ ok: true }));
      expect(first.res.getHeader('cache-control')).toBe('public, max-age=300');
      expect(store.size).toBe(1);
    });

    it("stores when the directive is the developer's own cacheControl option", async () => {
      // `cacheControl` is what the developer asked the middleware to send to
      // browsers; it says nothing about the handler having opted out
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter, cacheControl: 'no-cache' });

      await exchange(hook, request('/revalidated'), res => res.json({ ok: true }));
      expect(store.size).toBe(1);
    });

    it('stores a public response the handler set itself', async () => {
      const { adapter, store } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/asset'), res => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.json({ ok: true });
      });
      expect(store.size).toBe(1);
    });
  });

  describe('replay', () => {
    it('sends a res.json() body through res.json(), not as an object to send()', async () => {
      // Engine-style response: json() does not pass through end(), so the
      // object the handler gave is all that was ever stored
      const { adapter } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/data'), res => res.json({ n: 1 }), false);
      const replay = await exchange(hook, request('/data'), () => undefined, false);
      expect(replay.ranHandler).toBe(false);
      expect(replay.res.sentWith).toBe('json');
      expect(replay.res.body).toEqual({ n: 1 });
    });

    it('stores the body the handler gave, once, on a response that finishes through end()', async () => {
      const { adapter, store } = spyAdapter();
      const set = jest.spyOn(adapter, 'set');
      const hook = await installed({ adapter });

      await exchange(hook, request('/data'), res => res.json({ n: 1 }));
      expect(set).toHaveBeenCalledTimes(1);
      expect(([...store.values()][0] as CachedResponse).body).toEqual({ n: 1 });
    });

    it('sends string and Buffer bodies as they were stored', async () => {
      const { adapter } = spyAdapter();
      const hook = await installed({ adapter });

      await exchange(hook, request('/text'), res => {
        res.setHeader('Content-Type', 'text/html');
        res.send('<p>hi</p>');
      });
      const text = await exchange(hook, request('/text'), () => undefined);
      expect(text.res.sentWith).toBe('send');
      expect(text.res.body).toBe('<p>hi</p>');
      expect(text.res.getHeader('content-type')).toBe('text/html');

      await exchange(hook, request('/bytes'), res => res.end(Buffer.from([1, 2, 3])));
      const bytes = await exchange(hook, request('/bytes'), () => undefined);
      expect(Buffer.isBuffer(bytes.res.body)).toBe(true);
      expect([...bytes.res.body]).toEqual([1, 2, 3]);
    });

    it('sends bytes again when the adapter kept the entry as JSON (Redis, file)', async () => {
      const { adapter, store } = spyAdapter();
      // what a JSON-serializing adapter hands back
      adapter.get = async key => {
        const entry = store.get(key);
        return entry ? JSON.parse(JSON.stringify(entry)) : null;
      };
      const hook = await installed({ adapter });

      await exchange(hook, request('/img'), res => {
        res.setHeader('Content-Type', 'image/png');
        res.end(Buffer.from([137, 80, 78, 71]));
      });
      const image = await exchange(hook, request('/img'), () => undefined);
      expect(image.res.sentWith).toBe('send');
      expect(Buffer.isBuffer(image.res.body)).toBe(true);
      expect([...image.res.body]).toEqual([137, 80, 78, 71]);

      // a res.json() body that merely looks like one stays JSON
      const lookalike = { type: 'Buffer', data: [1, 2] };
      await exchange(hook, request('/json'), res => res.json(lookalike));
      const json = await exchange(hook, request('/json'), () => undefined);
      expect(json.res.sentWith).toBe('json');
      expect(json.res.body).toEqual(lookalike);
    });
  });

  describe('ETag', () => {
    const etagOf = async (hook: Hook, path: string, body: unknown) =>
      (await exchange(hook, request(path), res => res.json(body))).res.getHeader('etag') as string;

    it('is a digest of the body: equal bodies share it, different bodies never do', async () => {
      const hook = await installed({ adapter: spyAdapter().adapter });

      const tag = await etagOf(hook, '/a', { value: 'Aa' });
      expect(tag).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
      expect(await etagOf(hook, '/b', { value: 'Aa' })).toBe(tag);
      // two bodies a 32-bit rolling hash cannot tell apart
      expect(await etagOf(hook, '/c', { value: 'BB' })).not.toBe(tag);

      // a generateETag function still decides when one is given
      const custom = await installed({
        adapter: spyAdapter().adapter,
        generateETag: content => `"len-${content.length}"`,
      });
      expect(await etagOf(custom, '/custom', { n: 1 })).toBe('"len-7"');
    });

    it('is weak when asked for, and answers a matching If-None-Match with 304', async () => {
      const hook = await installed({ adapter: spyAdapter().adapter, etag: 'weak' });
      const tag = await etagOf(hook, '/weak', { n: 1 });
      expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);

      const revalidate = await exchange(hook, request('/weak-2', { 'if-none-match': tag }), res =>
        res.json({ n: 1 })
      );
      expect(revalidate.res.statusCode).toBe(304);
    });
  });

  describe('options', () => {
    it('accepts the documented call: { ttl, strategy: "memory" }', async () => {
      const memory = jest.spyOn(MemoryCacheAdapter.prototype, 'set');
      try {
        const hook = await installed({ ttl: 300, strategy: 'memory' });
        expect(warnings()).toEqual([]);

        await exchange(hook, request('/doc'), res => res.json({ ok: true }));
        expect(memory).toHaveBeenCalledTimes(1);
        expect(memory.mock.calls[0]?.[2]).toBe(300);
      } finally {
        memory.mockRestore();
      }
    });

    it('lets defaultTtl win over its alias, and a strategy ttl over both', async () => {
      const { adapter, ttls } = spyAdapter();
      const hook = await installed({
        adapter,
        ttl: 300,
        defaultTtl: 120,
        strategies: { '^/short$': { ttl: 5, key: () => 'short' } },
      });

      await exchange(hook, request('/long'), res => res.json({}));
      await exchange(hook, request('/short'), res => res.json({}));
      expect(ttls.get('moro:cache:GET:/long')).toBe(120);
      expect(ttls.get('moro:cache:short')).toBe(5);
    });

    it('warns once about option keys it does not know, and does not throw', () => {
      expect(() => cache({ tttl: 60, stratagy: 'memory' } as any)).not.toThrow();
      const logged = warnings();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('tttl');
      expect(logged[0]).toContain('stratagy');
    });

    it('says nothing about the options it has', () => {
      cache({
        adapter: 'memory',
        adapterOptions: {},
        strategies: {},
        defaultTtl: 1,
        keyPrefix: 'p:',
        httpCaching: true,
        maxAge: 1,
        cacheControl: 'public',
        staleWhileRevalidate: 1,
        vary: [],
        etag: 'weak',
        conditionalRequests: true,
        generateETag: () => '"x"',
        ttl: 1,
        strategy: 'memory',
        maxEntries: 10,
        credentialHeaders: [],
        varyBy: [],
      });
      expect(warnings()).toEqual([]);
    });

    it('says at start-up what a cache that nothing narrows stores and shares', async () => {
      const said = () =>
        log.info.mock.calls
          .map(call => String(call[0]))
          .filter(line => line.includes('every GET response'));

      log.info.mockClear();
      await installed({ ttl: 120 });
      expect(said()).toHaveLength(1);
      expect(said()[0]).toMatch(/no strategies and no varyBy/);
      expect(said()[0]).toMatch(/stored for 120s/);
      expect(said()[0]).toMatch(/Cookie or Authorization/);
      expect(said()[0]).toMatch(/varyBy or credentialHeaders/);

      log.info.mockClear();
      await installed({ credentialHeaders: ['X-API-Key'] });
      expect(said()[0]).toMatch(/Cookie or Authorization \(or x-api-key\)/);

      // narrowed on purpose: nothing to point out
      log.info.mockClear();
      await installed({ varyBy: ['x-api-key'] });
      await installed({ strategies: { '^/pricing$': { ttl: 60, key: () => 'pricing' } } });
      expect(said()).toEqual([]);
    });

    it('warns about a strategy name that is not an adapter and falls back to memory', async () => {
      const hook = await installed({ strategy: 'lru-turbo' });
      expect(warnings().some(w => w.includes('lru-turbo'))).toBe(true);

      await exchange(hook, request('/x'), res => res.json({ ok: 1 }));
      const again = await exchange(hook, request('/x'), () => undefined);
      expect(again.ranHandler).toBe(false);
    });

    it('bounds the built-in memory store with maxEntries', async () => {
      const hook = await installed({ maxEntries: 2, httpCaching: false });
      const hit = async (path: string) =>
        (await exchange(hook, request(path), res => res.json({ path }))).ranHandler === false;

      expect(await hit('/a')).toBe(false);
      expect(await hit('/b')).toBe(false);
      expect(await hit('/a')).toBe(true); // touches /a: /b is now the least recently used
      expect(await hit('/c')).toBe(false); // third entry: /b leaves
      expect(await hit('/a')).toBe(true);
      expect(await hit('/c')).toBe(true);
      expect(await hit('/b')).toBe(false);
    });
  });
});

describe('MemoryCacheAdapter', () => {
  it('evicts the least recently used entry past maxEntries', async () => {
    const adapter = new MemoryCacheAdapter({ maxEntries: 3 });
    await adapter.set('a', 1, 60);
    await adapter.set('b', 2, 60);
    await adapter.set('c', 3, 60);
    expect(await adapter.get('a')).toBe(1); // a is now the most recently used
    await adapter.set('d', 4, 60);

    expect(adapter.size).toBe(3);
    expect(await adapter.get('b')).toBeNull();
    expect(await adapter.get('a')).toBe(1);
    expect(await adapter.get('c')).toBe(3);
    expect(await adapter.get('d')).toBe(4);
    await adapter.clear();
  });

  it('stays within the cap under a stream of distinct keys', async () => {
    const adapter = new MemoryCacheAdapter({ maxEntries: 50 });
    for (let i = 0; i < 2000; i++) await adapter.set(`k${i}`, i, 60);
    expect(adapter.size).toBe(50);
    expect(await adapter.get('k1999')).toBe(1999);
    expect(await adapter.get('k0')).toBeNull();
    await adapter.clear();
  });

  it('is unbounded unless a cap is given (it also backs the session store)', async () => {
    const adapter = new MemoryCacheAdapter();
    for (let i = 0; i < 12000; i++) await adapter.set(`s${i}`, i, 60);
    expect(adapter.size).toBe(12000);
    expect(await adapter.get('s0')).toBe(0);
    await adapter.clear();
  });

  it('rewriting a key does not evict anything', async () => {
    const adapter = new MemoryCacheAdapter({ maxEntries: 2 });
    await adapter.set('a', 1, 60);
    await adapter.set('b', 2, 60);
    await adapter.set('a', 10, 60);
    expect(adapter.size).toBe(2);
    expect(await adapter.get('a')).toBe(10);
    expect(await adapter.get('b')).toBe(2);
    await adapter.clear();
  });

  it('logs a tag in place of each key with redactKeys, and the key itself without', async () => {
    const debugLines = () => log.debug.mock.calls.map(call => String(call[0]));
    log.debug.mockClear();

    const plain = new MemoryCacheAdapter();
    await plain.set('page:/pricing', 1, 60);
    await plain.del('page:/pricing');
    expect(debugLines()).toEqual([
      'Cached item: page:/pricing (TTL: 60s)',
      'Deleted cache item: page:/pricing',
    ]);

    log.debug.mockClear();
    const secretKeys = new MemoryCacheAdapter({ redactKeys: true });
    await secretKeys.set('a-session-id-nobody-should-read', 1, 60);
    await secretKeys.del('a-session-id-nobody-should-read');
    expect(debugLines()).toEqual([
      expect.stringMatching(/^Cached item: #[0-9a-f]{8}\(31\) \(TTL: 60s\)$/),
      expect.stringMatching(/^Deleted cache item: #[0-9a-f]{8}\(31\)$/),
    ]);
    expect(debugLines().join()).not.toContain('a-session-id');
    await plain.clear();
    await secretKeys.clear();
  });
});

describe('RedisCacheAdapter log lines', () => {
  it('logs a tag in place of each key with redactKeys, in errors too', async () => {
    const { RedisCacheAdapter } =
      await import('../../../src/core/middleware/built-in/cache/adapters/cache/redis.js');
    const store = new Map<string, string>();
    const client = {
      isOpen: true,
      get: async () => {
        throw new Error('redis is down');
      },
      set: async (key: string, value: string) => void store.set(key, value),
      del: async (key: string) => void store.delete(key),
    };
    const logged = () =>
      JSON.stringify([...log.debug.mock.calls, ...log.error.mock.calls], (_key, value) =>
        value instanceof Error ? value.message : value
      );
    const id = 'a-session-id-nobody-should-read';

    log.debug.mockClear();
    log.error.mockClear();
    const plain = new RedisCacheAdapter({ client, keyPrefix: 'cache:' });
    await plain.set(id, 1, 60);
    await plain.get(id);
    expect(logged()).toContain(`Cached item in Redis: ${id}`);
    expect(log.error).toHaveBeenCalledWith(
      'Redis get error',
      'RedisCache',
      expect.objectContaining({ key: id })
    );

    log.debug.mockClear();
    log.error.mockClear();
    const sessions = new RedisCacheAdapter({ client, keyPrefix: 'sess:', redactKeys: true });
    await sessions.set(id, 1, 60);
    await sessions.get(id);
    await sessions.del(id);
    expect(log.debug.mock.calls.map(call => call[0])).toEqual([
      expect.stringMatching(/^Cached item in Redis: #[0-9a-f]{8}\(31\) \(TTL: 60s\)$/),
      expect.stringMatching(/^Deleted Redis cache item: #[0-9a-f]{8}\(31\)$/),
    ]);
    expect(log.error).toHaveBeenCalledWith(
      'Redis get error',
      'RedisCache',
      expect.objectContaining({ key: expect.stringMatching(/^#[0-9a-f]{8}\(31\)$/) })
    );
    expect(logged()).not.toContain(id);
  });
});
