// Rate Limit Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { RateLimitCore, onResponseFinished, shouldRefund } from './core.js';

const logger = createFrameworkLogger('RateLimitMiddleware');

export interface RateLimitHookOptions {
  /** Requests allowed per window. `max` is the express-rate-limit spelling. */
  requests?: number;
  max?: number;
  /** Window length in milliseconds. `windowMs` is the express-rate-limit spelling. */
  window?: number;
  windowMs?: number;
  /** Body message for a rejected request. Default: 'Too many requests'. */
  message?: string;
  /** Status for a rejected request. Default: 429. */
  statusCode?: number;
  /** Only count requests that did not complete successfully. */
  skipSuccessfulRequests?: boolean;
  /** Only count requests that did complete successfully. */
  skipFailedRequests?: boolean;
}

/**
 * Rate limit hook for global usage
 * Registers with the hooks system for application-wide rate limiting
 *
 * Rejected requests are answered directly with the configured status (429 by
 * default) and a `Retry-After` header — the request never reaches your routes.
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.rateLimit({
 *   requests: 100,    // or max: 100
 *   window: 60000,    // or windowMs: 60000
 * }));
 * ```
 */
export const rateLimit = (options: RateLimitHookOptions = {}): MiddlewareInterface => ({
  name: 'rate-limit',
  version: '1.0.0',
  metadata: {
    name: 'rate-limit',
    version: '1.0.0',
    description: 'Rate limiting middleware with configurable windows',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, _middlewareOptions: any = {}) => {
    logger.debug('Installing rate limit middleware', 'Installation', {
      options,
    });

    // Both spellings are accepted; `requests`/`window` is the Moro form used by
    // route-level .rateLimit(), `max`/`windowMs` the express-rate-limit one.
    const windowMs = options.window ?? options.windowMs ?? 60000; // 1 minute default
    const max = options.requests ?? options.max ?? 100; // 100 requests per window
    const statusCode = options.statusCode ?? 429;
    const message = options.message || 'Too many requests';
    const core = new RateLimitCore();

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;
      const clientId = req.ip || req.connection?.remoteAddress || 'unknown';
      const routeKey = `${req.method}:${req.path}`;

      const allowed = core.check(clientId, routeKey, max, windowMs);

      if (!allowed) {
        // Answer here rather than throwing: a thrown error reaches the error
        // boundary and becomes a 500, which is both the wrong status and an
        // ERROR log line for every request the limiter correctly rejects.
        if (res && !res.headersSent) {
          const retryAfter = core.getRetryAfter(clientId, routeKey);
          res.setHeader('Retry-After', String(retryAfter));
          res.status(statusCode).json({
            success: false,
            error: message,
            retryAfter,
          });
        }
        return;
      }

      if ((options.skipSuccessfulRequests || options.skipFailedRequests) && res) {
        onResponseFinished(res, () => {
          if (shouldRefund(res.statusCode || 200, options)) core.refund(clientId, routeKey);
        });
      }
    });
  },
});
