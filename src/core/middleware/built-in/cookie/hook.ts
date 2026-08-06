// Cookie Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { CookieCore, type CookieOptions } from './core.js';

const logger = createFrameworkLogger('CookieMiddleware');

export interface CookieConfig {
  /** Signing key. Required before any cookie can be set with `signed: true`. */
  secret?: string;
  /** Sign every cookie by default; individual calls can still opt out. */
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

  install: async (hooks: any, _middlewareOptions: any = {}) => {
    logger.debug('Installing cookie middleware', 'Installation');

    // Fail at registration rather than silently handing out unsigned cookies
    if (config.signed && !config.secret) {
      throw new Error(
        'middleware.cookie({ signed: true }) requires a secret to sign with. ' +
          "Pass one: middleware.cookie({ secret: '...', signed: true })."
      );
    }

    const cookieCore = new CookieCore(config.secret);
    const signByDefault = config.signed === true;

    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Parse cookies from request; signed ones are verified and kept apart
      const parsed = cookieCore.parseCookies(req.headers.cookie);
      const split = cookieCore.splitSignedCookies(parsed);
      req.cookies = split.cookies;
      req.signedCookies = split.signedCookies;

      // Add cookie methods to response
      res.cookie = (name: string, value: string, options: CookieOptions = {}) => {
        cookieCore.setCookie(res, name, value, {
          ...options,
          signed: options.signed ?? signByDefault,
        });
        return res;
      };

      res.clearCookie = (name: string, options: CookieOptions = {}) => {
        cookieCore.clearCookie(res, name, options);
        return res;
      };
    });
  },
});
