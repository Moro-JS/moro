// Helmet Security Headers Middleware
import { Middleware } from '../../../../types/http.js';
import { HelmetCore, HelmetOptions, tagHelmetMiddleware } from './core.js';

/**
 * Create Helmet security headers middleware
 *
 * @example
 * ```typescript
 * import { helmet } from '@morojs/moro';
 *
 * app.use(helmet({
 *   contentSecurityPolicy: {
 *     defaultSrc: ["'self'"],
 *     scriptSrc: ["'self'", "'unsafe-inline'"],
 *   },
 *   strictTransportSecurity: {
 *     maxAge: 31536000,
 *     includeSubDomains: true,
 *   },
 * }));
 * ```
 */
export function createHelmetMiddleware(options: HelmetOptions = {}): Middleware {
  const core = new HelmetCore(options);

  const helmetMiddleware: Middleware = (req, res, next) => {
    core.applyHeaders(req, res);
    next();
  };
  // Lets the built-in hooks that answer early (rate limit, CORS, CSRF) put
  // the same headers on their responses when this is registered globally.
  return tagHelmetMiddleware(helmetMiddleware, core);
}
