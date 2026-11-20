// CSRF Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CSRFCore, passesCSRFCheck, type CSRFOptions } from './core.js';
import { globalCORSAnswersPreflight } from '../cors/core.js';

const logger = createFrameworkLogger('CSRFMiddleware');

/**
 * CSRF hook for global usage
 * Registers with the hooks system for application-wide CSRF protection
 *
 * @example
 * ```ts
 * import { csrf } from '@/middleware/built-in/csrf';
 *
 * app.use(csrf({
 *   cookieName: '_csrf',
 *   ignoreMethods: ['GET', 'HEAD', 'OPTIONS']
 * }));
 * ```
 */
export const csrf = (options: CSRFOptions = {}): MiddlewareInterface => ({
  name: 'csrf',
  version: '1.0.0',
  metadata: {
    name: 'csrf',
    version: '1.0.0',
    description: 'CSRF protection middleware with token generation and validation',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing CSRF middleware', 'Installation');

    const config: CSRFOptions = {
      ...options,
      ...middlewareOptions,
    };

    const csrfCore = new CSRFCore(config);

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Answered by a hook that ran before this one: nothing left to check
      if (res.headersSent) return;

      // Add CSRF token generation method
      req.csrfToken = () => csrfCore.attachToken(req, res);

      // Validate token for non-safe methods; a request that fails is answered
      // with 403 here and goes no further
      // A preflight the application's CORS answers carries no token and
      // needs none: it is CORS's to answer
      if (globalCORSAnswersPreflight(req, res)) return;

      await passesCSRFCheck(csrfCore, req, res, true);
    });

    logger.info('CSRF middleware installed', 'Installation');
  },
});
