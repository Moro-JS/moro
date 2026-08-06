// Cookie Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { CookieCore, type CookieOptions } from './core.js';

/**
 * Create cookie middleware for use in middleware chains
 * Adds cookie parsing and response methods to req/res
 *
 * @example
 * ```ts
 * const cookieMw = createCookieMiddleware();
 * app.use(cookieMw);
 *
 * // In routes:
 * req.cookies // { sessionId: '123' }
 * res.cookie('user', 'john', { httpOnly: true })
 * res.clearCookie('user')
 * ```
 */
export function createCookieMiddleware(secret?: string): StandardMiddleware {
  const cookieCore = new CookieCore(secret);

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    const reqAny = req as any;
    const resAny = res as any;

    // Parse cookies from request; signed values are verified and kept apart
    const split = cookieCore.splitSignedCookies(cookieCore.parseCookies(req.headers.cookie));
    reqAny.cookies = split.cookies;
    reqAny.signedCookies = split.signedCookies;

    // Add cookie methods to response
    resAny.cookie = (name: string, value: string, options: CookieOptions = {}) => {
      cookieCore.setCookie(res, name, value, options);
      return res;
    };

    resAny.clearCookie = (name: string, options: CookieOptions = {}) => {
      cookieCore.clearCookie(res, name, options);
      return res;
    };

    await next();
  };
}
