// CORS Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { CORSCore, type CORSOptions } from './core.js';

/**
 * Create CORS middleware for use in middleware chains
 *
 * @example
 * ```ts
 * const corsMw = createCORSMiddleware({
 *   origin: 'https://example.com',
 *   credentials: true
 * });
 *
 * app.use(corsMw);
 * ```
 */
export function createCORSMiddleware(options: CORSOptions = {}): StandardMiddleware {
  const corsCore = new CORSCore(options);

  return async (_req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    corsCore.applyCORS(res);
    await next();
  };
}
