// CSP Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CSPCore, type CSPOptions } from './core.js';

const logger = createFrameworkLogger('CSPMiddleware');

/**
 * CSP hook for global usage
 * Registers with the hooks system for application-wide Content Security Policy
 *
 * @example
 * ```ts
 * import { csp } from '@/middleware/built-in/csp';
 *
 * app.use(csp({
 *   directives: {
 *     defaultSrc: ["'self'"],
 *     scriptSrc: ["'self'", 'https://cdn.example.com'],
 *     styleSrc: ["'self'", "'unsafe-inline'"]
 *   },
 *   nonce: true,
 *   reportUri: '/csp-report'
 * }));
 * ```
 */
export const csp = (options: CSPOptions = {}): MiddlewareInterface => ({
  name: 'csp',
  version: '1.0.0',
  metadata: {
    name: 'csp',
    version: '1.0.0',
    description: 'Content Security Policy middleware with nonce support and violation reporting',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing CSP middleware', 'Installation', { options: middlewareOptions });

    const config = { ...options, ...middlewareOptions };
    const cspCore = new CSPCore(config);

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      const nonce = cspCore.applyCSP(res);

      // Attach nonce to request if generated
      if (nonce) {
        req.cspNonce = nonce;
      }
    });
  },
});
