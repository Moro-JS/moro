// Database Redis Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { resolveUserPackage } from '../../utilities/package-utils.js';

interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  retryDelayOnFailover?: number;
  lazyConnect?: boolean;
  tls?: {
    rejectUnauthorized?: boolean;
    ca?: string;
    cert?: string;
    key?: string;
    passphrase?: string;
    servername?: string;
    checkServerIdentity?: boolean;
  };
  cluster?: {
    enableReadyCheck?: boolean;
    redisOptions?: any;
    nodes: Array<{ host: string; port: number }>;
  };
}

export class RedisAdapter implements DatabaseAdapter {
  private client: any;
  private logger = createFrameworkLogger('Redis');
  private keyPrefix: string;
  private initPromise: Promise<void>;

  constructor(config: RedisConfig = {}) {
    this.keyPrefix = config.keyPrefix || 'moro:';
    this.initPromise = this.initialize(config);
  }

  private async initialize(config: RedisConfig): Promise<void> {
    try {
      const ioredisPath = resolveUserPackage('ioredis');
      const ioredis = await import(ioredisPath);
      const Redis = ioredis.default;

      if (config.cluster) {
        // Redis Cluster
        const clusterOptions: any = {
          enableReadyCheck: config.cluster.enableReadyCheck || false,
          redisOptions: config.cluster.redisOptions || {},
        };

        // Add TLS options to cluster configuration
        if (config.tls) {
          clusterOptions.redisOptions.tls = { ...config.tls };
        }

        this.client = new Redis.Cluster(config.cluster.nodes, clusterOptions);
      } else {
        // Single Redis instance
        const redisOptions: any = {
          host: config.host || 'localhost',
          port: config.port || 6379,
          password: config.password,
          db: config.db || 0,
          maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
          retryDelayOnFailover: config.retryDelayOnFailover || 100,
          lazyConnect: config.lazyConnect || true,
        };

        // Add TLS options if provided
        if (config.tls) {
          redisOptions.tls = { ...config.tls };
        }

        this.client = new Redis(redisOptions);
      }

      this.client.on('error', (err: Error) => {
        this.logger.error('Redis client error', 'Redis', {
          error: err.message,
        });
      });

      this.client.on('connect', () => {
        this.logger.info('Redis connected', 'Connection');
      });

      this.client.on('disconnect', () => {
        this.logger.warn('Redis disconnected', 'Connection');
      });

      this.logger.info('Redis adapter initialized', 'Redis');
    } catch {
      throw new Error(
        'ioredis package is required for Redis adapter. Install it with: npm install ioredis'
      );
    }
  }

  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async connect(): Promise<void> {
    await this.initPromise;
    try {
      await this.client.ping();
      this.logger.info('Redis connection established', 'Connection');
    } catch (error) {
      this.logger.error('Redis connection failed', 'Connection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.initPromise;
    await this.client.quit();
  }

  // For Redis, we adapt the SQL-like interface to key-value operations
  async query<T = any>(pattern: string, _params?: any[]): Promise<T[]> {
    await this.initPromise;
    try {
      const keys = await this.client.keys(this.prefixKey(pattern));
      if (keys.length === 0) return [];

      const values = await this.client.mget(keys);
      return values.map((value: string, index: number) => ({
        key: keys[index].replace(this.keyPrefix, ''),
        value: value ? JSON.parse(value) : null,
      }));
    } catch (error) {
      this.logger.error('Redis query failed', 'Query', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async queryOne<T = any>(key: string, _params?: any[]): Promise<T | null> {
    await this.initPromise;
    try {
      const value = await this.client.get(this.prefixKey(key));
      return value ? JSON.parse(value) : null;
    } catch (error) {
      this.logger.error('Redis queryOne failed', 'Query', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async insert<T = any>(key: string, data: Record<string, any>): Promise<T> {
    await this.initPromise;
    try {
      const value = JSON.stringify(data);
      await this.client.set(this.prefixKey(key), value);
      return data as T;
    } catch (error) {
      this.logger.error('Redis insert failed', 'Insert', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async update<T = any>(
    key: string,
    data: Record<string, any>,
    _where?: Record<string, any>
  ): Promise<T> {
    await this.initPromise;
    try {
      // For Redis, we'll merge with existing data if it exists
      const existing = await this.queryOne(key);
      const merged = existing ? { ...existing, ...data } : data;
      const value = JSON.stringify(merged);
      await this.client.set(this.prefixKey(key), value);
      return merged as T;
    } catch (error) {
      this.logger.error('Redis update failed', 'Update', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async delete(pattern: string, _where?: Record<string, any>): Promise<number> {
    await this.initPromise;
    try {
      const keys = await this.client.keys(this.prefixKey(pattern));
      if (keys.length === 0) return 0;

      const deletedCount = await this.client.del(...keys);
      return deletedCount;
    } catch (error) {
      this.logger.error('Redis delete failed', 'Delete', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    await this.initPromise;
    const multi = this.client.multi();
    const transaction = new RedisTransaction(multi, this.keyPrefix);

    try {
      const result = await callback(transaction);
      await multi.exec();
      return result;
    } catch (error) {
      // Redis doesn't have rollback, but we can discard the multi
      multi.discard();
      throw error;
    }
  }

  // Redis-specific methods
  async set(key: string, value: any, ttl?: number): Promise<void> {
    await this.initPromise;
    const prefixedKey = this.prefixKey(key);
    if (ttl) {
      await this.client.setex(prefixedKey, ttl, JSON.stringify(value));
    } else {
      await this.client.set(prefixedKey, JSON.stringify(value));
    }
  }

  async get(key: string): Promise<any> {
    await this.initPromise;
    const value = await this.client.get(this.prefixKey(key));
    return value ? JSON.parse(value) : null;
  }

  async exists(key: string): Promise<boolean> {
    await this.initPromise;
    const result = await this.client.exists(this.prefixKey(key));
    return result === 1;
  }

  async expire(key: string, ttl: number): Promise<boolean> {
    await this.initPromise;
    const result = await this.client.expire(this.prefixKey(key), ttl);
    return result === 1;
  }

  async incr(key: string): Promise<number> {
    await this.initPromise;
    return await this.client.incr(this.prefixKey(key));
  }

  async decr(key: string): Promise<number> {
    await this.initPromise;
    return await this.client.decr(this.prefixKey(key));
  }

  async hset(hash: string, field: string, value: any): Promise<void> {
    await this.initPromise;
    await this.client.hset(this.prefixKey(hash), field, JSON.stringify(value));
  }

  async hget(hash: string, field: string): Promise<any> {
    await this.initPromise;
    const value = await this.client.hget(this.prefixKey(hash), field);
    return value ? JSON.parse(value) : null;
  }

  async hgetall(hash: string): Promise<Record<string, any>> {
    await this.initPromise;
    const result = await this.client.hgetall(this.prefixKey(hash));
    const parsed: Record<string, any> = {};
    for (const [key, value] of Object.entries(result)) {
      parsed[key] = JSON.parse(value as string);
    }
    return parsed;
  }

  async lpush(list: string, ...values: any[]): Promise<number> {
    await this.initPromise;
    const serialized = values.map(v => JSON.stringify(v));
    return await this.client.lpush(this.prefixKey(list), ...serialized);
  }

  async rpop(list: string): Promise<any> {
    await this.initPromise;
    const value = await this.client.rpop(this.prefixKey(list));
    return value ? JSON.parse(value) : null;
  }

  async lrange(list: string, start: number, stop: number): Promise<any[]> {
    await this.initPromise;
    const values = await this.client.lrange(this.prefixKey(list), start, stop);
    return values.map((v: string) => JSON.parse(v));
  }

  async publish(channel: string, message: any): Promise<number> {
    await this.initPromise;
    return await this.client.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    await this.initPromise;
    const subscriber = this.client.duplicate();
    subscriber.subscribe(channel);
    subscriber.on('message', (_channel: string, message: string) => {
      callback(JSON.parse(message));
    });
  }

  getClient() {
    return this.client;
  }
}

class RedisTransaction implements DatabaseTransaction {
  constructor(
    private multi: any,
    private keyPrefix: string
  ) {}

  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async query<T = any>(_pattern: string, _params?: any[]): Promise<T[]> {
    // Note: Redis transactions can't perform read operations during MULTI
    // This is a limitation of Redis transactions
    throw new Error(
      'Redis transactions cannot perform read operations. Use regular operations instead.'
    );
  }

  async queryOne<T = any>(_key: string, _params?: any[]): Promise<T | null> {
    throw new Error(
      'Redis transactions cannot perform read operations. Use regular operations instead.'
    );
  }

  async insert<T = any>(key: string, data: Record<string, any>): Promise<T> {
    const value = JSON.stringify(data);
    this.multi.set(this.prefixKey(key), value);
    return data as T;
  }

  async update<T = any>(
    key: string,
    data: Record<string, any>,
    _where?: Record<string, any>
  ): Promise<T> {
    const value = JSON.stringify(data);
    this.multi.set(this.prefixKey(key), value);
    return data as T;
  }

  async delete(pattern: string, _where?: Record<string, any>): Promise<number> {
    this.multi.del(this.prefixKey(pattern));
    return 1; // We can't know the actual count in a transaction
  }

  async commit(): Promise<void> {
    await this.multi.exec();
  }

  async rollback(): Promise<void> {
    this.multi.discard();
  }
}
