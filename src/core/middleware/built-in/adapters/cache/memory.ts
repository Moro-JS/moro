// Memory Cache Adapter
import { CacheAdapter } from '../../../../../types/cache';
import { createFrameworkLogger } from '../../../../logger';

const logger = createFrameworkLogger('MemoryCacheAdapter');

export class MemoryCacheAdapter implements CacheAdapter {
  private cache = new Map<string, { value: any; expires: number }>();
  private timers = new Map<string, NodeJS.Timeout>();

  async get(key: string): Promise<any> {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expires) {
      await this.del(key);
      return null;
    }

    return item.value;
  }

  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
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

  async del(key: string): Promise<void> {
    this.cache.delete(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    logger.debug(`Deleted cache item: ${key}`, 'MemoryCache');
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    logger.debug('Cleared all cache items', 'MemoryCache');
  }

  async exists(key: string): Promise<boolean> {
    return this.cache.has(key) && Date.now() <= this.cache.get(key)!.expires;
  }

  async ttl(key: string): Promise<number> {
    const item = this.cache.get(key);
    if (!item) return -1;

    const remaining = Math.floor((item.expires - Date.now()) / 1000);
    return remaining > 0 ? remaining : -1;
  }
}
