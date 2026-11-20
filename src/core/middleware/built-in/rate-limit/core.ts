// Rate Limit Core - Reusable rate limiting logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('RateLimitCore');

// ===== Types =====

export interface RateLimitConfig {
  requests: number;
  window: number;
  /**
   * Don't count requests that completed successfully (status < 400) against the
   * limit — the request is counted up front and refunded once the response
   * finishes, so a burst still can't exceed the limit mid-flight.
   */
  skipSuccessfulRequests?: boolean;
  /** The mirror of the above: don't count requests that failed (status >= 400). */
  skipFailedRequests?: boolean;
  /**
   * Who a request is counted against. Default: the client address (`req.ip`).
   * Return, for example, an API key or a user id to limit per account; an
   * empty result falls back to the client address.
   */
  keyGenerator?: (req: HttpRequest) => string | undefined | null;
}

/** Who a request is counted against: the key generator's answer, else the client address. */
export function rateLimitClientId(
  req: HttpRequest,
  keyGenerator?: RateLimitConfig['keyGenerator']
): string {
  if (keyGenerator !== undefined) {
    const custom = keyGenerator(req);
    if (custom !== undefined && custom !== null && custom !== '') return String(custom);
  }
  return req.ip || (req.connection as any)?.remoteAddress || 'unknown';
}

/** Finds the registered route template a request matches ('/users/:id'), if any. */
export type RoutePatternResolver = (method: string, path: string) => string | undefined;

// For a request that did not come through one of the framework's servers
// (a runtime adapter, a test double): asks the current app's router. Filled
// in by the hook module, which can see the router; this module is loaded by
// the router itself and so cannot import it.
let routePatternResolver: RoutePatternResolver | undefined;

/** @internal */
export function setRoutePatternResolver(resolver: RoutePatternResolver | undefined): void {
  routePatternResolver = resolver;
}

/**
 * What a request is counted under: its method and the route it matches, as
 * the route was registered ('GET:/otp/:code'), so that every value of a path
 * parameter lands in one counter. A request no registered route matches (and
 * one seen before routing knows about it) is counted under its path, without
 * the query string.
 */
export function rateLimitRouteKey(req: HttpRequest, routePattern?: string): string {
  const method = req.method || 'GET';
  let path = req.path || '/';
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  const pattern = routePattern ?? matchedRoutePattern(req, method, path);
  return `${method}:${pattern ?? path}`;
}

// The route a request will reach, asked of the router of the app that is
// handling it: the server that received the request holds that router. Two
// apps in one process therefore each name their own routes.
function matchedRoutePattern(req: HttpRequest, method: string, path: string): string | undefined {
  const router = (req as { _server?: { router?: { matchRoute?: RoutePatternResolver } } })._server
    ?.router;
  if (router !== undefined && typeof router.matchRoute === 'function') {
    return router.matchRoute(method, path);
  }
  return routePatternResolver ? routePatternResolver(method, path) : undefined;
}

/** Whether a finished response should give its counted request back. */
export function shouldRefund(
  statusCode: number,
  config: { skipSuccessfulRequests?: boolean; skipFailedRequests?: boolean }
): boolean {
  const failed = statusCode >= 400;
  return failed ? !!config.skipFailedRequests : !!config.skipSuccessfulRequests;
}

/**
 * Run `cb` once the response has been fully sent: on its 'finish' event, which
 * the Node, HTTP/2 and engine responses all emit for a response sent in full.
 * A response object with no emitter gets its end() wrapped instead.
 */
export function onResponseFinished(res: HttpResponse, cb: () => void): void {
  const emitter = res as any;
  if (typeof emitter.once === 'function') {
    emitter.once('finish', cb);
    return;
  }

  const originalEnd = emitter.end;
  if (typeof originalEnd !== 'function') return;
  emitter.end = function patchedEnd(this: unknown, ...args: unknown[]) {
    const result = originalEnd.apply(this, args);
    cb();
    return result;
  };
}

interface RateLimitStore {
  count: number;
  resetTime: number;
  /** The limit this counter is held to, so the store can tell an exhausted one. */
  limit: number;
}

/** Entries looked at, oldest first, for one that may make room in a full store */
const EVICTION_SCAN = 64;
/** A full store is walked for expired entries at most this often (ms) */
const FULL_SWEEP_INTERVAL = 1000;

// ===== Core Logic =====

/**
 * RateLimitCore - Core rate limiting logic
 * Used directly by the router for route-based rate limiting
 * Can be instantiated for use in middleware or hooks
 */
export class RateLimitCore {
  private store = new Map<string, RateLimitStore>();
  private static readonly MAX_STORE_SIZE = 100000;
  private readonly maxEntries: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lastFullSweep = -Infinity;
  private untrackedWarned = false;

  // Monotonic timestamp optimization
  private static readonly startTime = Date.now();

  /**
   * @param options.maxEntries Most counters kept at once. Default 100,000.
   */
  constructor(options: { maxEntries?: number } = {}) {
    const max = options.maxEntries;
    this.maxEntries =
      typeof max === 'number' && max > 0 ? Math.floor(max) : RateLimitCore.MAX_STORE_SIZE;
    // Periodic cleanup of expired entries to prevent unbounded memory growth
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60000);
    // Allow the timer to not keep the process alive
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /** Counters currently held (expired ones included until they are swept). */
  get size(): number {
    return this.store.size;
  }

