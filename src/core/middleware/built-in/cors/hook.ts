// CORS Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CORSCore, registerCORSHook, type CORSOptions } from './core.js';
import { applyGlobalHelmet } from '../helmet/core.js';

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
    // Known to the hook manager's server: a response answered ahead of this
    // hook (a configured rate limit's 429) is given this CORS's headers
    if (hooks !== null && typeof hooks === 'object') registerCORSHook(hooks, corsCore);

    hooks.before('request', async (context: HookContext) => {
      const request = context.request as any;
      const response = context.response as any;

      // Answered by a hook that ran before this one: there is nothing left to
      // add, and a response that has been sent takes no more headers
      if (response.headersSent) return;

      // Apply CORS headers to all requests (now async to support origin functions)
      const isAllowed = await corsCore.applyCORS(response, request);

      // If origin validation failed, deny the request
      if (!isAllowed) {
        logger.debug('CORS origin validation failed', 'Validation', {
          origin: request.headers?.origin,
          path: request.path,
        });
        // Answered ahead of function middleware: carry the application's
        // helmet headers, as every other response does
        applyGlobalHelmet(request, response);
        response.status(403).end();
        // Set headersSent for custom response wrappers (the engine, HTTP/2) and mocks that support it
        // Node.js native ServerResponse has a read-only headersSent getter
        const descriptor = Object.getOwnPropertyDescriptor(response, 'headersSent');
        if (!descriptor || descriptor.writable || descriptor.set) {
          // Property is writable (data property) or has a setter (accessor property)
          try {
            response.headersSent = true;
          } catch {
            // Silently ignore - native responses manage this automatically
          }
        }
        return;
      }

      // Handle OPTIONS preflight automatically unless preflightContinue is true
      if (request.method === 'OPTIONS' && !config.preflightContinue) {
        logger.debug('Handling OPTIONS preflight request', 'Preflight', { path: request.path });
        response.status(204).end();
        // Set headersSent for custom response wrappers (the engine, HTTP/2) and mocks that support it
        // Node.js native ServerResponse has a read-only headersSent getter
        const descriptor = Object.getOwnPropertyDescriptor(response, 'headersSent');
        if (!descriptor || descriptor.writable || descriptor.set) {
          // Property is writable (data property) or has a setter (accessor property)
          try {
            response.headersSent = true;
          } catch {
            // Silently ignore - native responses manage this automatically
          }
        }
      }
    });
  },
});
