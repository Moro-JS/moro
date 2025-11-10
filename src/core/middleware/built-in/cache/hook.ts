// Cache Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { CacheAdapter, CacheOptions, CachedResponse } from '../../../../types/cache.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { createCacheAdapter } from '../cache/adapters/cache/index.js';

/**
 * LRU Cache for ETag storage (massive performance gain for repeated responses)
 */
class ETagCache {
  private cache = new Map<string, { etag: string; lastModified: string; size: number }>();
  private readonly maxSize: number;
  private readonly ttl: number;

  constructor(maxSize = 10000, ttlMs = 3600000) {
    // 1 hour default TTL
    this.maxSize = maxSize;
    this.ttl = ttlMs;
  }

  get(key: string): { etag: string; lastModified: string; size: number } | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    const age = Date.now() - new Date(entry.lastModified).getTime();
    if (age > this.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  set(key: string, etag: string, size: number): void {
    // Evict oldest entries if cache is too large
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      etag,
      lastModified: new Date().toUTCString(),
      size,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Global ETag cache instance
const etagCache = new ETagCache();

const logger = createFrameworkLogger('CacheMiddleware');

/**
 * Advanced cache hook with pluggable storage adapters and HTTP caching
 * Registers with the hooks system for global usage
 *
 * @example
 * ```ts
 * import { cache } from '@/middleware/built-in/cache';
 *
 * // Server-side caching with Redis
 * app.use(cache({
 *   adapter: 'redis',
 *   defaultTtl: 3600,
 *   strategies: {
 *     '/api/.*': { ttl: 60 }
 *   }
 * }));
 *
 * // HTTP caching with ETags and conditional requests
 * app.use(cache({
 *   httpCaching: true,
 *   maxAge: 300,
 *   etag: 'strong',
 *   conditionalRequests: true
 * }));
 *
 * // Combined server-side + HTTP caching
 * app.use(cache({
 *   adapter: 'memory',
 *   defaultTtl: 3600,
 *   httpCaching: true,
 *   maxAge: 300,
 *   strategies: {
 *     '/api/users': { ttl: 300, maxAge: 60 },
 *     '/api/posts': { ttl: 1800, maxAge: 300 }
 *   }
 * }));
 *
 * // Redis server-side caching only
 * app.use(cache({
 *   adapter: 'redis',
 *   defaultTtl: 3600,
 *   httpCaching: false, // Disable HTTP caching
 *   strategies: { '/api/.*': { ttl: 60 } }
 * }));
 *
 * // HTTP caching only (no server-side storage)
 * app.use(cache({
 *   httpCaching: true,
 *   maxAge: 300,
 *   etag: 'strong',
 *   vary: ['Accept-Language', 'User-Agent']
 * }));
 * ```
 */
export const cache = (options: CacheOptions = {}): MiddlewareInterface => ({
  name: 'cache',
  version: '1.0.0',
  metadata: {
    name: 'cache',
    version: '1.0.0',
    description: 'Built-in cache middleware with pluggable storage adapters',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, _middlewareOptions: any = {}) => {
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

      // HTTP CACHING - ETags, Conditional Requests, Cache Headers
      if (options.httpCaching !== false) {
        const httpCachingOptions = {
          maxAge: options.maxAge || 300,
          cacheControl: options.cacheControl,
          vary: options.vary,
          etag: options.etag !== false ? (options.etag === 'weak' ? 'weak' : 'strong') : false,
          conditionalRequests: options.conditionalRequests !== false,
          generateETag: options.generateETag,
        };

        // Generate ETag with caching for performance
        const generateETagCached = (content: string, type: 'strong' | 'weak' = 'strong') => {
          if (options.generateETag) {
            return options.generateETag(content, type);
          }

          // Create cache key
          const cacheKey = `${type}:${content}`;

          // Check cache first (massive performance gain)
          const cached = etagCache.get(cacheKey);
          if (cached) {
            return cached.etag;
          }

          // Generate ETag using fast hash
          let hash = 0;
          for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash + char) & 0xffffffff;
          }

          const etagHash = Math.abs(hash).toString(36).substring(0, 16);
          const prefix = type === 'weak' ? 'W/' : '';
          const etag = `${prefix}"${etagHash}"`;

          // Cache the result
          etagCache.set(cacheKey, etag, content.length);

          return etag;
        };

        // Set HTTP cache headers
        if (httpCachingOptions.cacheControl) {
          res.setHeader('Cache-Control', httpCachingOptions.cacheControl);
        } else if (httpCachingOptions.maxAge && httpCachingOptions.maxAge > 0) {
          res.setHeader('Cache-Control', `public, max-age=${httpCachingOptions.maxAge}`);
        }

        // Set Vary header for proper caching
        if (httpCachingOptions.vary && httpCachingOptions.vary.length > 0) {
          res.setHeader('Vary', httpCachingOptions.vary.join(', '));
        }

        // Wrap response methods to add HTTP caching
        const originalJson = res.json;
        const originalSend = res.send;
        const originalEnd = res.end;

        // Handle ETags and conditional requests
        const handleHttpCaching = (content: string, _contentType?: string) => {
          if (res.headersSent || !httpCachingOptions.etag) return;

          // Generate ETag
          const etagValue = generateETagCached(
            content,
            httpCachingOptions.etag as 'strong' | 'weak'
          );
          res.setHeader('ETag', etagValue);

          // Handle conditional requests
          if (httpCachingOptions.conditionalRequests) {
            const ifNoneMatch = req.headers['if-none-match'];
            if (ifNoneMatch && (ifNoneMatch === etagValue || ifNoneMatch === '*')) {
              res.status(304).end();
              return true; // Request handled
            }

            // Handle If-Modified-Since for static content
            const lastModified = res.getHeader('Last-Modified') || new Date().toUTCString();
            const ifModifiedSince = req.headers['if-modified-since'];

            if (ifModifiedSince && new Date(ifModifiedSince) >= new Date(lastModified)) {
              res.status(304).end();
              return true; // Request handled
            }

            // Set Last-Modified if not already set
            if (!res.getHeader('Last-Modified')) {
              res.setHeader('Last-Modified', lastModified);
            }
          }

          return false; // Continue with normal response
        };

        // Override response methods
        res.json = function (data: any) {
          const content = JSON.stringify(data);
          if (!handleHttpCaching(content, 'application/json')) {
            return originalJson.call(this, data);
          }
        };

        res.send = function (data: any) {
          const content = typeof data === 'string' ? data : JSON.stringify(data);
          if (!handleHttpCaching(content)) {
            return originalSend.call(this, data);
          }
        };

        res.end = function (data?: any) {
          if (data && typeof data === 'string') {
            handleHttpCaching(data);
          }
          return originalEnd.call(this, data);
        };

        // Add convenience methods
        res.setCacheHeaders = (
          cacheOptions: {
            maxAge?: number;
            cacheControl?: string;
            vary?: string[];
            lastModified?: string;
          } = {}
        ) => {
          const {
            maxAge: headerMaxAge,
            cacheControl: headerCacheControl,
            vary: headerVary,
            lastModified,
          } = cacheOptions;

          if (headerCacheControl && !res.headersSent) {
            res.setHeader('Cache-Control', headerCacheControl);
          } else if (headerMaxAge && !res.headersSent) {
            res.setHeader('Cache-Control', `public, max-age=${headerMaxAge}`);
          }

          if (headerVary && headerVary.length > 0 && !res.headersSent) {
            res.setHeader('Vary', headerVary.join(', '));
          }

          if (lastModified && !res.headersSent) {
            res.setHeader('Last-Modified', lastModified);
          }

          return res;
        };

        // Legacy ETag method for backward compatibility
        if (httpCachingOptions.etag) {
          res.generateETag = (content: string | Buffer) => {
            const contentStr = typeof content === 'string' ? content : content.toString();
            return generateETagCached(contentStr, httpCachingOptions.etag as 'strong' | 'weak');
          };
        }
      }
    });

    logger.info('Cache middleware installed', 'Installation', {
      adapter: typeof options.adapter === 'string' ? options.adapter : 'custom',
      strategies: Object.keys(options.strategies || {}).length,
    });
  },
});
