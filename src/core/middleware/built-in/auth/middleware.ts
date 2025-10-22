// Auth Middleware - Standard (req, res, next) middleware function
import { StandardMiddleware } from '../../../../types/hooks.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { AuthCore } from './core.js';
import { AuthOptions } from '../../../../types/auth.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('AuthMiddleware');

/**
 * Create Auth middleware for use in middleware chains
 *
 * @example
 * ```ts
 * import { createAuthMiddleware, providers } from '@/middleware/built-in/auth';
 *
 * const authMw = createAuthMiddleware({
 *   secret: process.env.AUTH_SECRET,
 *   providers: [
 *     providers.google({
 *       clientId: process.env.GOOGLE_CLIENT_ID,
 *       clientSecret: process.env.GOOGLE_CLIENT_SECRET
 *     })
 *   ]
 * });
 *
 * app.use(authMw);
 * ```
 */
export function createAuthMiddleware(options: AuthOptions): StandardMiddleware {
  const authCore = new AuthCore(options);
  let initialized = false;

  return async (req: HttpRequest, res: HttpResponse, next: () => Promise<void>) => {
    // Initialize on first request
    if (!initialized) {
      await authCore.initialize();
      initialized = true;
    }

    const reqAny = req as any;

    // Handle Auth.js API routes first
    if (authCore.isAuthRoute(reqAny.url)) {
      const response = await authCore.handleAuthRoute(req, res);
      if (response) {
        return response;
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
    reqAny.auth = authRequest;

    if (authRequest.isAuthenticated) {
      logger.debug('User authenticated', 'Authentication', {
        userId: authRequest.user?.id,
        provider: authRequest.user?.provider || 'unknown',
      });
    }

    await next();

    // Update session after response
    if (authRequest.session) {
      await authCore.updateSession(authRequest.session);
    }
  };
}
