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

  // Monotonic timestamp optimization
  private static readonly startTime = Date.now();

  /**
   * Get monotonic timestamp (smaller integers for better JIT optimization)
   */
  private static getTime(): number {
    return Date.now() - RateLimitCore.startTime;
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
   * Clear all rate limit data
   */
  clear(): void {
    this.store.clear();
  }
}

// Shared instance for route-based rate limiting
export const sharedRateLimitCore = new RateLimitCore();
