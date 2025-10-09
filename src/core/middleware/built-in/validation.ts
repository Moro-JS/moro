// Validation Middleware
import { MiddlewareInterface, HookContext } from '../../../types/hooks.js';
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('ValidationMiddleware');

export const validation = (): MiddlewareInterface => ({
  name: 'validation',
  version: '1.0.0',
  metadata: {
    name: 'validation',
    version: '1.0.0',
    description: 'Request validation middleware with content type checking',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, options: any = {}) => {
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
