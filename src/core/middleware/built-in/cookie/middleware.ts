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
export function createCookieMiddleware(): StandardMiddleware {
  const cookieCore = new CookieCore();

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    const reqAny = req as any;
    const resAny = res as any;

    // Parse cookies from request
    reqAny.cookies = cookieCore.parseCookies(req.headers.cookie);

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
