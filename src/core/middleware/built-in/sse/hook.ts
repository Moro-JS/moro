// SSE Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { SSECore, type SSEOptions } from './core.js';

const logger = createFrameworkLogger('SSEMiddleware');

/**
 * SSE hook for global usage
 * Registers with the hooks system for application-wide Server-Sent Events support
 *
 * @example
 * ```ts
 * import { sse } from '@/middleware/built-in/sse';
 *
 * app.use(sse({
 *   heartbeat: 30000,
 *   retry: 3000,
 *   cors: true
 * }));
 * ```
 */
export const sse = (options: SSEOptions = {}): MiddlewareInterface => ({
  name: 'sse',
  version: '1.0.0',
  metadata: {
    name: 'sse',
    version: '1.0.0',
    description: 'Server-Sent Events middleware with heartbeat and retry support',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing SSE middleware', 'Installation', { options: middlewareOptions });

    const config = { ...options, ...middlewareOptions };
    const sseCore = new SSECore(config);

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Only handle SSE requests
      if (!sseCore.isSSERequest(req.headers.accept)) {
        return;
      }

      logger.debug('Setting up SSE connection', 'SSESetup');

      // Initialize SSE connection
      if (!res.headersSent) {
        sseCore.initializeSSE(res);
      }

      // Create connection and attach methods to response
      const connection = sseCore.createConnection(res, () => {
        logger.debug('SSE connection closed', 'SSECleanup');
      });

      res.sendEvent = connection.sendEvent;
      res.sendComment = connection.sendComment;
      res.sendRetry = connection.sendRetry;

      // Clean up on close
      req.on('close', () => {
        connection.close();
      });

      // Mark that this middleware handled the request
      (context as any).handled = true;
    });
  },
});
