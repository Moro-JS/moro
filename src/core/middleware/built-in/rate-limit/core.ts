// Rate Limit Core - Reusable rate limiting logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('RateLimitCore');

// ===== Types =====

export interface RateLimitConfig {
  requests: number;
  window: number;
  skipSuccessfulRequests?: boolean;
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
      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter,
      });
      return;
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
