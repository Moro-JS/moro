// Leader election over Redis: with either client library exactly one of two
// instances leads, the lock expires on its own, a standby takes over when the
// leader goes away, and the lock is released on shutdown. A client that is
// neither library is refused when the election starts.
//
// `redis` and `ioredis` are optional peers and are not installed, so each
// instance gets a small client with that library's call shapes in front of a
// shared in-memory server that implements SET NX PX, GET and the two
// ownership scripts.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { LeaderElection } from '../../../../src/core/jobs/leader-election.js';
import {
  createFrameworkLogger,
  logger as globalLogger,
} from '../../../../src/core/logger/index.js';

const KEY = 'moro:jobs:leader:lock';

/** The server side: one keyspace with millisecond expiry. */
function createServer() {
  const entries = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    /** SET key value [PX ms] [NX]; anything the server is not sent does not apply. */
    set(key: string, value: string, flags: { px?: number; nx?: boolean }): 'OK' | null {
      if (flags.nx && live(key)) return null;
      entries.set(key, {
        value,
        expiresAt: flags.px === undefined ? null : Date.now() + flags.px,
      });
      return 'OK';
    },
    get: (key: string): string | null => live(key)?.value ?? null,
    /** PTTL: -2 no key, -1 no expiry */
    pttl(key: string): number {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : entry.expiresAt - Date.now();
    },
    /** The refresh / release scripts, told apart by the command they end in. */
    eval(script: string, keys: string[], args: string[]): number {
      const key = keys[0];
      // KEYS[1] is nil when no key reached the server: redis.call('GET', nil) fails
      if (key === undefined) throw new Error('ERR Lua redis lib command arguments must be strings');
      const current = live(key);
      if (!current) return 0;
      if (JSON.parse(current.value).instanceId !== args[0]) return 0;
      if (script.includes("'DEL'")) {
        entries.delete(key);
        return 1;
      }
      entries.set(key, { value: args[1], expiresAt: Date.now() + Number(args[2]) });
      return 1;
    },
  };
}

type Server = ReturnType<typeof createServer>;

/** node-redis 4+: `set(key, value, options)`, `eval(script, { keys, arguments })`. */
function nodeRedisClient(server: Server) {
  const client = {
    isOpen: true,
    connected: true,
    sendCommand() {},
    assertUp() {
      if (!client.connected) throw new Error('The client is closed');
    },
    // Extra positional arguments are not part of the signature and never
    // reach the server, exactly as with the real client
    async set(key: string, value: string, options?: { PX?: number; NX?: boolean }) {
      client.assertUp();
      const flags = options !== null && typeof options === 'object' ? options : {};
      return server.set(key, value, { px: flags.PX, nx: flags.NX });
    },
    async get(key: string) {
      client.assertUp();
      return server.get(key);
    },
    async eval(script: string, options?: { keys?: string[]; arguments?: string[] }) {
      client.assertUp();
      const call = options !== null && typeof options === 'object' ? options : {};
      for (const argument of call.arguments ?? []) {
        if (typeof argument !== 'string') {
          throw new TypeError('"arguments" must be of type "string | Buffer"');
        }
      }
      return server.eval(script, call.keys ?? [], call.arguments ?? []);
    },
  };
  return client;
}

/** ioredis: `set(key, value, 'PX', ms, 'NX')`, `eval(script, numKeys, ...keys, ...args)`. */
function ioredisClient(server: Server) {
  const client = {
    status: 'ready',
    connected: true,
    defineCommand() {},
    assertUp() {
      if (!client.connected) throw new Error('Connection is closed.');
    },
    async set(key: string, value: string, ...flags: Array<string | number | object>) {
      client.assertUp();
      if (flags.some(flag => typeof flag === 'object')) throw new Error('ERR syntax error');
      const px = flags.indexOf('PX');
      return server.set(key, value, {
        px: px === -1 ? undefined : Number(flags[px + 1]),
        nx: flags.includes('NX'),
      });
    },
    async get(key: string) {
      client.assertUp();
      return server.get(key);
    },
    async eval(script: string, numKeys: number, ...rest: Array<string | number>) {
      client.assertUp();
      if (typeof numKeys !== 'number') throw new Error('ERR value is not an integer');
      return server.eval(
        script,
        rest.slice(0, numKeys).map(String),
        rest.slice(numKeys).map(String)
      );
    },
  };
  return client;
}

