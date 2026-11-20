// Rate Limit Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import {
  RateLimitCore,
  onResponseFinished,
  rateLimitClientId,
  rateLimitRouteKey,
  setRoutePatternResolver,
  shouldRefund,
  type RateLimitConfig,
} from './core.js';
// After ./core.js on purpose: the router loads the rate limit core, so the
// core must be ready before the router module is.
import { UnifiedRouter } from '../../../routing/unified-router.js';
import { applyGlobalHelmet } from '../helmet/core.js';
import { applyGlobalCORS, globalCORSAnswersPreflight } from '../cors/core.js';

// Counters are kept per registered route ('/otp/:code'), not per URL: ask the
// router which route a request will reach. A request carries its server, and
// the server its app's router; this is the answer for a request that has no
// server (a runtime adapter): the current app's router, resolved per request.
setRoutePatternResolver((method, path) => UnifiedRouter.getInstance().matchRoute(method, path));

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
  /**
   * Who a request is counted against. Default: the client address (`req.ip`).
   * An empty result falls back to the client address.
   */
  keyGenerator?: RateLimitConfig['keyGenerator'];
}

/**
 * Rate limit hook for global usage
 * Registers with the hooks system for application-wide rate limiting
 *
 * Rejected requests are answered directly with the configured status (429 by
 * default) and a `Retry-After` header — the request never reaches your routes.
 *
 * Each client (`req.ip`, or `keyGenerator(req)`) has one counter per route:
 * requests are counted under the route they match as it was registered
 * (`/users/:id`), so changing a path parameter or the query string does not
 * start a new counter. A request that matches no registered route is counted
 * under its path.
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
      // A preflight is the application's CORS to answer: counted here, the
      // browser's own question could use up the allowance, and a refused one
      // would fail the request it asks about. (Any other request is counted,
      // also one a hook ahead of this one has answered: a 401 from an auth
      // hook is a request the limit is there to slow down.)
      if (globalCORSAnswersPreflight(req, res)) return;
      const clientId = rateLimitClientId(req, options.keyGenerator);
      const routeKey = rateLimitRouteKey(req);

      const allowed = core.check(clientId, routeKey, max, windowMs);

      if (!allowed) {
        // Answer here rather than throwing: a thrown error reaches the error
        // boundary and becomes a 500, which is both the wrong status and an
        // ERROR log line for every request the limiter correctly rejects.
        if (res && !res.headersSent) {
          const retryAfter = core.getRetryAfter(clientId, routeKey);
          // Answered ahead of function middleware: carry the application's
          // helmet headers, as every other response does
          applyGlobalHelmet(req, res);
          // ... and its CORS headers, so that a page on an allowed origin can
          // read the refusal
          await applyGlobalCORS(req, res);
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
