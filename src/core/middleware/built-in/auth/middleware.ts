// Auth Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { AuthCore, type AuthMiddlewareOptions } from './core.js';

/**
 * The `(req, res, next)` form of `auth(options)`, for a middleware chain.
 *
 * Internal: `@morojs/moro` does not export this function. The
 * `createAuthMiddleware` the package exports is the Better Auth adapter's
 * (core/auth/morojs-adapter), which is installed with `app.use()` and mounts
 * the sign-in routes on the app; the public form of this one is
 * `app.use(auth(options))`.
 *
 * Both run the same AuthCore as `auth()`: a Bearer token is verified, a
 * Better Auth session is recognised when sign-in is configured, and
 * `req.auth` is set. Having no app to mount routes on, it answers the sign-in
 * routes itself when the request reaches it.
 *
 * @example
 * ```ts
 * import { createAuthMiddleware } from '@/middleware/built-in/auth';
 *
 * const authMw = createAuthMiddleware({ secret: process.env.AUTH_SECRET });
 * app.use(authMw);
 * ```
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions = {}): StandardMiddleware {
  const authCore = new AuthCore(options);
  let ready: Promise<void> | undefined;

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    // Initialize on first request
    if (ready === undefined) ready = authCore.initialize();
    await ready;

    // The sign-in routes, when Better Auth serves them
    if (authCore.isAuthRoute(req as any)) {
      await authCore.handleAuthRoute(req, res);
      return;
    }

    // Bearer token or session: sets req.auth, or answers 401 itself
    if (await authCore.authenticate(req, res)) return;

    await next();
  };
}
