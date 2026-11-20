// Cache Hook - MiddlewareInterface for global registration
import crypto from 'crypto';
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { CacheAdapter, CacheOptions, CachedResponse } from '../../../../types/cache.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { createCacheAdapter } from '../cache/adapters/cache/index.js';
import { authorityOf } from './core.js';

const hashOnce: ((algorithm: string, data: string, encoding: 'base64url') => string) | undefined =
  typeof (crypto as any).hash === 'function' ? (crypto as any).hash : undefined;

/** The first 128 bits of a body's SHA-256, as 22 base64url characters. */
function digestOf(content: string): string {
  const digest = hashOnce
    ? hashOnce('sha256', content, 'base64url')
    : crypto.createHash('sha256').update(content).digest('base64url');
  return digest.slice(0, 22);
}

// Hashing costs about half a microsecond per kilobyte, which is nothing for
// an ordinary JSON response and adds up for a large one that is sent again
// and again. Large bodies are therefore remembered with their digest, and a
// body that is byte-for-byte the one remembered (a string comparison, several
// times cheaper than the hash) takes the digest from there. One entry per
// body length, bounded in entries and in total characters held.
const ETAG_MEMO_MIN_LENGTH = 32 * 1024;
const ETAG_MEMO_MAX_ENTRIES = 32;
const ETAG_MEMO_MAX_CHARS = 4 * 1024 * 1024;
const etagMemo = new Map<number, { content: string; digest: string }>();
let etagMemoChars = 0;

function rememberedDigestOf(content: string): string {
  const length = content.length;
  const known = etagMemo.get(length);
  if (known !== undefined) {
    etagMemo.delete(length);
    if (known.content === content) {
      etagMemo.set(length, known); // most recently used
      return known.digest;
    }
    etagMemoChars -= length;
  }

  const digest = digestOf(content);
  if (length <= ETAG_MEMO_MAX_CHARS) {
    etagMemo.set(length, { content, digest });
    etagMemoChars += length;
    while (etagMemo.size > ETAG_MEMO_MAX_ENTRIES || etagMemoChars > ETAG_MEMO_MAX_CHARS) {
      const oldest = etagMemo.keys().next().value;
      if (oldest === undefined || oldest === length) break;
      etagMemo.delete(oldest);
      etagMemoChars -= oldest;
    }
  }
  return digest;
}

/**
 * The ETag of a response body: a digest of its content, so two bodies only
 * share a validator when they are the same bytes.
 */
function contentETag(content: string, type: 'strong' | 'weak'): string {
  const digest =
    content.length < ETAG_MEMO_MIN_LENGTH ? digestOf(content) : rememberedDigestOf(content);
  const tag = `"${digest}"`;
  return type === 'weak' ? `W/${tag}` : tag;
}

const logger = createFrameworkLogger('CacheMiddleware');

/**
 * Options of the global cache middleware: the shared `CacheOptions` plus the
 * spellings the documentation has always shown.
 */
export interface CacheMiddlewareOptions extends CacheOptions {
  /** Alias of `defaultTtl` (seconds). `defaultTtl` wins when both are given. */
  ttl?: number;
  /**
   * Alias of `adapter` for the built-in adapter names ('memory', 'redis',
   * 'file'). `adapter` wins when both are given.
   */
  strategy?: string;
  /**
   * Most responses the built-in memory adapter keeps; past it the least
   * recently used one leaves. Default 10,000. Other adapters bound themselves.
   */
  maxEntries?: number;
  /**
   * Request headers, besides `Authorization` and `Cookie`, that identify the
   * caller in this application (for example `['x-api-key']`). A request that
   * carries one is answered for that caller only: it is neither served from
   * the store nor stored, unless the matched strategy has a `key` of its own
   * or the header is also named in `varyBy`.
   */
  credentialHeaders?: string[];
  /**
   * Request headers that identify the caller and select the stored entry
   * (for example `['x-api-key']`): every distinct value gets an entry of its
   * own, and a request without the header shares the entry of the callers
   * without one. The value is hashed into the key, never written into it.
   *
   * A request that carries one of these headers is treated as one caller's:
   * its response is marked `private` for the caches downstream, and it is
   * stored even after the application has set `req.user`. Naming
   * `authorization` or `cookie` here keys such requests instead of bypassing
   * the store for them. The names are added to the `Vary` header beside those
   * of `vary`.
   */
  varyBy?: string[];
}

