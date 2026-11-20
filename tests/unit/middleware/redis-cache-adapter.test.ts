// @ts-nocheck
// Unit - RedisCacheAdapter against a fake node-redis 4+ client. Covers the
// v4 API surface the adapter relies on (connect(), SET ... PX, scanIterator,
// flushDb), the key prefix, and that every call waits for initialization;
// that an unreachable server answers as a miss after a bounded wait; and a
// caller-supplied ioredis client (positional SET ... PX, SCAN cursor).
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import {
  RedisCacheAdapter,
  READ_FAILED,
} from '../../../src/core/middleware/built-in/cache/adapters/cache/redis.js';
import { logger as globalLogger } from '../../../src/core/logger/index.js';

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

// What the adapter waits for a server that is not there, in ms
const WAIT = 5000;
const never = () => new Promise<never>(() => {});

describe('RedisCacheAdapter with an unreachable server', () => {
  // Every degraded call is logged at error level; keep the run quiet
  const quiet = () => globalLogger.setLevel('fatal');

  afterEach(() => {
    jest.useRealTimers();
    globalLogger.setLevel('error');
  });

  it('answers as a miss after a bounded wait when connect() never settles', async () => {
    quiet();
    jest.useFakeTimers();
    const client = fakeClient({ open: false });
    // node-redis keeps retrying: connect() neither resolves nor rejects
    client.connect = () => {
      client.isOpen = true;
      return never();
    };
    const cache = new RedisCacheAdapter({ client });

    const results = Promise.all([
      cache.get('k'),
      cache.read('k'),
      cache.exists('k'),
      cache.ttl('k'),
      cache.set('k', 1),
      cache.del('k'),
    ]);
    let settled = false;
    void results.then(() => (settled = true));

    await jest.advanceTimersByTimeAsync(WAIT - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await results).toEqual([null, READ_FAILED, false, -1, undefined, undefined]);
  });

  it('serves normally once a slow first connection is up', async () => {
    quiet();
    jest.useFakeTimers();
    const client = fakeClient({ open: false });
    let connected!: () => void;
    client.connect = () =>
      new Promise<void>(resolve => {
        connected = () => {
          client.isOpen = true;
          resolve();
        };
      });
    const cache = new RedisCacheAdapter({ client });

    // Issued while connecting and still pending when the connection arrives
    const early = cache.set('early', 'kept', 60);
    await jest.advanceTimersByTimeAsync(WAIT - 1000);
    connected();
    await early;
    expect(await cache.get('early')).toBe('kept');

    // The earlier wait leaves nothing behind: later calls are not cut short
    await jest.advanceTimersByTimeAsync(WAIT * 2);
    await cache.set('later', 2, 60);
    expect(await cache.get('later')).toBe(2);
  });

  it('bounds a command issued while the client reports that it is not ready', async () => {
    quiet();
    jest.useFakeTimers();
    const client = fakeClient({ open: true });
    const cache = new RedisCacheAdapter({ client });
    await cache.set('k', 'v', 60);

    // Connection lost: the client queues commands until the server is back
    client.isReady = false;
    client.get = never;
    const read = cache.read('k');
    const got = cache.get('k');
    await jest.advanceTimersByTimeAsync(WAIT);
    expect(await read).toBe(READ_FAILED);
    expect(await got).toBeNull();

    // Back again: commands go straight through
    client.isReady = true;
    client.get = async (k: string) => client.store.get(k)?.value ?? null;
    expect(await cache.get('k')).toBe('v');
  });

  it('read() tells a missing key (null) from a store that could not be read', async () => {
    quiet();
    const client = fakeClient({ open: true });
    const cache = new RedisCacheAdapter({ client });
    expect(await cache.read('absent')).toBeNull();

    client.get = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await cache.read('absent')).toBe(READ_FAILED);
    expect(await cache.get('absent')).toBeNull();
  });

  it('close() does not wait for a connection that never comes up', async () => {
    quiet();
    const client = fakeClient({ open: false });
    client.connect = () => {
      client.isOpen = true;
      return never();
    };
    const cache = new RedisCacheAdapter({ client });
    await new Promise(resolve => setImmediate(resolve));

    await cache.close();
    expect(await cache.get('k')).toBeNull();
  });
});