const LOCK_TIMEOUT = 3000;
const HEARTBEAT = 1000;

describe('leader election over Redis', () => {
  const logger = createFrameworkLogger('TestLeaderElectionRedis');
  let elections: LeaderElection[] = [];

  const start = async (instanceId: string, redisClient: unknown) => {
    const election = new LeaderElection(logger, {
      strategy: 'redis',
      redisClient,
      lockTimeout: LOCK_TIMEOUT,
      heartbeatInterval: HEARTBEAT,
      instanceId,
    });
    elections.push(election);
    await election.start();
    return election;
  };

  afterEach(async () => {
    await Promise.all(elections.map(election => election.shutdown()));
    elections = [];
    jest.useRealTimers();
    globalLogger.setLevel('error');
  });

  describe.each([
    ['a node-redis client', nodeRedisClient],
    ['an ioredis client', ioredisClient],
  ])('with %s', (_label, createClient) => {
    it('elects exactly one of two instances and keeps it through its heartbeats', async () => {
      jest.useFakeTimers();
      const server = createServer();
      const a = await start('A', createClient(server));
      const b = await start('B', createClient(server));

      expect([a.isCurrentLeader(), b.isCurrentLeader()]).toEqual([true, false]);
      expect(JSON.parse(server.get(KEY) as string).instanceId).toBe('A');
      expect(server.pttl(KEY)).toBe(LOCK_TIMEOUT);

      // Several heartbeats and standby checks later nothing has changed hands
      await jest.advanceTimersByTimeAsync(HEARTBEAT * 6);
      expect([a.isCurrentLeader(), b.isCurrentLeader()]).toEqual([true, false]);
      expect(JSON.parse(server.get(KEY) as string).instanceId).toBe('A');
      expect(server.pttl(KEY)).toBeGreaterThan(0);
      expect(server.pttl(KEY)).toBeLessThanOrEqual(LOCK_TIMEOUT);
    });

    it('lets the standby take over once a vanished leader stops refreshing the lock', async () => {
      globalLogger.setLevel('fatal'); // the cut-off leader logs its failed heartbeat
      jest.useFakeTimers();
      const server = createServer();
      const leaderClient = createClient(server);
      const a = await start('A', leaderClient);
      const b = await start('B', createClient(server));
      await jest.advanceTimersByTimeAsync(HEARTBEAT * 2);
      expect([a.isCurrentLeader(), b.isCurrentLeader()]).toEqual([true, false]);

      leaderClient.connected = false; // crashed: no release, the lock is left to expire
      await jest.advanceTimersByTimeAsync(LOCK_TIMEOUT + HEARTBEAT * 2);

      expect(a.isCurrentLeader()).toBe(false);
      expect(b.isCurrentLeader()).toBe(true);
      expect(JSON.parse(server.get(KEY) as string).instanceId).toBe('B');
    });

    it('releases the lock on shutdown, and only its own', async () => {
      const server = createServer();
      const a = await start('A', createClient(server));
      const b = await start('B', createClient(server));

      await b.shutdown(); // the standby must not remove the leader's lock
      expect(JSON.parse(server.get(KEY) as string).instanceId).toBe('A');

      await a.shutdown();
      expect(server.get(KEY)).toBeNull();
    });
  });

  it('refuses at start() a client that is neither node-redis nor ioredis', async () => {
    const calls: string[] = [];
    const unknownClient = {
      async set() {
        calls.push('set');
        return 'OK';
      },
      async get() {
        calls.push('get');
        return null;
      },
      async eval() {
        calls.push('eval');
        return 1;
      },
    };
    const election = new LeaderElection(logger, { strategy: 'redis', redisClient: unknownClient });
    elections.push(election);

    await expect(election.start()).rejects.toThrow(/node-redis \(4\+\) or ioredis client/);
    expect(election.isCurrentLeader()).toBe(false);
    expect(calls).toEqual([]);
  });
});
