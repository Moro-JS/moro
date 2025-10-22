// Rate Limit Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { RateLimitCore } from './core.js';

const logger = createFrameworkLogger('RateLimitMiddleware');

/**
 * Rate limit hook for global usage
 * Registers with the hooks system for application-wide rate limiting
 *
 * @example
 * ```ts
 * import { rateLimit } from '@/middleware/built-in/rate-limit';
 *
 * app.use(rateLimit({
 *   windowMs: 60000,  // 1 minute
 *   max: 100          // 100 requests per window
 * }));
 * ```
 */
export const rateLimit = (
  options: {
    windowMs?: number;
    max?: number;
    message?: string;
  } = {}
): MiddlewareInterface => ({
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

    const windowMs = options.windowMs || 60000; // 1 minute default
    const max = options.max || 100; // 100 requests per window
    const core = new RateLimitCore();

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const clientId = req.connection?.remoteAddress || 'unknown';
      const routeKey = `${req.method}:${req.path}`;

      const allowed = core.check(clientId, routeKey, max, windowMs);

      if (!allowed) {
        logger.warn(`Rate limit exceeded for ${clientId}`, 'RateLimit', {
          clientId,
          max,
        });
        throw new Error(options.message || 'Too many requests');
      }
    });
  },
});