  /**
   * Get monotonic timestamp (smaller integers for better JIT optimization)
   */
  private static getTime(): number {
    return Date.now() - RateLimitCore.startTime;
  }

  /**
   * Evict expired entries from the store
   */
  private evictExpired(): void {
    const now = RateLimitCore.getTime();
    for (const [key, data] of this.store) {
      if (now > data.resetTime) {
        this.store.delete(key);
      }
    }
  }

  /**
   * High-level check for router use: checkLimit(req, res, config)
   * Sends response if rate limit exceeded
   */
  async checkLimit(
    req: HttpRequest,
    res: HttpResponse,
    config: RateLimitConfig,
    // The route's registered path ('/otp/:code') when the caller knows it;
    // looked up from the router otherwise.
    routePattern?: string
  ): Promise<void> {
    // Don't send response if headers already sent
    if (res.headersSent) {
      return;
    }

    const clientId = rateLimitClientId(req, config.keyGenerator);
    const routeKey = rateLimitRouteKey(req, routePattern);

    const allowed = this.check(clientId, routeKey, config.requests, config.window);

    if (!allowed) {
      const retryAfter = this.getRetryAfter(clientId, routeKey);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter,
      });
      return;
    }

    if (config.skipSuccessfulRequests || config.skipFailedRequests) {
      onResponseFinished(res, () => {
        if (shouldRefund(res.statusCode || 200, config)) this.refund(clientId, routeKey);
      });
    }
  }

  /**
   * Low-level check method
   * Returns true if request is allowed, false if rate limit exceeded
   */
  check(clientId: string, routeKey: string, requests: number, window: number): boolean {
    const key = `${routeKey}:${clientId}`;
    const now = RateLimitCore.getTime();

    const limitData = this.store.get(key);
    if (!limitData) {
      // The store is bounded, and room is never made by dropping a counter
      // that is refusing requests right now: that would hand the client it
      // belongs to a fresh allowance in the middle of its window.
      if (this.store.size >= this.maxEntries && !this.makeRoom(now)) {
        // Every counter in reach is exhausted and inside its window. The new
        // key is let through uncounted rather than refused: refusing would let
        // whoever filled the store shut every other client out.
        if (!this.untrackedWarned) {
          this.untrackedWarned = true;
          logger.warn(
            `Rate limit store is full of active limits (${this.store.size} counters): ` +
              'requests under new keys are not counted until some expire',
            'RateLimit'
          );
        }
        return true;
      }
      this.store.set(key, { count: 1, resetTime: now + window, limit: requests });
      return true;
    }

    // Fast path: check if window expired
    if (now > limitData.resetTime) {
      limitData.count = 1;
      limitData.resetTime = now + window;
      limitData.limit = requests;
      return true;
    }

    // Check limit before incrementing
    if (limitData.count >= requests) {
      logger.warn('Rate limit exceeded', 'RateLimit', {
        clientId,
        route: routeKey,
        count: limitData.count,
        limit: requests,
      });
      return false;
    }

    limitData.count++;
    limitData.limit = requests;
    if (limitData.count >= requests) {
      // Now exhausted: move it behind the counters that are not, so that the
      // oldest end of the store, where room is made, holds the ones that can go.
      this.store.delete(key);
      this.store.set(key, limitData);
    }
    return true;
  }

  /**
   * Free one slot in a full store: expired counters first (walking the whole
   * store at most once a second), then the oldest counter that is not
   * currently refusing requests. false when no such counter is in reach.
   */
  private makeRoom(now: number): boolean {
    if (now - this.lastFullSweep >= FULL_SWEEP_INTERVAL) {
      this.lastFullSweep = now;
      this.evictExpired();
      if (this.store.size < this.maxEntries) return true;
    }

    let looked = 0;
    for (const [key, data] of this.store) {
      if (now > data.resetTime || data.count < data.limit) {
        this.store.delete(key);
        return true;
      }
      if (++looked >= EVICTION_SCAN) break;
    }
    return false;
  }

  /**
   * Give a counted request back — used by skipSuccessfulRequests once a
   * response finishes successfully. Never drops below zero, and ignores
   * entries whose window has already rolled over.
   */
  refund(clientId: string, routeKey: string): void {
    const key = `${routeKey}:${clientId}`;
    const limitData = this.store.get(key);
    if (!limitData) return;
    if (RateLimitCore.getTime() > limitData.resetTime) return;
    if (limitData.count > 0) limitData.count--;
  }

  /**
   * Get retry-after time in seconds for a rate-limited client
   */
  getRetryAfter(clientId: string, routeKey: string): number {
    const key = `${routeKey}:${clientId}`;
    const limitData = this.store.get(key);
    if (limitData) {
      const now = RateLimitCore.getTime();
      return Math.ceil((limitData.resetTime - now) / 1000);
    }
    return 0;
  }

  /**
   * Clear all rate limit data and stop cleanup timer
   */
  clear(): void {
    this.store.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Shared instance for route-based rate limiting
export const sharedRateLimitCore = new RateLimitCore();
