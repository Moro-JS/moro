// Cache Core - Reusable caching logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('CacheCore');

// ===== Types =====

export interface CacheConfig {
  ttl: number;
  key?: string;
  tags?: string[];
}

interface CachedData {
  data: any;
  timestamp: number;
  ttl: number;
}

// ===== Core Logic =====

/**
 * CacheCore - Core caching logic
 * Used directly by the router for route-based caching
 * Can be instantiated for use in middleware or hooks
 */
export class CacheCore {
  private store = new Map<string, CachedData>();

  /**
   * High-level method for router use: tryGet(req, res, config)
   * Returns true if cache hit (response sent), false if cache miss (continue)
   */
  async tryGet(req: HttpRequest, res: HttpResponse, config: CacheConfig): Promise<boolean> {
    // Don't attempt caching if headers already sent
    if (res.headersSent) {
      return true; // Return true to stop execution
    }

    // Only cache GET requests
    if (req.method !== 'GET') {
      return false;
    }

    const cacheKey = config.key || `${req.method}:${req.path}:${JSON.stringify(req.query || {})}`;
    const cached = this.get(cacheKey);

    if (cached !== undefined) {
      res.setHeader('X-Cache', 'HIT');
      res.json(cached);
      return true; // Cache hit, response sent
    }

    // Cache miss - set up response interception for caching
    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = (data: any) => {
      this.set(cacheKey, data, config.ttl);

      if (config.tags && config.tags.length > 0) {
        res.setHeader('X-Cache-Tags', config.tags.join(','));
      }

      return originalJson(data);
    };

    return false; // Cache miss, continue
  }

  /**
   * Low-level get method
   * Returns cached data if valid, undefined if not found or expired
   */
  get(key: string): any | undefined {
    const cached = this.store.get(key);
    if (!cached) {
      return undefined;
    }

    const now = Date.now();
    if (now - cached.timestamp >= cached.ttl * 1000) {
      this.store.delete(key);
      return undefined;
    }

    logger.debug('Cache hit', 'Cache', { key });
    return cached.data;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, data: any, ttl: number): void {
    this.store.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
    logger.debug('Response cached', 'Cache', { key, ttl });
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Delete a specific cache entry
   */
  delete(key: string): void {
    this.store.delete(key);
  }
}

// Shared instance for route-based caching
export const sharedCacheCore = new CacheCore();