const KNOWN_OPTIONS = new Set([
  'adapter',
  'adapterOptions',
  'strategies',
  'defaultTtl',
  'keyPrefix',
  'httpCaching',
  'maxAge',
  'cacheControl',
  'staleWhileRevalidate',
  'vary',
  'etag',
  'conditionalRequests',
  'generateETag',
  'ttl',
  'strategy',
  'maxEntries',
  'credentialHeaders',
  'varyBy',
]);

const BUILT_IN_ADAPTERS = new Set(['memory', 'redis', 'file']);
const DEFAULT_MAX_ENTRIES = 10000;

/**
 * The options the middleware runs with: aliases folded into the names the
 * rest of the code reads, and one warning for anything that is not an option
 * at all (a misspelt key used to be dropped silently, leaving the defaults -
 * every GET cached for an hour - where the developer believed otherwise).
 */
function resolveOptions(input: CacheMiddlewareOptions): {
  options: CacheMiddlewareOptions;
  maxEntries: number;
} {
  const options: CacheMiddlewareOptions = { ...input };

  const unknown = Object.keys(options).filter(key => !KNOWN_OPTIONS.has(key));
  if (unknown.length > 0) {
    logger.warn(
      `Unknown cache option${unknown.length > 1 ? 's' : ''} ignored: ${unknown.join(', ')}`,
      'Options'
    );
  }

  if (options.defaultTtl === undefined && typeof options.ttl === 'number') {
    options.defaultTtl = options.ttl;
  }

  if (options.strategy !== undefined && options.adapter === undefined) {
    const name = typeof options.strategy === 'string' ? options.strategy.toLowerCase() : '';
    if (BUILT_IN_ADAPTERS.has(name)) {
      options.adapter = name;
    } else {
      logger.warn(
        `Unknown cache strategy ${JSON.stringify(options.strategy)} ignored; ` +
          `use adapter: 'memory' | 'redis' | 'file' or an adapter instance`,
        'Options'
      );
    }
  }

  const max = options.maxEntries;
  return {
    options,
    maxEntries: typeof max === 'number' && max > 0 ? Math.floor(max) : DEFAULT_MAX_ENTRIES,
  };
}

/**
 * Statuses whose response is never stored: an answer about one caller's
 * credentials or rate (401, 403, 407, 429) or a failure (5xx) must not be
 * replayed to the callers that follow.
 */
function isStorableStatus(status: number): boolean {
  return status !== 401 && status !== 403 && status !== 407 && status !== 429 && status < 500;
}

/** A response Cache-Control that forbids a shared store from keeping the response */
const NOT_SHAREABLE = /(?:^|[\s,])(?:private|no-store|no-cache)(?=$|[\s,=])/i;

/** Headers that belong to one exchange and are never stored or replayed */
function isPerExchangeHeader(lowerName: string): boolean {
  return lowerName === 'set-cookie' || lowerName === 'x-cache' || lowerName === 'x-cache-key';
}

/**
 * A stored response, with how its body reached the response: `json` is set
 * when it was handed to res.json(), so replay serializes it the same way.
 */
type StoredResponse = CachedResponse & { json?: boolean };

/**
 * A Buffer as it comes back from an adapter that keeps entries as JSON
 * (Redis, file): `{ type: 'Buffer', data: [...] }`.
 */
function isSerializedBuffer(body: any): body is { type: 'Buffer'; data: number[] } {
  return (
    body !== null && typeof body === 'object' && body.type === 'Buffer' && Array.isArray(body.data)
  );
}