// ioredis: lower-case commands with positional arguments. Its SET rejects the
// node-redis options object, and it has SCAN with a cursor, not scanIterator.
function fakeIoredisClient() {
  const store = new Map<string, { value: string; px?: number }>();
  const calls: any[] = [];
  const client: any = {
    status: 'ready',
    store,
    calls,
    on() {},
    defineCommand() {},
    async get(k: string) {
      return store.get(k)?.value ?? null;
    },
    async set(k: string, v: string, ...args: any[]) {
      calls.push(['set', k, ...args]);
      if (args.some(arg => typeof arg === 'object')) throw new Error('ERR syntax error');
      store.set(k, { value: v, px: args[0] === 'PX' ? args[1] : undefined });
      return 'OK';
    },
    async del(...keys: any[]) {
      let n = 0;
      for (const key of keys.flat()) if (store.delete(key)) n++;
      return n;
    },
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    },
    async ttl(k: string) {
      const e = store.get(k);
      return e ? (e.px ? Math.ceil(e.px / 1000) : -1) : -2;
    },
    async flushdb() {
      calls.push(['flushdb']);
      store.clear();
    },
    // Two keys per page, so clear() has to follow the cursor
    async scan(cursor: string, ...args: any[]) {
      calls.push(['scan', cursor, ...args]);
      const prefix = String(args[args.indexOf('MATCH') + 1]).replace(/\*$/, '');
      const keys = [...store.keys()].filter(k => k.startsWith(prefix));
      const from = Number(cursor);
      const next = from + 2 < keys.length ? String(from + 2) : '0';
      return [next, keys.slice(from, from + 2)];
    },
  };
  return client;
}

describe('RedisCacheAdapter with an ioredis client', () => {
  it('stores with SET key value PX ms and reads the value back', async () => {
    const client = fakeIoredisClient();
    const cache = new RedisCacheAdapter({ client });

    await cache.set('user:1', { name: 'moro' }, 60);
    await cache.set('frac', 1, 0.25);
    await cache.set('forever', 2, 0);
    expect(client.calls).toEqual([
      ['set', 'moro:cache:user:1', 'PX', 60000],
      ['set', 'moro:cache:frac', 'PX', 250],
      ['set', 'moro:cache:forever'],
    ]);
    expect(await cache.get('user:1')).toEqual({ name: 'moro' });
    expect(await cache.exists('user:1')).toBe(true);
    expect(await cache.ttl('user:1')).toBe(60);

    await cache.del('user:1');
    expect(await cache.get('user:1')).toBeNull();
  });

  it("clear() follows the SCAN cursor and removes only this adapter's keys", async () => {
    const client = fakeIoredisClient();
    client.store.set('other:1', { value: '1' });
    const cache = new RedisCacheAdapter({ client });
    for (let i = 0; i < 5; i++) await cache.set(`k${i}`, i);

    await cache.clear();
    expect([...client.store.keys()]).toEqual(['other:1']);
    expect(client.calls.find((c: any) => c[0] === 'flushdb')).toBeUndefined();
    expect(client.calls.filter((c: any) => c[0] === 'scan')[0]).toEqual([
      'scan',
      '0',
      'MATCH',
      'moro:cache:*',
      'COUNT',
      500,
    ]);
  });

  it('clear() with an empty prefix flushes the database', async () => {
    const client = fakeIoredisClient();
    const cache = new RedisCacheAdapter({ client, keyPrefix: '' });
    await cache.set('x', 1);
    await cache.clear();
    expect(client.calls.find((c: any) => c[0] === 'flushdb')).toBeDefined();
    expect(client.store.size).toBe(0);
  });
});
