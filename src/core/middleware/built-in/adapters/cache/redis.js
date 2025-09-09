"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCacheAdapter = void 0;
const logger_1 = require("../../../../logger");
const logger = (0, logger_1.createFrameworkLogger)("RedisCacheAdapter");
class RedisCacheAdapter {
    client;
    constructor(options = {}) {
        try {
            const redis = require("redis");
            this.client = redis.createClient({
                host: options.host || "localhost",
                port: options.port || 6379,
                password: options.password,
                db: options.db || 0,
                key_prefix: options.keyPrefix || "moro:cache:",
            });
            this.client.on("error", (err) => {
                logger.error("Redis cache error", "RedisCache", { error: err.message });
            });
            logger.info("Redis cache adapter initialized", "RedisCache");
        }
        catch (error) {
            logger.error("Redis not available, falling back to memory cache", "RedisCache");
            throw new Error("Redis package not installed. Run: npm install redis");
        }
    }
    async get(key) {
        try {
            const value = await this.client.get(key);
            return value ? JSON.parse(value) : null;
        }
        catch (error) {
            logger.error("Redis get error", "RedisCache", { key, error });
            return null;
        }
    }
    async set(key, value, ttl = 3600) {
        try {
            const serialized = JSON.stringify(value);
            if (ttl > 0) {
                await this.client.setex(key, ttl, serialized);
            }
            else {
                await this.client.set(key, serialized);
            }
            logger.debug(`Cached item in Redis: ${key} (TTL: ${ttl}s)`, "RedisCache");
        }
        catch (error) {
            logger.error("Redis set error", "RedisCache", { key, error });
        }
    }
    async del(key) {
        try {
            await this.client.del(key);
            logger.debug(`Deleted Redis cache item: ${key}`, "RedisCache");
        }
        catch (error) {
            logger.error("Redis del error", "RedisCache", { key, error });
        }
    }
    async clear() {
        try {
            await this.client.flushdb();
            logger.debug("Cleared all Redis cache items", "RedisCache");
        }
        catch (error) {
            logger.error("Redis clear error", "RedisCache", { error });
        }
    }
    async exists(key) {
        try {
            const exists = await this.client.exists(key);
            return exists === 1;
        }
        catch (error) {
            logger.error("Redis exists error", "RedisCache", { key, error });
            return false;
        }
    }
    async ttl(key) {
        try {
            return await this.client.ttl(key);
        }
        catch (error) {
            logger.error("Redis TTL error", "RedisCache", { key, error });
            return -1;
        }
    }
}
exports.RedisCacheAdapter = RedisCacheAdapter;
