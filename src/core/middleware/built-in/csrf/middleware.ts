// CSRF Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { CSRFCore, type CSRFOptions } from './core.js';

const logger = createFrameworkLogger('CSRFMiddleware');

/**
 * Create CSRF middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const csrfMw = createCSRFMiddleware({
 *   cookieName: '_csrf',
 *   headerName: 'x-csrf-token'
 * });
 *
 * app.use(csrfMw);
 * ```
 */
export function createCSRFMiddleware(options: CSRFOptions = {}): StandardMiddleware {
  const csrfCore = new CSRFCore(options);

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    try {
      // Add CSRF token generation method
      (req as any).csrfToken = () => csrfCore.attachToken(req, res);

      // Validate token for non-safe methods
      await csrfCore.validateToken(req);

      // Execute next middleware
      await next();
    } catch (error) {
      logger.error('CSRF middleware error', 'CSRFError', { error });
      throw error;
    }
  };
}
