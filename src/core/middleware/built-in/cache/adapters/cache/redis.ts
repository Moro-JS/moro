// Redis Cache Adapter (node-redis 4+)
//
// Targets the node-redis 4+ API: createClient({ url } | { socket }),
// an explicit connect(), and the SET ... PX form for TTLs. Every command
// awaits the connection first, so a call issued right after construction
// waits for the import + connect instead of racing them.
//
// A caller-supplied `client` may also be an ioredis client; the commands whose
// argument shape differs between the two libraries (SET with a TTL, SCAN) are
// issued in the form the client understands.
//
// An unreachable server never holds a caller for longer than
// UNAVAILABLE_WAIT_MS: a command issued while the client is not connected
// waits that long for the connection and is then answered as the miss every
// method already returns on error. The client keeps reconnecting on its own,
// and commands go straight through again once it is back.
import { CacheAdapter } from '../../../../../../types/cache.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';
import { resolveUserPackage } from '../../../../../utilities/package-utils.js';
import { redisClientFlavour } from '../../../../../utilities/redis-client.js';
import { keyTag } from './log-key.js';

const logger = createFrameworkLogger('RedisCacheAdapter');

/**
 * Longest a command waits for a client that is not connected. Matches the
 * connect and command timeouts node-redis itself defaults to where it has them.
 */
const UNAVAILABLE_WAIT_MS = 5000;

