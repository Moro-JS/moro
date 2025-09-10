"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisAdapter = void 0;
const logger_1 = require("../../logger");
class RedisAdapter {
    client;
    logger = (0, logger_1.createFrameworkLogger)('Redis');
    keyPrefix;
    constructor(config = {}) {
        try {
            const Redis = require('ioredis');
            this.keyPrefix = config.keyPrefix || 'moro:';
            if (config.cluster) {
                // Redis Cluster
                this.client = new Redis.Cluster(config.cluster.nodes, {
                    enableReadyCheck: config.cluster.enableReadyCheck || false,
                    redisOptions: config.cluster.redisOptions || {},
                });
            }
            else {
                // Single Redis instance
                this.client = new Redis({
                    host: config.host || 'localhost',
                    port: config.port || 6379,
                    password: config.password,
                    db: config.db || 0,
                    maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
                    retryDelayOnFailover: config.retryDelayOnFailover || 100,
                    lazyConnect: config.lazyConnect || true,
                });
            }
            this.client.on('error', (err) => {
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
        }
        catch (error) {
            throw new Error('ioredis package is required for Redis adapter. Install it with: npm install ioredis');
        }
    }
    prefixKey(key) {
        return `${this.keyPrefix}${key}`;
    }
    async connect() {
        try {
            await this.client.ping();
            this.logger.info('Redis connection established', 'Connection');
        }
        catch (error) {
            this.logger.error('Redis connection failed', 'Connection', {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async disconnect() {
        await this.client.quit();
    }
    // For Redis, we adapt the SQL-like interface to key-value operations
    async query(pattern, _params) {
        try {
            const keys = await this.client.keys(this.prefixKey(pattern));
            if (keys.length === 0)
                return [];
            const values = await this.client.mget(keys);
            return values.map((value, index) => ({
                key: keys[index].replace(this.keyPrefix, ''),
                value: value ? JSON.parse(value) : null,
            }));
        }
        catch (error) {
            this.logger.error('Redis query failed', 'Query', {
                pattern,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async queryOne(key, _params) {
        try {
            const value = await this.client.get(this.prefixKey(key));
            return value ? JSON.parse(value) : null;
        }
        catch (error) {
            this.logger.error('Redis queryOne failed', 'Query', {
                key,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async insert(key, data) {
        try {
            const value = JSON.stringify(data);
            await this.client.set(this.prefixKey(key), value);
            return data;
        }
        catch (error) {
            this.logger.error('Redis insert failed', 'Insert', {
                key,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async update(key, data, _where) {
        try {
            // For Redis, we'll merge with existing data if it exists
            const existing = await this.queryOne(key);
            const merged = existing ? { ...existing, ...data } : data;
            const value = JSON.stringify(merged);
            await this.client.set(this.prefixKey(key), value);
            return merged;
        }
        catch (error) {
            this.logger.error('Redis update failed', 'Update', {
                key,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async delete(pattern, _where) {
        try {
            const keys = await this.client.keys(this.prefixKey(pattern));
            if (keys.length === 0)
                return 0;
            const deletedCount = await this.client.del(...keys);
            return deletedCount;
        }
        catch (error) {
            this.logger.error('Redis delete failed', 'Delete', {
                pattern,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async transaction(callback) {
        const multi = this.client.multi();
        const transaction = new RedisTransaction(multi, this.keyPrefix);
        try {
            const result = await callback(transaction);
            await multi.exec();
            return result;
        }
        catch (error) {
            // Redis doesn't have rollback, but we can discard the multi
            multi.discard();
            throw error;
        }
    }
    // Redis-specific methods
    async set(key, value, ttl) {
        const prefixedKey = this.prefixKey(key);
        if (ttl) {
            await this.client.setex(prefixedKey, ttl, JSON.stringify(value));
        }
        else {
            await this.client.set(prefixedKey, JSON.stringify(value));
        }
    }
    async get(key) {
        const value = await this.client.get(this.prefixKey(key));
        return value ? JSON.parse(value) : null;
    }
    async exists(key) {
        const result = await this.client.exists(this.prefixKey(key));
        return result === 1;
    }
    async expire(key, ttl) {
        const result = await this.client.expire(this.prefixKey(key), ttl);
        return result === 1;
    }
    async incr(key) {
        return await this.client.incr(this.prefixKey(key));
    }
    async decr(key) {
        return await this.client.decr(this.prefixKey(key));
    }
    async hset(hash, field, value) {
        await this.client.hset(this.prefixKey(hash), field, JSON.stringify(value));
    }
    async hget(hash, field) {
        const value = await this.client.hget(this.prefixKey(hash), field);
        return value ? JSON.parse(value) : null;
    }
    async hgetall(hash) {
        const result = await this.client.hgetall(this.prefixKey(hash));
        const parsed = {};
        for (const [key, value] of Object.entries(result)) {
            parsed[key] = JSON.parse(value);
        }
        return parsed;
    }
    async lpush(list, ...values) {
        const serialized = values.map(v => JSON.stringify(v));
        return await this.client.lpush(this.prefixKey(list), ...serialized);
    }
    async rpop(list) {
        const value = await this.client.rpop(this.prefixKey(list));
        return value ? JSON.parse(value) : null;
    }
    async lrange(list, start, stop) {
        const values = await this.client.lrange(this.prefixKey(list), start, stop);
        return values.map((v) => JSON.parse(v));
    }
    async publish(channel, message) {
        return await this.client.publish(channel, JSON.stringify(message));
    }
    async subscribe(channel, callback) {
        const subscriber = this.client.duplicate();
        subscriber.subscribe(channel);
        subscriber.on('message', (_channel, message) => {
            callback(JSON.parse(message));
        });
    }
    getClient() {
        return this.client;
    }
}
exports.RedisAdapter = RedisAdapter;
class RedisTransaction {
    multi;
    keyPrefix;
    constructor(multi, keyPrefix) {
        this.multi = multi;
        this.keyPrefix = keyPrefix;
    }
    prefixKey(key) {
        return `${this.keyPrefix}${key}`;
    }
    async query(pattern, _params) {
        // Note: Redis transactions can't perform read operations during MULTI
        // This is a limitation of Redis transactions
        throw new Error('Redis transactions cannot perform read operations. Use regular operations instead.');
    }
    async queryOne(_key, _params) {
        throw new Error('Redis transactions cannot perform read operations. Use regular operations instead.');
    }
    async insert(key, data) {
        const value = JSON.stringify(data);
        this.multi.set(this.prefixKey(key), value);
        return data;
    }
    async update(key, data, _where) {
        const value = JSON.stringify(data);
        this.multi.set(this.prefixKey(key), value);
        return data;
    }
    async delete(pattern, _where) {
        this.multi.del(this.prefixKey(pattern));
        return 1; // We can't know the actual count in a transaction
    }
    async commit() {
        await this.multi.exec();
    }
    async rollback() {
        this.multi.discard();
    }
}
