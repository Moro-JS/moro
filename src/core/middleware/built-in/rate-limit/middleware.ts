// Rate Limit Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { sharedRateLimitCore, type RateLimitConfig } from './core.js';

/**
 * Create rate limit middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const rateLimitMw = createRateLimitMiddleware({
 *   requests: 100,
 *   window: 60000
 * });
 *
 * app.use(rateLimitMw);
 * ```
 */
export function createRateLimitMiddleware(config: RateLimitConfig): StandardMiddleware {
  if (!config || !config.requests || !config.window) {
    return (_req, _res, next) => next();
  }

  return async (req: any, res: any, next: () => void) => {
    const clientId = req.ip || req.connection?.remoteAddress || 'unknown';
    const routeKey = `${req.method}:${req.path}`;

    const allowed = sharedRateLimitCore.check(clientId, routeKey, config.requests, config.window);

    if (!allowed) {
      const retryAfter = sharedRateLimitCore.getRetryAfter(clientId, routeKey);
      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter,
      });
      return;
    }

    next();
  };
}
