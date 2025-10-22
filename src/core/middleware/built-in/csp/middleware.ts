// CSP Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { CSPCore, type CSPOptions } from './core.js';

/**
 * Create CSP middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const cspMw = createCSPMiddleware({
 *   directives: {
 *     defaultSrc: ["'self'"],
 *     scriptSrc: ["'self'", "'unsafe-inline'"]
 *   },
 *   nonce: true
 * });
 *
 * app.use(cspMw);
 * ```
 */
export function createCSPMiddleware(options: CSPOptions = {}): StandardMiddleware {
  const cspCore = new CSPCore(options);

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    const nonce = cspCore.applyCSP(res);

    // Attach nonce to request if generated
    if (nonce) {
      (req as any).cspNonce = nonce;
    }

    await next();
  };
}
