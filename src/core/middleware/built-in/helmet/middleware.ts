// Helmet Security Headers Middleware
import { Middleware } from '../../../../types/http.js';
import { HelmetCore, HelmetOptions } from './core.js';

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

  return (req, res, next) => {
    core.applyHeaders(req, res);
    next();
  };
}
