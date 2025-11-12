// Auth Hook - MiddlewareInterface for global registration
import { MiddlewareInterface, HookContext } from '../../../../types/hooks.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { AuthCore } from './core.js';
import { AuthOptions } from '../../../../types/auth.js';

const logger = createFrameworkLogger('AuthMiddleware');

/**
 * Auth hook for global usage
 * Registers with the hooks system for application-wide Better Auth authentication
 *
 * @example
 * ```ts
 * import { auth, providers } from '@/middleware/built-in/auth';
 *
 * app.use(auth({
 *   secret: process.env.AUTH_SECRET,
 *   providers: [
 *     providers.google({
 *       clientId: process.env.GOOGLE_CLIENT_ID,
 *       clientSecret: process.env.GOOGLE_CLIENT_SECRET
 *     }),
 *     providers.github({
 *       clientId: process.env.GITHUB_CLIENT_ID,
 *       clientSecret: process.env.GITHUB_CLIENT_SECRET
 *     })
 *   ],
 *   session: {
 *     strategy: 'jwt',
 *     maxAge: 30 * 24 * 60 * 60
 *   }
 * }));
 * ```
 */
export const auth = (options: AuthOptions): MiddlewareInterface => ({
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

  install: async (hooks: any, middlewareOptions: Partial<AuthOptions> = {}) => {
    logger.debug('Installing Better Auth middleware', 'Installation', {
      options: middlewareOptions,
    });

    const config = { ...options, ...middlewareOptions };
    const authCore = new AuthCore(config);

    // Initialize Better Auth
    await authCore.initialize();

    // Register hooks for request processing
    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Handle Better Auth API routes first
      if (authCore.isAuthRoute(req.url)) {
        try {
          const response = await authCore.handleAuthRoute(req, res);
          if (response) {
            return response;
          }
        } catch (error) {
          logger.error('Better Auth handler error', 'HandlerError', { error });
          throw error;
        }
      }

      // Extract and verify JWT token
      const {
        token,
        session: tokenSession,
        error,
      } = await authCore.verifyToken(req.headers?.authorization);

      // Handle JWT errors for API requests
      if (error) {
        const errorResponse = authCore.handleJWTError(error, req, res);
        if (errorResponse) {
          return errorResponse;
        }
      }

      // Get session from cookie if no token session
      let session = tokenSession;
      if (!session) {
        session = await authCore.getSession(req);
      }

      // Create and attach auth request object
      const authRequest = authCore.createAuthRequest(session, token || undefined);
      req.auth = authRequest;

      if (authRequest.isAuthenticated) {
        logger.debug('User authenticated', 'Authentication', {
          userId: authRequest.user?.id,
          provider: authRequest.user?.provider || 'unknown',
        });
      }
    });

    // Response processing hook
    hooks.after('response', async (context: HookContext) => {
      const req = context.request as any;

      if (req.auth?.session) {
        await authCore.updateSession(req.auth.session);
      }
    });

    logger.info(
      `Better Auth middleware installed with ${authCore.getProviderCount()} providers`,
      'Installation'
    );
  },
});
