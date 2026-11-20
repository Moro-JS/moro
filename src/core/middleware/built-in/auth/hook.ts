// Auth Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { AuthCore, type AuthMiddlewareOptions } from './core.js';

const logger = createFrameworkLogger('AuthMiddleware');

// app.use() calls the function stored under this key, when a middleware has
// one, with the app: the request hooks alone cannot serve routes after the
// application's global middleware (CORS, security headers).
const APP_INSTALL = Symbol.for('morojs.middleware.appInstall');

/**
 * Authentication for the whole app: `app.use(auth(options))`.
 *
 * Sets `req.auth` on every request, which is what the guards
 * (`requireAuth()`, `requireRole()`, ...) and a route's `.auth()` read.
 *
 * - **Bearer tokens.** `Authorization: Bearer <jwt>` is verified (HS256 unless
 *   `jwt.algorithms` says otherwise; `jwt.audience` / `jwt.issuer` when set)
 *   with the first of `jwt.secret`, `secret`, `JWT_SECRET`, `NEXTAUTH_SECRET`,
 *   `AUTH_SECRET`. A valid token authenticates the request as the user in its
 *   claims. Needs the `jsonwebtoken` package.
 * - **Sign-in.** With `providers` (or `betterAuth`) and the `better-auth`
 *   package installed, sign-in, callback, session and sign-out are served
 *   under `basePath` (default `/api/auth`) by the same Better Auth adapter
 *   `createAuthMiddleware()` uses, and its session authenticates the request.
 *   Without the package there are no sign-in routes, and start-up says so.
 * - **Feature helpers.** `plugins: [twoFactor(), organization(), anonymous(),
 *   bearerToken()]`, `accountLinking: accountLinking()` and
 *   `rateLimit: rateLimit()` turn on the Better Auth feature each one stands
 *   for; its routes are served under `basePath` with the sign-in routes. See
 *   each helper for its options and what it stores.
 *
 * @example
 * ```ts
 * import { auth, providers, requireAuth } from '@morojs/moro';
 *
 * await app.use(
 *   auth({
 *     secret: process.env.AUTH_SECRET,
 *     baseURL: 'https://app.example.com',
 *     providers: [
 *       providers.github({
 *         clientId: process.env.GITHUB_CLIENT_ID,
 *         clientSecret: process.env.GITHUB_CLIENT_SECRET,
 *       }),
 *     ],
 *   })
 * );
 *
 * app.get('/me').before(requireAuth()).handler(req => req.auth.user);
 * ```
 */
export const auth = (options: AuthMiddlewareOptions = {}): MiddlewareInterface => {
  let authCore: AuthCore | undefined;
  let ready: Promise<void> | undefined;

  const middleware: MiddlewareInterface = {
    name: 'auth',
    version: '2.0.0',
    metadata: {
      name: 'auth',
      version: '2.0.0',
      description: 'Better Auth authentication middleware with OAuth, JWT, and session support',
      author: 'MoroJS Team',
      dependencies: [],
      tags: ['authentication', 'oauth', 'jwt', 'security', 'better-auth'],
    },

    install: (hooks: any, middlewareOptions: Partial<AuthMiddlewareOptions> = {}) => {
      logger.debug('Installing auth middleware', 'Installation');

      const core = new AuthCore({ ...options, ...middlewareOptions });
      authCore = core;

      // Loading Better Auth takes a moment. The hook is registered now and
      // waits for it, so no request is served without req.auth meanwhile.
      const initializing = core.initialize();
      ready = initializing;

      hooks.before('request', async (context: HookContext) => {
        await initializing;
        const req = context.request as any;
        const res = context.response as any;
        // Answered by a hook that ran before this one: nothing left to do
        if (res && res.headersSent) return;

        if (core.isAuthRoute(req)) {
          // Mounted on an app, the sign-in routes are answered further on, in
          // its middleware chain. Installed straight into a MiddlewareManager
          // there is no chain to join: they are answered here.
          if (!core.isMountedOnApp()) await core.handleAuthRoute(req, res);
          return;
        }

        // Bearer token or session: sets req.auth, or answers 401 itself
        await core.authenticate(req, res);
      });

      return initializing.then(() => {
        logger.info(
          `Auth middleware installed with ${core.getProviderCount()} providers` +
            (core.hasSignInRoutes() ? ', sign-in routes served by Better Auth' : ''),
          'Installation'
        );
      });
    },
  };

  (middleware as any)[APP_INSTALL] = (app: unknown) => {
    if (authCore) authCore.installedOn(app);
    // Takes the routes' place in the app's middleware chain at once; they
    // start answering when Better Auth has loaded.
    if (authCore && ready && authCore.hasSignInRoutes()) authCore.mountRoutes(app, ready);
  };

  return middleware;
};
