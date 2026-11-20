// Cache Core - Reusable caching logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('CacheCore');

// ===== Types =====

/**
 * HTTP Caching Options for Cache-Control, ETags, etc.
 */
export interface HttpCachingOptions {
  /** Enable HTTP caching headers (default: true) */
  httpCaching?: boolean;
  /** Default max-age for Cache-Control header (seconds) */
  maxAge?: number;
  /** Cache-Control header (overrides maxAge if provided) */
  cacheControl?: string;
  /** Vary header for proper caching */
  vary?: string[];
  /** Enable ETag generation (default: true) */
  etag?: boolean | 'strong' | 'weak';
  /** Enable conditional request handling (default: true) */
  conditionalRequests?: boolean;
  /** Custom ETag generator function */
  generateETag?: (content: string, type?: string) => string;
}

export interface CacheConfig extends HttpCachingOptions {
  /**
   * Seconds a stored response is served for. Left out on a route, the
   * lifetime is `modules.cache.defaultTtl` from the configuration.
   */
  ttl?: number;
  /**
   * The entry's key: a fixed string, or a function of the request. A key
   * given here is used exactly as given - nothing is added to it, so it must
   * itself tell apart every response that differs (per user, per parameter).
   * Left out, the key is method + host + path + query, plus the signed-in
   * user's id when there is one (see `shared`).
   */
  key?: string | ((req: HttpRequest) => string);
  tags?: string[];
  /**
   * The response is the same for every signed-in user, so one entry serves
   * them all. Without it a request with an authenticated user (`req.user` /
   * `req.auth.user`) gets an entry of its own, keyed by the user's `id`, and
   * is not cached at all when that user has no usable id or when the request
   * carries an `Authorization` header with no user object. A shared entry is
   * shared across host names too (the host is not part of its key): give the
   * route a `key` that includes `req.hostname` when the response differs by
   * host. Has no effect when `key` is given. Default false.
   */
  shared?: boolean;
}

export interface CacheCoreOptions {
  /**
   * Most entries kept at once; past it the least recently used entry leaves.
   * Default 5,000.
   */
  maxEntries?: number;
  /**
   * Lifetime in seconds of an entry whose configuration names no `ttl`.
   * Without it such an entry has no lifetime and stays until it is evicted.
   */
  defaultTtl?: number;
}

interface CachedData {
  data: any;
  timestamp: number;
  ttl: number;
  status: number;
}

const DEFAULT_MAX_ENTRIES = 5000;
/** Fewest inserts between two walks of the store for expired entries */
const MIN_SWEEP_INTERVAL = 256;

/**
 * Statuses whose response is never stored: an answer about one caller's
 * credentials or rate (401, 403, 407, 429) or a failure (5xx) must not be
 * replayed to the callers that follow.
 */
function isStorableStatus(status: number): boolean {
  return status !== 401 && status !== 403 && status !== 407 && status !== 429 && status < 500;
}

/**
 * The site a request is for, as part of a default cache key: the Host header,
 * and X-Forwarded-Host beside it when one was sent. An application may
 * answer for several host names (tenants on subdomains, a public and an
 * internal name), and a response that differs by host must not be replayed
 * under another. X-Forwarded-Host is kept apart from Host because a handler
 * that builds links from it would otherwise store, for everyone, whatever one
 * caller put there. Empty when the request names no host.
 */
export function authorityOf(headers: Record<string, unknown> | null | undefined): string {
  if (!headers) return '';
  const host = headers.host;
  const forwarded = headers['x-forwarded-host'];
  const authority = typeof host === 'string' ? host.toLowerCase() : '';
  return typeof forwarded === 'string' ? `${authority},${forwarded.toLowerCase()}` : authority;
}

/**
 * A request's headers when having them costs nothing: the engine's request
 * fetches its headers from native code the first time they are read, and
 * says whether that has happened; every other request carries them.
 */
function headersAtHand(req: HttpRequest): Record<string, unknown> | undefined {
  return '_headersIfRead' in req
    ? (req as { _headersIfRead?: Record<string, unknown> })._headersIfRead
    : req.headers;
}

/** method + host + path + query: the key of an entry that is not `shared`. */
function defaultKey(req: HttpRequest, headers: Record<string, unknown> | undefined): string {
  return `${req.method}:${authorityOf(headers)}${req.path}:${JSON.stringify(req.query || {})}`;
}

// ===== Core Logic =====

/**
 * CacheCore - Core caching logic
 * Used directly by the router for route-based caching
 * Can be instantiated for use in middleware or hooks
 */
export class CacheCore {
  // Insertion order doubles as recency order: a hit or a write moves the key
  // to the end, so the first key is always the least recently used one.
  private store = new Map<string, CachedData>();
  private maxEntries = DEFAULT_MAX_ENTRIES;
  private defaultTtl: number | undefined;
  private insertsSinceSweep = 0;
  private sweepAfter = MIN_SWEEP_INTERVAL;

  constructor(options: CacheCoreOptions = {}) {
    this.configure(options);
  }

