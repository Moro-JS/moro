// CORS Middleware
import { Middleware } from '../../../../types/http.js';
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
export function createCORSMiddleware(options: CORSOptions = {}): Middleware {
  const corsCore = new CORSCore(options);

  return async (req: HttpRequest, res: HttpResponse, next: () => void) => {
    // Apply CORS headers to all requests (now async to support origin functions)
    const isAllowed = await corsCore.applyCORS(res, req);

    // If origin validation failed, deny the request
    if (!isAllowed) {
      (res as any).status(403).end();
      return;
    }

    // Handle OPTIONS preflight automatically unless preflightContinue is true
    if (req.method === 'OPTIONS' && !options.preflightContinue) {
      (res as any).status(204).end();
      return;
    }

    next();
  };
}
