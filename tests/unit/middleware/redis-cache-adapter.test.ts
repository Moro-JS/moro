// @ts-nocheck
// Unit - RedisCacheAdapter against a fake node-redis 4+ client. Covers the
// v4 API surface the adapter relies on (connect(), SET ... PX, scanIterator,
// flushDb), the key prefix, and that every call waits for initialization.
import { describe, it, expect } from '@jest/globals';
import { RedisCacheAdapter } from '../../../src/core/middleware/built-in/cache/adapters/cache/redis.js';

function fakeClient(opts: { open?: boolean; pages?: boolean } = {}) {
  const store = new Map<string, { value: string; px?: number }>();
  const calls: any[] = [];
  const client: any = {
    isOpen: opts.open ?? false,
    store,
    calls,
    on() {},
    async connect() {
      calls.push(['connect']);
      client.isOpen = true;
    },
    async get(k: string) {
      return store.get(k)?.value ?? null;
    },
    async set(k: string, v: string, o?: any) {
      calls.push(['set', k, o]);
      store.set(k, { value: v, px: o?.PX });
      return 'OK';
    },
    async del(k: string | string[]) {
      const keys = Array.isArray(k) ? k : [k];
      let n = 0;
      for (const key of keys) if (store.delete(key)) n++;
      return n;
    },
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    },
    async ttl(k: string) {
      const e = store.get(k);
      return e ? (e.px ? Math.ceil(e.px / 1000) : -1) : -2;
    },
    async flushDb() {
      calls.push(['flushDb']);
      store.clear();
    },
    scanIterator({ MATCH }: { MATCH: string }) {
      const prefix = MATCH.replace(/\*$/, '');
      const keys = [...store.keys()].filter(k => k.startsWith(prefix));
      // node-redis 4 yields keys one at a time; 5 yields pages (arrays)
      const items = opts.pages ? [keys] : keys;
      return (async function* () {
        for (const item of items) yield item;
      })();
    },
  };
  return client;
}

describe('RedisCacheAdapter (node-redis 4+)', () => {
  it('connects a closed client before the first command and prefixes keys', async () => {
    const client = fakeClient({ open: false });
    const cache = new RedisCacheAdapter({ client });

    // Issued immediately after construction: must wait for connect(), not race it
    await cache.set('user:1', { name: 'moro' }, 60);
    expect(client.calls[0]).toEqual(['connect']);
    expect(client.store.has('moro:cache:user:1')).toBe(true);
    expect(await cache.get('user:1')).toEqual({ name: 'moro' });
    expect(await cache.exists('user:1')).toBe(true);
    expect(await cache.ttl('user:1')).toBe(60);
  });

  it('does not reconnect an already-open client', async () => {
    const client = fakeClient({ open: true });
    const cache = new RedisCacheAdapter({ client, keyPrefix: 'p:' });
    await cache.set('k', 1);
    expect(client.calls.find((c: any) => c[0] === 'connect')).toBeUndefined();
  });

  it('uses SET ... PX so sub-second TTLs survive, and no expiry for ttl <= 0', async () => {
    const client = fakeClient({ open: true });
    const cache = new RedisCacheAdapter({ client, keyPrefix: '' });
    await cache.set('a', 1, 0.25);
    await cache.set('b', 2, 0);
    expect(client.calls).toEqual([
      ['set', 'a', { PX: 250 }],
      ['set', 'b', undefined],
    ]);
  });

  it("clear() removes only this adapter's prefixed keys (SCAN, not FLUSHDB)", async () => {
    for (const pages of [false, true]) {
      const client = fakeClient({ open: true, pages });
      client.store.set('other:1', { value: '1' });
      const cache = new RedisCacheAdapter({ client, keyPrefix: 'moro:cache:' });
      await cache.set('x', 1);
      await cache.set('y', 2);
      await cache.clear();
      expect([...client.store.keys()]).toEqual(['other:1']);
      expect(client.calls.find((c: any) => c[0] === 'flushDb')).toBeUndefined();
    }
  });

  it('clear() with an empty prefix flushes the database', async () => {
    const client = fakeClient({ open: true });
    const cache = new RedisCacheAdapter({ client, keyPrefix: '' });
    await cache.set('x', 1);
    await cache.clear();
    expect(client.calls.find((c: any) => c[0] === 'flushDb')).toBeDefined();
    expect(client.store.size).toBe(0);
  });

  it('del removes the prefixed key', async () => {
    const client = fakeClient({ open: true });
    const cache = new RedisCacheAdapter({ client });
    await cache.set('gone', 1);
    await cache.del('gone');
    expect(await cache.get('gone')).toBeNull();
    expect(await cache.exists('gone')).toBe(false);
  });

  it('a client whose connect() fails degrades to misses without unhandled rejections', async () => {
    const client = fakeClient({ open: false });
    client.connect = async () => {
      throw new Error('ECONNREFUSED');
    };
    const cache = new RedisCacheAdapter({ client });
    expect(await cache.get('k')).toBeNull();
    expect(await cache.exists('k')).toBe(false);
    expect(await cache.ttl('k')).toBe(-1);
    await expect(cache.set('k', 1)).resolves.toBeUndefined();
  });
});
