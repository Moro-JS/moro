// CORS Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CORSCore, type CORSOptions } from './core.js';

const logger = createFrameworkLogger('CorsMiddleware');

/**
 * CORS hook for global usage
 * Registers with the hooks system for application-wide CORS
 *
 * @example
 * ```ts
 * import { cors } from '@/middleware/built-in/cors';
 *
 * app.use(cors({
 *   origin: 'https://example.com',
 *   credentials: true
 * }));
 * ```
 */
export const cors = (options: CORSOptions = {}): MiddlewareInterface => ({
  name: 'cors',
  version: '1.0.0',
  metadata: {
    name: 'cors',
    version: '1.0.0',
    description: 'Cross-Origin Resource Sharing middleware',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing CORS middleware', 'Installation', { options: middlewareOptions });

    const config = { ...options, ...middlewareOptions };
    const corsCore = new CORSCore(config);

    hooks.before('request', async (context: HookContext) => {
      const request = context.request as any;
      const response = context.response as any;

      // Apply CORS headers to all requests (now async to support origin functions)
      const isAllowed = await corsCore.applyCORS(response, request);

      // If origin validation failed, deny the request
      if (!isAllowed) {
        logger.debug('CORS origin validation failed', 'Validation', {
          origin: request.headers?.origin,
          path: request.path,
        });
        response.status(403).end();
        // Try to set headersSent for custom response wrappers (UWS, HTTP/2) and mocks
        // Node.js native ServerResponse has a read-only headersSent getter, so this will fail silently
        try {
          response.headersSent = true;
        } catch {
          // Ignore TypeError - native Node.js responses manage headersSent automatically
          // This error occurs when trying to set a read-only property
        }
        return;
      }

      // Handle OPTIONS preflight automatically unless preflightContinue is true
      if (request.method === 'OPTIONS' && !config.preflightContinue) {
        logger.debug('Handling OPTIONS preflight request', 'Preflight', { path: request.path });
        response.status(204).end();
        // Try to set headersSent for custom response wrappers (UWS, HTTP/2) and mocks
        // Node.js native ServerResponse has a read-only headersSent getter, so this will fail silently
        try {
          response.headersSent = true;
        } catch {
          // Ignore TypeError - native Node.js responses manage headersSent automatically
          // This error occurs when trying to set a read-only property
        }
      }
    });
  },
});