/**
 * The response headers worth keeping with a stored response. `Set-Cookie`
 * never is: replaying it would hand the first caller's session to everyone
 * who is answered from the store.
 */
function storableHeaders(res: any): Record<string, any> {
  // Node and HTTP/2 responses have getHeaders(); the native engine keeps the
  // same object on responseHeaders.
  const raw: Record<string, any> | undefined =
    typeof res.getHeaders === 'function' ? res.getHeaders() : res.responseHeaders;
  const headers: Record<string, any> = {};
  if (raw) {
    for (const name of Object.keys(raw)) {
      if (isPerExchangeHeader(name.toLowerCase())) continue;
      headers[name] = raw[name];
    }
  }
  return headers;
}

/** The header names of an option that lists request headers: lower case, once each, sorted. */
function headerNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(name => String(name).trim().toLowerCase()))].filter(Boolean).sort();
}

/**
 * The query of a request as part of the default key. String values (what the
 * framework's own parser produces) are written as a query string; a value a
 * custom parser turned into an array or an object is written as JSON, so two
 * different values never read the same.
 */
function queryKeyOf(query: unknown): string {
  if (query === null || typeof query !== 'object') return '';
  const params = new URLSearchParams();
  for (const name of Object.keys(query)) {
    const value = (query as Record<string, unknown>)[name];
    params.append(name, typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
  }
  return params.toString();
}

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
export const cache = (input: CacheMiddlewareOptions = {}): MiddlewareInterface => {
  // Resolved once, when the middleware is created, so a misspelt option is
  // reported at startup and not on some later request.
  const { options, maxEntries } = resolveOptions(input || {});
  return createCacheHook(options, maxEntries);
};

const createCacheHook = (
  options: CacheMiddlewareOptions,
  maxEntries: number
): MiddlewareInterface => ({
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
      storageAdapter = createCacheAdapter(
        options.adapter,
        options.adapter.toLowerCase() === 'memory'
          ? { maxEntries, ...options.adapterOptions }
          : options.adapterOptions
      );
    } else {
      // Default to memory cache
      storageAdapter = createCacheAdapter('memory', { maxEntries });
    }

    // Headers named in `vary` select the stored entry as well as being
    // announced in the Vary header: a response is only replayed to a request
    // that sent the same values for them.
    const varyHeaders = headerNames(options.vary);
    const varySuffix = (req: any): string => {
      if (varyHeaders.length === 0) return '';
      let suffix = '|vary';
      for (const name of varyHeaders) {
        const value = req.headers?.[name];
        suffix += `|${name}=${encodeURIComponent(
          Array.isArray(value) ? value.join(',') : (value ?? '')
        )}`;
      }
      return suffix;
    };

    // Headers named in `varyBy` identify the caller. They select the entry
    // too, but through a digest: the value is a credential more often than
    // not, and the key is logged, sent back in X-Cache-Key and used as the
    // key in the store. A request that carries none of them has no suffix
    // and shares the entry of the callers without one.
    const callerHeaders = headerNames(options.varyBy);
    const callerSuffix = (req: any): string => {
      const headers = req.headers;
      if (callerHeaders.length === 0 || !headers) return '';
      let identity = '';
      for (const name of callerHeaders) {
        const value = headers[name];
        if (value === undefined) continue;
        identity += `${name}=${Array.isArray(value) ? value.join(',') : value}\n`;
      }
      return identity === '' ? '' : `|by|${digestOf(identity)}`;
    };
    // What goes out in Vary: the headers of both options
    const announcedVary =
      callerHeaders.length === 0
        ? options.vary
        : [...(options.vary ?? []), ...callerHeaders.filter(name => !varyHeaders.includes(name))];

    // What marks a request as one caller's own. Cookie counts: a session or
    // "remember me" cookie is how most applications know who is asking, and
    // this lookup runs before any of the application's middleware has looked.
    // A header also named in `varyBy` is keyed instead: the entry it selects
    // is that caller's own.
    const credentialHeaders = [
      ...new Set([
        'authorization',
        'cookie',
        ...(Array.isArray(options.credentialHeaders)
          ? options.credentialHeaders.map(name => String(name).trim().toLowerCase())
          : []),
      ]),
    ].filter(name => name !== '' && !callerHeaders.includes(name));
    const carriesCredentials = (req: any): boolean => {
      const headers = req.headers;
      if (!headers) return false;
      for (let i = 0; i < credentialHeaders.length; i++) {
        if (headers[credentialHeaders[i] as string] !== undefined) return true;
      }
      return false;
    };

    // Cache key generation
    const generateCacheKey = (req: any, strategy: any, caller: string): string => {
      const prefix = options.keyPrefix || 'moro:cache:';

      if (strategy?.key) {
        return `${prefix}${strategy.key(req)}${varySuffix(req)}${caller}`;
      }

      // Default key: method + host + path + query
      const query = queryKeyOf(req.query);
      return `${prefix}${req.method}:${authorityOf(req.headers)}${req.path}${query ? `?${query}` : ''}${varySuffix(req)}${caller}`;
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
      // Answered by a hook that ran before this one: nothing left to do
      if (res && res.headersSent) return;

      // Only cache GET requests by default
      if (req.method !== 'GET') {
        return;
      }

      const strategy = findStrategy(req);
      // Set when the request carries a header named in `varyBy`: the entry is
      // then this caller's own
      const caller = callerSuffix(req);
      const cacheKey = generateCacheKey(req, strategy, caller);

      // Check if caching is disabled for this request
      if (strategy?.condition && !strategy.condition(req, res)) {
        return;
      }

      // A request that carries credentials (Authorization, a Cookie, or a
      // header named in `credentialHeaders`) is answered for one caller: it is
      // neither served from the store nor stored. A strategy with a key
      // function of its own, or a header named in `varyBy`, is the developer
      // keying such requests on purpose.
      const keyedByStrategy = typeof strategy?.key === 'function';
      const bypass = !keyedByStrategy && carriesCredentials(req);
      const keyedOnPurpose = keyedByStrategy || caller !== '';

      // The Cache-Control this middleware puts on the response itself (set
      // further down); anything else found there at send time is the handler's.
      let ownCacheControl: string | undefined;

      if (bypass) {
        res.setHeader('X-Cache', 'BYPASS');
      } else {
        try {
          // Try to get from cache
          const cachedResponse: StoredResponse | null = await storageAdapter.get(cacheKey);

          if (cachedResponse) {
            logger.debug(`Cache hit: ${cacheKey}`, 'CacheHit');

            // Send cached response
            res.status(cachedResponse.status || 200);

            // Set cached headers
            if (cachedResponse.headers) {
              for (const name of Object.keys(cachedResponse.headers)) {
                // Also filtered here: an entry written by an earlier version
                // (Redis, file) may still hold them
                if (isPerExchangeHeader(name.toLowerCase())) continue;
                res.setHeader(name, cachedResponse.headers[name]);
              }
            }

            if (cachedResponse.contentType) {
              res.setHeader('Content-Type', cachedResponse.contentType);
            }

            // Set cache headers
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('X-Cache-Key', cacheKey);

            // A string or Buffer goes out as it was stored (a Buffer that an
            // adapter kept as JSON is made a Buffer again); anything else was
            // handed to res.json() and is serialized again the same way
            // (send() takes bytes only - an object there is an empty body).
            const body = cachedResponse.body;
            if (typeof body === 'string' || Buffer.isBuffer(body)) {
              res.send(body);
            } else if (cachedResponse.json !== true && isSerializedBuffer(body)) {
              res.send(Buffer.from(body.data));
            } else {
              res.json(body);
            }

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

        // json() and send() finish through end() on the Node backend, so one
        // response reaches here more than once: the first call has the body as
        // the handler gave it and decides.
        let decided = false;

        // Wrap response methods to cache the response
        const cacheResponse = async (body: any, contentType?: string, json = false) => {
          if (decided) return;
          decided = true;
          try {
            if (!isStorableStatus(res.statusCode)) return;

            // The application identified the caller while handling the
            // request (its auth middleware runs after this lookup): the
            // response is that caller's, whatever the request carried.
            if (!keyedOnPurpose && (req.user != null || req.auth?.user != null)) return;

            // The handler marked the response as not for a shared store
            const cacheControl = res.getHeader('Cache-Control');
            if (
              cacheControl !== undefined &&
              cacheControl !== ownCacheControl &&
              NOT_SHAREABLE.test(String(cacheControl))
            ) {
              return;
            }

            const ttl = strategy?.ttl || options.defaultTtl || 3600;

            const cacheData: StoredResponse = {
              body,
              status: res.statusCode,
              headers: storableHeaders(res),
              contentType: contentType || res.getHeader('Content-Type'),
              timestamp: Date.now(),
            };
            if (json) cacheData.json = true;

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
          void cacheResponse(data, 'application/json', true);
          return originalJson.call(this, data);
        };

        res.send = function (data: any) {
          void cacheResponse(data);
          return originalSend.call(this, data);
        };

        res.end = function (data?: any) {
          if (data) {
            void cacheResponse(data);
          }
          return originalEnd.call(this, data);
        };
      }

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
          vary: announcedVary,
          etag: options.etag !== false ? (options.etag === 'weak' ? 'weak' : 'strong') : false,
          conditionalRequests: options.conditionalRequests !== false,
          generateETag: options.generateETag,
        };

        // The response's ETag: the developer's generator, else a digest of the body
        const generateETagCached = (content: string, type: 'strong' | 'weak' = 'strong') => {
          if (options.generateETag) {
            return options.generateETag(content, type);
          }

          return contentETag(content, type);
        };

        // Set HTTP cache headers
        if (httpCachingOptions.cacheControl) {
          ownCacheControl = httpCachingOptions.cacheControl;
          res.setHeader('Cache-Control', ownCacheControl);
        } else if (httpCachingOptions.maxAge && httpCachingOptions.maxAge > 0) {
          // A response to a request that carried credentials is for that caller
          // only: `public` would tell every shared cache downstream (CDN,
          // proxy) that it may keep it and serve it to others.
          const scope =
            bypass || caller !== '' || req.headers?.authorization !== undefined
              ? 'private'
              : 'public';
          ownCacheControl = `${scope}, max-age=${httpCachingOptions.maxAge}`;
          res.setHeader('Cache-Control', ownCacheControl);
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

    const installation = {
      adapter: typeof options.adapter === 'string' ? options.adapter : 'custom',
      strategies: Object.keys(options.strategies || {}).length,
    };
    if (installation.strategies === 0 && callerHeaders.length === 0) {
      // Nothing narrows the cache: say what that means, once, where the
      // operator reads it. The store cannot see how a handler tells callers
      // apart when it is not by Cookie or Authorization.
      const others = credentialHeaders.slice(2);
      logger.info(
        `Cache middleware installed with no strategies and no varyBy: every GET response is ` +
          `stored for ${options.defaultTtl || 3600}s and replayed to any caller of the same ` +
          `host, path and query. Requests that carry Cookie or Authorization` +
          `${others.length > 0 ? ` (or ${others.join(', ')})` : ''} are never served from the ` +
          `store or stored, and nothing is stored once req.user is set or when the response ` +
          `says private or no-store. If a response depends on anything else about the caller ` +
          `(an API key header, the client address), name the header in varyBy or ` +
          `credentialHeaders, or give the paths a strategy with a key or a condition.`,
        'Installation',
        installation
      );
    } else {
      logger.info('Cache middleware installed', 'Installation', installation);
    }
  },
});
