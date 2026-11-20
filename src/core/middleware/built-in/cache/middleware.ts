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
 *   key: 'my-route', // or a function of the request: req => `item:${req.params.id}`
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
    // Same lookup, key and storing rules as route-level .cache(): a hit has
    // answered, anything else continues down the chain.
    if (await sharedCacheCore.tryGet(req, res, config)) {
      return;
    }

    next();
  };
}
