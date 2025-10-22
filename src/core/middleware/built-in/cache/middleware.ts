// Cache Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { sharedCacheCore, type CacheConfig } from './core.js';

/**
 * Create cache middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const cacheMw = createCacheMiddleware({
 *   ttl: 60,
 *   key: 'my-route',
 *   tags: ['api', 'users']
 * });
 *
 * app.use(cacheMw);
 * ```
 */
export function createCacheMiddleware(config: CacheConfig): StandardMiddleware {
  if (!config || !config.ttl) {
    return (_req, _res, next) => next();
  }

  return async (req: any, res: any, next: () => void) => {
    if (req.method !== 'GET') {
      next();
      return;
    }

    const cacheKey = config.key || `${req.method}:${req.path}:${JSON.stringify(req.query || {})}`;

    const cached = sharedCacheCore.get(cacheKey);
    if (cached !== undefined) {
      res.setHeader('X-Cache', 'HIT');
      res.json(cached);
      return;
    }

    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = (data: any) => {
      sharedCacheCore.set(cacheKey, data, config.ttl);

      if (config.tags && config.tags.length > 0) {
        res.setHeader('X-Cache-Tags', config.tags.join(','));
      }

      return originalJson(data);
    };

    next();
  };
}
