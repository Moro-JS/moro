// Validation Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('ValidationMiddleware');

/**
 * Basic validation hook for global usage
 * Registers with the hooks system for content-type checking
 *
 * @example
 * ```ts
 * import { validation } from '@/middleware/built-in/validation';
 *
 * app.use(validation());
 * ```
 */
export const validation = (): MiddlewareInterface => ({
  name: 'validation',
  version: '1.0.0',
  metadata: {
    name: 'validation',
    version: '1.0.0',
    description: 'Request validation middleware with content type checking',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, _middlewareOptions: any = {}) => {
    logger.debug('Installing validation middleware', 'Installation');

    hooks.before('request', async (context: HookContext) => {
      const request = context.request as any;

      // Basic content type validation
      if (request.method === 'POST' || request.method === 'PUT') {
        const contentType = request.headers['content-type'];
        if (contentType && contentType.includes('application/json')) {
          logger.debug('Validation: JSON content type verified', 'ContentType');
          // Additional validation logic would go here
        }
      }
    });
  },
});