  /**
   * Set the entry cap and the default lifetime again; an option left out goes
   * back to its default. Entries already held stay, down to the new cap: past
   * it the least recently used ones leave.
   */
  configure(options: CacheCoreOptions = {}): void {
    const max = options.maxEntries;
    this.maxEntries = typeof max === 'number' && max > 0 ? Math.floor(max) : DEFAULT_MAX_ENTRIES;
    const ttl = options.defaultTtl;
    this.defaultTtl = typeof ttl === 'number' && ttl >= 0 ? ttl : undefined;
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Entries currently held (expired ones included until they are read or swept). */
  get size(): number {
    return this.store.size;
  }

  /**
   * The key a request is cached under, or null when the request must not be
   * cached: a signed-in user without a usable id, an Authorization header
   * with no user to key on, or a key function that
   * threw or returned something other than a non-empty string or a number.
   */
  keyFor(req: HttpRequest, config: CacheConfig): string | null {
    const custom = config.key;
    if (typeof custom === 'function') {
      try {
        const key: unknown = custom(req);
        if (typeof key === 'string') return key !== '' ? key : null;
        return typeof key === 'number' && Number.isFinite(key) ? String(key) : null;
      } catch (error) {
        logger.warn('Cache key function threw; request not cached', 'Cache', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    if (typeof custom === 'string' && custom !== '') {
      return custom;
    }

    // `shared` is the route saying its response is the same for every
    // caller: one entry, whoever asks and under whichever host name. Nothing
    // of the request beyond the URL is read for it.
    if (config.shared === true) {
      return `${req.method}:${req.path}:${JSON.stringify(req.query || {})}`;
    }

    // Any other entry belongs to the host the request was sent to as well: an
    // application that answers for several host names (tenants on
    // subdomains) must not replay one host's response under another.

    // The auth phase runs before the cache phase, so a signed-in user is known
    // here. Their responses get entries of their own; the prefix cannot be
    // produced by the anonymous form, which always starts with the method.
    const user = req.user ?? req.auth?.user;
    if (user === undefined || user === null) {
      // No user object, but the request carries credentials: the handler may
      // be identifying the caller from the header itself. Such a response
      // cannot be told apart from the next caller's, so it is not cached
      // unless the route says it is `shared` or supplies its own `key`.
      // The headers are read for that check, so the host is at hand.
      const headers = req.headers;
      return headers?.authorization !== undefined ? null : defaultKey(req, headers);
    }
    const id = typeof user === 'object' ? (user as { id?: unknown }).id : undefined;
    if (typeof id === 'string' ? id !== '' : typeof id === 'number' && Number.isFinite(id)) {
      // Whatever identified the user from the request has read its headers.
      // Where nothing has (a user taken from the query string or the socket,
      // on the native engine), they are not fetched for the host alone.
      return `user:${JSON.stringify(id)}:${defaultKey(req, headersAtHand(req))}`;
    }
    // Someone is signed in but cannot be told apart from the next user:
    // sharing an entry would hand one user's response to another.
    return null;
  }

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

    const cacheKey = this.keyFor(req, config);
    if (cacheKey === null) {
      return false; // Not cacheable for this request, continue
    }

    const cached = this.getEntry(cacheKey);

    if (cached !== undefined) {
      res.setHeader('X-Cache', 'HIT');
      if (cached.status !== 200) res.status(cached.status);
      res.json(cached.data);
      return true; // Cache hit, response sent
    }

    // Cache miss - set up response interception for caching
    res.setHeader('X-Cache', 'MISS');

    const originalJson = res.json.bind(res);
    res.json = (data: any) => {
      const status = res.statusCode || 200;
      if (isStorableStatus(status)) {
        this.set(cacheKey, data, (config.ttl ?? this.defaultTtl) as number, status);
      }

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
    const cached = this.getEntry(key);
    return cached === undefined ? undefined : cached.data;
  }

  /** The stored body with the status it was sent with; undefined when absent or expired. */
  getEntry(key: string): { data: any; status: number } | undefined {
    const cached = this.store.get(key);
    if (!cached) {
      return undefined;
    }

    const now = Date.now();
    if (now - cached.timestamp >= cached.ttl * 1000) {
      this.store.delete(key);
      return undefined;
    }

    // Mark as recently used
    this.store.delete(key);
    this.store.set(key, cached);

    logger.debug('Cache hit', 'Cache', { key });
    return cached;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, data: any, ttl: number, status: number = 200): void {
    this.store.delete(key);
    this.store.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
      status,
    });

    // Expired entries are only noticed when their own key is read again, so
    // the store is walked once in a while and they are dropped: after as many
    // inserts as it held entries at the last walk, which keeps the work per
    // insert constant on average, with no timer to keep alive.
    if (++this.insertsSinceSweep >= this.sweepAfter) {
      this.sweep();
    }

    // Over the cap: the least recently used entries make room
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.store.delete(oldest);
    }

    logger.debug('Response cached', 'Cache', { key, ttl });
  }

  /** Drop every expired entry. Runs by itself as entries are added. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.timestamp >= entry.ttl * 1000) this.store.delete(key);
    }
    this.insertsSinceSweep = 0;
    this.sweepAfter = Math.max(MIN_SWEEP_INTERVAL, this.store.size);
  }

  /**
   * Clear all cached data
   */
  clear(): void {
    this.store.clear();
    this.insertsSinceSweep = 0;
    this.sweepAfter = MIN_SWEEP_INTERVAL;
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
