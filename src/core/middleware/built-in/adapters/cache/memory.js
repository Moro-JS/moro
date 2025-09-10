"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryCacheAdapter = void 0;
const logger_1 = require("../../../../logger");
const logger = (0, logger_1.createFrameworkLogger)('MemoryCacheAdapter');
class MemoryCacheAdapter {
    cache = new Map();
    timers = new Map();
    async get(key) {
        const item = this.cache.get(key);
        if (!item)
            return null;
        if (Date.now() > item.expires) {
            await this.del(key);
            return null;
        }
        return item.value;
    }
    async set(key, value, ttl = 3600) {
        const expires = Date.now() + ttl * 1000;
        // Clear existing timer
        const existingTimer = this.timers.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        // Set new value
        this.cache.set(key, { value, expires });
        // Set expiration timer
        const timer = setTimeout(() => {
            this.cache.delete(key);
            this.timers.delete(key);
        }, ttl * 1000);
        this.timers.set(key, timer);
        logger.debug(`Cached item: ${key} (TTL: ${ttl}s)`, 'MemoryCache');
    }
    async del(key) {
        this.cache.delete(key);
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
        logger.debug(`Deleted cache item: ${key}`, 'MemoryCache');
    }
    async clear() {
        this.cache.clear();
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
        logger.debug('Cleared all cache items', 'MemoryCache');
    }
    async exists(key) {
        return this.cache.has(key) && Date.now() <= this.cache.get(key).expires;
    }
    async ttl(key) {
        const item = this.cache.get(key);
        if (!item)
            return -1;
        const remaining = Math.floor((item.expires - Date.now()) / 1000);
        return remaining > 0 ? remaining : -1;
    }
}
exports.MemoryCacheAdapter = MemoryCacheAdapter;
