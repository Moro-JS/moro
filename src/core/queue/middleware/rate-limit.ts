/**
 * Rate Limiting Middleware for Queue Processing
 * Limits the rate at which jobs are processed
 */

import type { JobHandler, JobContext } from '../types.js';

/**
 * Rate limiter configuration
 */
export interface RateLimiterOptions {
  max: number; // Maximum number of jobs
  duration: number; // Time window in milliseconds
  throwOnLimit?: boolean; // Throw error when limit exceeded (default: false)
}

/**
 * Token bucket implementation for rate limiting
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private max: number,
    private refillRate: number
  ) {
    this.tokens = max;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token
   */
  consume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Refill tokens based on time elapsed
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / 1000) * this.refillRate;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.max, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Get time until next token is available (in ms)
   */
  getWaitTime(): number {
    if (this.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - this.tokens;
    return (tokensNeeded / this.refillRate) * 1000;
  }
}

/**
 * Create a rate-limited job handler
 */
export function createRateLimitMiddleware<T = any, R = any>(
  handler: JobHandler<T, R>,
  options: RateLimiterOptions
): JobHandler<T, R> {
  const refillRate = options.max / (options.duration / 1000);
  const bucket = new TokenBucket(options.max, refillRate);

  return async (job: JobContext<T>): Promise<R> => {
    // Try to consume a token
    if (!bucket.consume()) {
      if (options.throwOnLimit) {
        throw new Error('Rate limit exceeded');
      }

      // Wait for next token
      const waitTime = bucket.getWaitTime();
      job.log(`Rate limit reached, waiting ${Math.ceil(waitTime)}ms`);

      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Try again after waiting
      if (!bucket.consume()) {
        throw new Error('Rate limit still exceeded after waiting');
      }
    }

    return await handler(job);
  };
}

/**
 * Rate limiter factory for queue configuration
 */
export class RateLimiter {
  /**
   * Create a rate limiter that allows X jobs per second
   */
  static perSecond(max: number): RateLimiterOptions {
    return {
      max,
      duration: 1000,
    };
  }

  /**
   * Create a rate limiter that allows X jobs per minute
   */
  static perMinute(max: number): RateLimiterOptions {
    return {
      max,
      duration: 60000,
    };
  }

  /**
   * Create a rate limiter that allows X jobs per hour
   */
  static perHour(max: number): RateLimiterOptions {
    return {
      max,
      duration: 3600000,
    };
  }
}
