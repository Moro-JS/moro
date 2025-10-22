// Cookie Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CookieCore, type CookieOptions } from './core.js';

const logger = createFrameworkLogger('CookieMiddleware');

export interface CookieConfig {
  secret?: string;
  signed?: boolean;
}

/**
 * Cookie hook for global usage
 * Registers with the hooks system for application-wide cookie handling
 *
 * @example
 * ```ts
 * import { cookie } from '@/middleware/built-in/cookie';
 *
 * app.use(cookie({
 *   secret: 'my-secret-key',
 *   signed: true
 * }));
 * ```
 */
export const cookie = (config: CookieConfig = {}): MiddlewareInterface => ({
  name: 'cookie',
  version: '1.0.0',
  metadata: {
    name: 'cookie',
    version: '1.0.0',
    description: 'Cookie parsing and setting middleware with security features',
    author: 'MoroJS Team',
  },

  install: async (hooks: any, middlewareOptions: any = {}) => {
    logger.debug('Installing cookie middleware', 'Installation');

    const cookieCore = new CookieCore();

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Parse cookies from request
      req.cookies = cookieCore.parseCookies(req.headers.cookie);

      // Add cookie methods to response
      res.cookie = (name: string, value: string, options: CookieOptions = {}) => {
        cookieCore.setCookie(res, name, value, options);
        return res;
      };

      res.clearCookie = (name: string, options: CookieOptions = {}) => {
        cookieCore.clearCookie(res, name, options);
        return res;
      };
    });
  },
});
