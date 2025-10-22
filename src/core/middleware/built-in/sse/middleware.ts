// SSE Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { SSECore, type SSEOptions } from './core.js';

/**
 * Create SSE middleware for use in middleware chains
 * Only activates for requests with 'text/event-stream' Accept header
 *
 * @example
 * ```ts
 * const sseMw = createSSEMiddleware({
 *   heartbeat: 30000,
 *   retry: 3000,
 *   cors: true
 * });
 *
 * app.use(sseMw);
 * ```
 */
export function createSSEMiddleware(options: SSEOptions = {}): StandardMiddleware {
  const sseCore = new SSECore(options);

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    // Only handle SSE requests
    if (!sseCore.isSSERequest(req.headers.accept)) {
      await next();
      return;
    }

    // Initialize SSE connection
    const resAny = res as any;
    if (!resAny.headersSent) {
      sseCore.initializeSSE(res);
    }

    // Create connection and attach methods to response
    const reqAny = req as any;
    const connection = sseCore.createConnection(res);

    resAny.sendEvent = connection.sendEvent;
    resAny.sendComment = connection.sendComment;
    resAny.sendRetry = connection.sendRetry;

    // Clean up on close
    reqAny.on('close', () => {
      connection.close();
    });

    await next();
  };
}
