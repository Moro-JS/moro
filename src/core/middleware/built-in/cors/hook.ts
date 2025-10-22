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
      const response = context.response as any;
      corsCore.applyCORS(response);
    });
  },
});
