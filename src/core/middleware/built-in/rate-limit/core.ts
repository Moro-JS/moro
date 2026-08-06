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
 * Run `cb` once the response has been fully sent. Prefers the 'finish' event
 * (node, engine and uWS responses all emit it) and falls back to wrapping
 * end() for the HTTP/2 response, which is a plain object with no emitter.
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
}

// ===== Core Logic =====

/**
 * RateLimitCore - Core rate limiting logic
 * Used directly by the router for route-based rate limiting
 * Can be instantiated for use in middleware or hooks
 */
export class RateLimitCore {
  private store = new Map<string, RateLimitStore>();
  private static readonly MAX_STORE_SIZE = 100000;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Monotonic timestamp optimization
  private static readonly startTime = Date.now();

  constructor() {
    // Periodic cleanup of expired entries to prevent unbounded memory growth
    this.cleanupTimer = setInterval(() => this.evictExpired(), 60000);
    // Allow the timer to not keep the process alive
    if (this.cleanupTimer && typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
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
  async checkLimit(req: HttpRequest, res: HttpResponse, config: RateLimitConfig): Promise<void> {
    // Don't send response if headers already sent
    if (res.headersSent) {
      return;
    }

    const clientId = req.ip || (req.connection as any)?.remoteAddress || 'unknown';
    const routeKey = `${req.method}:${req.path}`;

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
      // Safety cap: evict oldest entries if store exceeds max size
      if (this.store.size >= RateLimitCore.MAX_STORE_SIZE) {
        this.evictExpired();
        // If still over limit after eviction, remove oldest entry
        if (this.store.size >= RateLimitCore.MAX_STORE_SIZE) {
          const firstKey = this.store.keys().next().value;
          if (firstKey) this.store.delete(firstKey);
        }
      }
      this.store.set(key, { count: 1, resetTime: now + window });
      return true;
    }

    // Fast path: check if window expired
    if (now > limitData.resetTime) {
      limitData.count = 1;
      limitData.resetTime = now + window;
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
    return true;
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