/** Rejects when `work` has not settled within UNAVAILABLE_WAIT_MS. */
function withinWait<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Redis ${what} did not complete within ${UNAVAILABLE_WAIT_MS} ms`));
    }, UNAVAILABLE_WAIT_MS);
    timer.unref?.();
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * What RedisCacheAdapter#read resolves to when the store could not be read,
 * for callers that must tell that apart from "the store has no such key" (the
 * session store does).
 */
export const READ_FAILED: unique symbol = Symbol('moro.cache.readFailed');

export interface RedisCacheOptions {
  /** redis[s]://[[user][:password]@]host[:port][/db] - wins over host/port */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /** Prepended to every key (default 'moro:cache:'); clear() only touches prefixed keys */
  keyPrefix?: string;
  /**
   * An existing node-redis (4+) or ioredis client. A node-redis client that is
   * not open is connected by the adapter; the client stays the caller's to close.
   */
  client?: any;
  /**
   * Log a short tag in place of each key. For stores whose keys are secrets:
   * the session middleware sets it on the store it uses, because a session id
   * in a log line is a session anyone reading the log can take over.
   */
  redactKeys?: boolean;
}

export class RedisCacheAdapter implements CacheAdapter {
  private client: any = null;
  /** The client while its first connection is still being established */
  private connecting: any = null;
  private readonly keyPrefix: string;
  private readonly ready: Promise<void>;
  private initError: Error | null = null;
  /** True when the adapter created the client and therefore owns its lifetime */
  private ownsClient = false;
  /** True for an ioredis client (positional command arguments) */
  private positionalArgs = false;
  private closed = false;
  /** Log a tag in place of each key (see RedisCacheOptions.redactKeys) */
  redactKeys: boolean;

  constructor(options: RedisCacheOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? 'moro:cache:';
    this.redactKeys = options.redactKeys === true;
    // The failure is kept and rethrown per call (each method logs and returns
    // its miss value); it must not surface as an unhandled rejection here.
    this.ready = this.initialize(options).catch((err: unknown) => {
      // A connection attempt that close() abandoned is not a failure to report
      if (this.closed) return;
      this.initError = err instanceof Error ? err : new Error(String(err));
      logger.error('Redis cache adapter failed to initialize', 'RedisCache', {
        error: this.initError.message,
      });
    });
  }

  private async initialize(options: RedisCacheOptions): Promise<void> {
    let client = options.client;
    if (!client) {
      this.ownsClient = true;
      let redis: any;
      try {
        redis = await import(resolveUserPackage('redis'));
      } catch {
        throw new Error('Redis package not installed. Run: npm install redis');
      }
      const createClient = redis.createClient ?? redis.default?.createClient;
      if (typeof createClient !== 'function') {
        throw new Error(
          'The installed "redis" package does not export createClient (node-redis 4+ required)'
        );
      }
      client = options.url
        ? createClient({ url: options.url })
        : createClient({
            socket: { host: options.host || 'localhost', port: options.port || 6379 },
            ...(options.password !== undefined && { password: options.password }),
            ...(options.db !== undefined && { database: options.db }),
          });
    }

    // Never let the client's own error events crash the process
    if (typeof client.on === 'function') {
      client.on('error', (err: Error) => {
        logger.error('Redis cache error', 'RedisCache', { error: err.message });
      });
    }
    this.positionalArgs = redisClientFlavour(client) === 'ioredis';

    // node-redis 4+ needs an explicit connect(); a caller-supplied client may
    // already be open (isOpen), and an ioredis client has no isOpen at all (it
    // connects by itself). connect() does not settle while the server is
    // unreachable: the client retries until it gets through.
    if (typeof client.connect === 'function' && client.isOpen === false) {
      this.connecting = client;
      await client.connect();
      this.connecting = null;
      if (this.closed) {
        // close() ran while the connection was being established
        if (this.ownsClient) await this.release(client);
        return;
      }
    }

    this.client = client;
    logger.info('Redis cache adapter initialized', 'RedisCache');
  }

  /**
   * The client, or a rejection: the initialization error, or a timeout when
   * the first connection is still not up after UNAVAILABLE_WAIT_MS. Returns
   * the client itself (no promise) once it is connected.
   */
  private connected(): any {
    if (this.client !== null) return this.client;
    return this.whenConnected();
  }

  private async whenConnected(): Promise<any> {
    if (!this.closed) await withinWait(this.ready, 'connection');
    if (this.initError) throw this.initError;
    return this.client;
  }

  /**
   * The result of a command. On a connected client that is the command's own
   * promise; while the client reports that it is not connected the wait is
   * bounded, because a client without a command timeout of its own queues the
   * command until the server is back.
   */
  private result<T>(client: any, command: Promise<T>): Promise<T> {
    const down = this.positionalArgs
      ? typeof client.status === 'string' && client.status !== 'ready'
      : client.isReady === false;
    return down ? withinWait(command, 'command') : command;
  }

  /** Close a client the adapter owns, connected or not. */
  private async release(client: any): Promise<void> {
    try {
      if (client.isReady === false) {
        // Not connected: QUIT would wait for the server. Drop the socket and
        // stop the reconnect timer instead (destroy() from node-redis 5,
        // disconnect() on 4).
        if (typeof client.destroy === 'function') client.destroy();
        else if (typeof client.disconnect === 'function') await client.disconnect();
      } else if (typeof client.quit === 'function') {
        await client.quit();
      } else if (typeof client.disconnect === 'function') {
        await client.disconnect();
      }
    } catch (error) {
      logger.error('Redis close error', 'RedisCache', { error });
    }
  }

  private key(key: string): string {
    return this.keyPrefix + key;
  }

  async get(key: string): Promise<any> {
    const value = await this.read(key);
    return value === READ_FAILED ? null : value;
  }

  /** The key as log lines show it */
  private logKey(key: string): string {
    return this.redactKeys ? keyTag(key) : key;
  }

  /**
   * get() for a caller that has to know when the store could not be read:
   * resolves to READ_FAILED in that case, and to null only when the key is
   * absent.
   */
  async read(key: string): Promise<any> {
    try {
      const client = await this.connected();
      const value = await this.result<string | null>(client, client.get(this.key(key)));
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error('Redis get error', 'RedisCache', { key: this.logKey(key), error });
      return READ_FAILED;
    }
  }

  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
    try {
      const client = await this.connected();
      const serialized = JSON.stringify(value);
      if (ttl > 0) {
        // PX keeps sub-second TTLs (EX rounds to whole seconds and rejects 0)
        const px = Math.max(1, Math.round(ttl * 1000));
        await this.result(
          client,
          this.positionalArgs
            ? client.set(this.key(key), serialized, 'PX', px)
            : client.set(this.key(key), serialized, { PX: px })
        );
      } else {
        await this.result(client, client.set(this.key(key), serialized));
      }
      logger.debug(`Cached item in Redis: ${this.logKey(key)} (TTL: ${ttl}s)`, 'RedisCache');
    } catch (error) {
      logger.error('Redis set error', 'RedisCache', { key: this.logKey(key), error });
    }
  }

  async del(key: string): Promise<void> {
    try {
      const client = await this.connected();
      await this.result(client, client.del(this.key(key)));
      logger.debug(`Deleted Redis cache item: ${this.logKey(key)}`, 'RedisCache');
    } catch (error) {
      logger.error('Redis del error', 'RedisCache', { key: this.logKey(key), error });
    }
  }

  /**
   * Remove this adapter's keys. With a prefix that is a SCAN over
   * `<prefix>*` (a shared Redis is not flushed wholesale); with an empty
   * prefix every key is this adapter's and FLUSHDB is the cheap equivalent.
   */
  async clear(): Promise<void> {
    try {
      const client = await this.connected();
      await this.result(client, this.removeAll(client));
      logger.debug('Cleared all Redis cache items', 'RedisCache');
    } catch (error) {
      logger.error('Redis clear error', 'RedisCache', { error });
    }
  }

  private async removeAll(client: any): Promise<void> {
    if (!this.keyPrefix) {
      await (client.flushDb ?? client.flushdb).call(client);
      return;
    }
    const match = `${this.keyPrefix}*`;
    const batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await client.del(batch.splice(0, batch.length));
    };
    if (this.positionalArgs) {
      // ioredis: SCAN cursor MATCH pattern COUNT n -> [nextCursor, keys]
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 500);
        cursor = String(next);
        batch.push(...keys);
        if (batch.length >= 500) await flush();
      } while (cursor !== '0');
    } else {
      for await (const item of client.scanIterator({ MATCH: match, COUNT: 500 })) {
        // node-redis 4 yields one key per iteration, 5 yields a page of keys
        if (Array.isArray(item)) batch.push(...item);
        else batch.push(item);
        if (batch.length >= 500) await flush();
      }
    }
    await flush();
  }

  async exists(key: string): Promise<boolean> {
    try {
      const client = await this.connected();
      const count = await this.result(client, client.exists(this.key(key)));
      return Number(count) > 0;
    } catch (error) {
      logger.error('Redis exists error', 'RedisCache', { key: this.logKey(key), error });
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      const client = await this.connected();
      return await this.result<number>(client, client.ttl(this.key(key)));
    } catch (error) {
      logger.error('Redis TTL error', 'RedisCache', { key: this.logKey(key), error });
      return -1;
    }
  }

  /**
   * Close the connection. A client the adapter created is quit (it would
   * otherwise keep the process alive); a caller-supplied client belongs to
   * its owner and is left open. Later calls answer as misses. A connection
   * that is still being established is abandoned, not waited for.
   */
  async close(): Promise<void> {
    // Nothing is connecting yet only while the driver import is in flight
    if (this.client === null && this.connecting === null && !this.closed) {
      await withinWait(this.ready, 'connection').catch(() => {});
    }
    const client = this.client ?? this.connecting;
    this.closed = true;
    this.client = null;
    this.connecting = null;
    this.initError = new Error('Redis cache adapter is closed');
    if (!client || !this.ownsClient) return;
    await this.release(client);
  }
}
