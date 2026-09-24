// Redis Cache Adapter (node-redis 4+)
//
// Targets the node-redis v4/v5 API: createClient({ url } | { socket }),
// an explicit connect(), and the SET ... PX form for TTLs. Every command
// awaits the connection first, so a call issued right after construction
// waits for the import + connect instead of racing them.
import { CacheAdapter } from '../../../../../../types/cache.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';
import { resolveUserPackage } from '../../../../../utilities/package-utils.js';

const logger = createFrameworkLogger('RedisCacheAdapter');

export interface RedisCacheOptions {
  /** redis[s]://[[user][:password]@]host[:port][/db] - wins over host/port */
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  /** Prepended to every key (default 'moro:cache:'); clear() only touches prefixed keys */
  keyPrefix?: string;
  /** An existing node-redis client; the adapter connects it if it is not open */
  client?: any;
}

export class RedisCacheAdapter implements CacheAdapter {
  private client: any;
  private readonly keyPrefix: string;
  private readonly ready: Promise<void>;
  private initError: Error | null = null;
  /** True when the adapter created the client and therefore owns its lifetime */
  private ownsClient = false;

  constructor(options: RedisCacheOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? 'moro:cache:';
    // The failure is kept and rethrown per call (each method logs and returns
    // its miss value); it must not surface as an unhandled rejection here.
    this.ready = this.initialize(options).catch((err: unknown) => {
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
    // node-redis 4+ needs an explicit connect(); a caller-supplied client may
    // already be open (isOpen), and an ioredis-style client has no isOpen at all
    if (typeof client.connect === 'function' && client.isOpen === false) {
      await client.connect();
    }

    this.client = client;
    logger.info('Redis cache adapter initialized', 'RedisCache');
  }

  /** Resolves to the connected client, or throws the initialization error. */
  private async connected(): Promise<any> {
    await this.ready;
    if (this.initError) throw this.initError;
    return this.client;
  }

  private key(key: string): string {
    return this.keyPrefix + key;
  }

  async get(key: string): Promise<any> {
    try {
      const client = await this.connected();
      const value = await client.get(this.key(key));
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error('Redis get error', 'RedisCache', { key, error });
      return null;
    }
  }

  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
    try {
      const client = await this.connected();
      const serialized = JSON.stringify(value);
      if (ttl > 0) {
        // PX keeps sub-second TTLs (EX rounds to whole seconds and rejects 0)
        await client.set(this.key(key), serialized, { PX: Math.max(1, Math.round(ttl * 1000)) });
      } else {
        await client.set(this.key(key), serialized);
      }
      logger.debug(`Cached item in Redis: ${key} (TTL: ${ttl}s)`, 'RedisCache');
    } catch (error) {
      logger.error('Redis set error', 'RedisCache', { key, error });
    }
  }

  async del(key: string): Promise<void> {
    try {
      const client = await this.connected();
      await client.del(this.key(key));
      logger.debug(`Deleted Redis cache item: ${key}`, 'RedisCache');
    } catch (error) {
      logger.error('Redis del error', 'RedisCache', { key, error });
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
      if (!this.keyPrefix) {
        await (client.flushDb ?? client.flushdb).call(client);
      } else {
        const batch: string[] = [];
        const flush = async () => {
          if (batch.length === 0) return;
          await client.del(batch.splice(0, batch.length));
        };
        for await (const item of client.scanIterator({ MATCH: `${this.keyPrefix}*`, COUNT: 500 })) {
          // node-redis 4 yields one key per iteration, 5 yields a page of keys
          if (Array.isArray(item)) batch.push(...item);
          else batch.push(item);
          if (batch.length >= 500) await flush();
        }
        await flush();
      }
      logger.debug('Cleared all Redis cache items', 'RedisCache');
    } catch (error) {
      logger.error('Redis clear error', 'RedisCache', { error });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const client = await this.connected();
      const count = await client.exists(this.key(key));
      return Number(count) > 0;
    } catch (error) {
      logger.error('Redis exists error', 'RedisCache', { key, error });
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      const client = await this.connected();
      return await client.ttl(this.key(key));
    } catch (error) {
      logger.error('Redis TTL error', 'RedisCache', { key, error });
      return -1;
    }
  }

  /**
   * Close the connection. A client the adapter created is quit (it would
   * otherwise keep the process alive); a caller-supplied client belongs to
   * its owner and is left open. Later calls answer as misses.
   */
  async close(): Promise<void> {
    await this.ready;
    const client = this.client;
    this.client = null;
    this.initError = new Error('Redis cache adapter is closed');
    if (!client || !this.ownsClient) return;
    try {
      if (typeof client.quit === 'function') await client.quit();
      else if (typeof client.disconnect === 'function') await client.disconnect();
    } catch (error) {
      logger.error('Redis close error', 'RedisCache', { error });
    }
  }
}
