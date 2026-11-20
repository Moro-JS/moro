// SSE Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { SSECore, type SSEOptions } from './core.js';

/**
 * The same helpers as `middleware.sse()`, as a standard `(req, res, next)`
 * function: `res.sse()` opens the stream when the handler calls it, and
 * `res.sendEvent()` / `sendComment()` / `sendRetry()` open it on first use.
 * Nothing is sent before the handler asks.
 *
 * @example
 * ```ts
 * const sseMw = createSSEMiddleware({ heartbeat: 30000, retry: 3000 });
 *
 * app.use(sseMw);
 * ```
 */
export function createSSEMiddleware(options: SSEOptions = {}): StandardMiddleware {
  const sseCore = new SSECore(options);

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    sseCore.attach(req as any, res);
    await next();
  };
}
