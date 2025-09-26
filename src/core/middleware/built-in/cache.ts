// Built-in Cache Middleware
import { MiddlewareInterface, HookContext } from '../../../types/hooks';
import { CacheAdapter, CacheOptions, CachedResponse } from '../../../types/cache';
import { createFrameworkLogger } from '../../logger';
import { createCacheAdapter } from './adapters/cache';

const logger = createFrameworkLogger('CacheMiddleware');

export const cache = (options: CacheOptions = {}): MiddlewareInterface => ({
  name: 'cache',
  version: '1.0.0',
  metadata: {
    name: 'cache',
    version: '1.0.0',
    description: 'Built-in cache middleware with pluggable storage adapters',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing cache middleware', 'Installation');

    // Initialize storage adapter
    let storageAdapter: CacheAdapter;

    if (options.adapter && typeof options.adapter === 'object' && 'get' in options.adapter) {
      storageAdapter = options.adapter as CacheAdapter;
    } else if (typeof options.adapter === 'string') {
      storageAdapter = createCacheAdapter(options.adapter, options.adapterOptions);
    } else {
      // Default to memory cache
      storageAdapter = createCacheAdapter('memory');
    }

    // Cache key generation
    const generateCacheKey = (req: any, strategy?: any): string => {
      const prefix = options.keyPrefix || 'moro:cache:';

      if (strategy?.key) {
        return `${prefix}${strategy.key(req)}`;
      }

      // Default key: method + path + query
      const query = new URLSearchParams(req.query || {}).toString();
      return `${prefix}${req.method}:${req.path}${query ? `?${query}` : ''}`;
    };

    // Find matching strategy
    const findStrategy = (req: any): any | undefined => {
      if (!options.strategies) return undefined;

      for (const [pattern, strategy] of Object.entries(options.strategies)) {
        const regex = new RegExp(pattern);
        if (regex.test(req.path)) {
          return strategy;
        }
      }

      return undefined;
    };

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Only cache GET requests by default
      if (req.method !== 'GET') {
        return;
      }

      const strategy = findStrategy(req);
      const cacheKey = generateCacheKey(req, strategy);

      // Check if caching is disabled for this request
      if (strategy?.condition && !strategy.condition(req, res)) {
        return;
      }

      try {
        // Try to get from cache
        const cachedResponse = await storageAdapter.get(cacheKey);

        if (cachedResponse) {
          logger.debug(`Cache hit: ${cacheKey}`, 'CacheHit');

          // Set cache headers
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('X-Cache-Key', cacheKey);

          // Set HTTP cache headers
          if (options.maxAge) {
            res.setHeader('Cache-Control', `public, max-age=${options.maxAge}`);
          }

          if (options.vary && options.vary.length > 0) {
            res.setHeader('Vary', options.vary.join(', '));
          }

          // Send cached response
          res.status(cachedResponse.status || 200);

          // Set cached headers
          if (cachedResponse.headers) {
            Object.entries(cachedResponse.headers).forEach(([key, value]) => {
              res.setHeader(key, value as string);
            });
          }

          if (cachedResponse.contentType) {
            res.setHeader('Content-Type', cachedResponse.contentType);
          }

          res.send(cachedResponse.body);

          // Mark as handled
          (context as any).handled = true;
          return;
        }

        logger.debug(`Cache miss: ${cacheKey}`, 'CacheMiss');
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Cache-Key', cacheKey);
      } catch (error) {
        logger.error('Cache retrieval error', 'CacheError', {
          error,
          key: cacheKey,
        });
      }

      // Store original response methods
      const originalJson = res.json;
      const originalSend = res.send;
      const originalEnd = res.end;

      // Wrap response methods to cache the response
      const cacheResponse = async (body: any, contentType?: string) => {
        try {
          const ttl = strategy?.ttl || options.defaultTtl || 3600;

          const cacheData: CachedResponse = {
            body,
            status: res.statusCode,
            headers: res.getHeaders ? res.getHeaders() : {},
            contentType: contentType || res.getHeader('Content-Type'),
            timestamp: Date.now(),
          };

          await storageAdapter.set(cacheKey, cacheData, ttl);
          logger.debug(`Response cached: ${cacheKey} (TTL: ${ttl}s)`, 'CacheSet');
        } catch (error) {
          logger.error('Cache storage error', 'CacheError', {
            error,
            key: cacheKey,
          });
        }
      };

      // Override response methods
      res.json = function (data: any) {
        cacheResponse(data, 'application/json');
        return originalJson.call(this, data);
      };

      res.send = function (data: any) {
        cacheResponse(data);
        return originalSend.call(this, data);
      };

      res.end = function (data?: any) {
        if (data) {
          cacheResponse(data);
        }
        return originalEnd.call(this, data);
      };

      // Add cache control methods
      res.cacheControl = (directives: any) => {
        const parts: string[] = [];

        if (directives.public) parts.push('public');
        if (directives.private) parts.push('private');
        if (directives.noCache) parts.push('no-cache');
        if (directives.noStore) parts.push('no-store');
        if (directives.mustRevalidate) parts.push('must-revalidate');
        if (directives.immutable) parts.push('immutable');

        if (typeof directives.maxAge === 'number') parts.push(`max-age=${directives.maxAge}`);
        if (typeof directives.staleWhileRevalidate === 'number') {
          parts.push(`stale-while-revalidate=${directives.staleWhileRevalidate}`);
        }

        if (!res.headersSent) {
          res.setHeader('Cache-Control', parts.join(', '));
        }
        return res;
      };

      // Add ETag generation
      if (options.etag !== false) {
        res.generateETag = (content: string | Buffer) => {
          const crypto = require('crypto');
          const hash = crypto.createHash('md5').update(content).digest('hex');
          const prefix = options.etag === 'weak' ? 'W/' : '';
          return `${prefix}"${hash}"`;
        };
      }
    });

    logger.info('Cache middleware installed', 'Installation', {
      adapter: typeof options.adapter === 'string' ? options.adapter : 'custom',
      strategies: Object.keys(options.strategies || {}).length,
    });
  },
});
