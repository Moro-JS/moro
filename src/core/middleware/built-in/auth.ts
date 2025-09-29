// Auth.js Authentication Middleware

import { MiddlewareInterface, HookContext } from '../../../types/hooks';
import { createFrameworkLogger } from '../../logger';
import {
  AuthOptions,
  AuthProvider,
  AuthUser,
  AuthSession,
  AuthRequest,
  OAuthProvider,
  CredentialsProvider,
  EmailProvider,
} from '../../../types/auth';
import { safeVerifyJWT, createAuthErrorResponse } from './jwt-helpers';

const logger = createFrameworkLogger('AuthMiddleware');

// Auth.js provider factory functions
export const providers = {
  google: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'google',
    name: 'Google',
    type: 'oauth' as const,
    authorization: 'https://accounts.google.com/oauth/authorize',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
    ...options,
  }),

  github: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'github',
    name: 'GitHub',
    type: 'oauth' as const,
    authorization: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    ...options,
  }),

  discord: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'discord',
    name: 'Discord',
    type: 'oauth' as const,
    authorization: 'https://discord.com/api/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    ...options,
  }),

  credentials: (options: {
    name?: string;
    credentials: Record<string, any>;
    authorize: (credentials: any) => Promise<any>;
  }): AuthProvider => ({
    id: 'credentials',
    name: options.name || 'Credentials',
    type: 'credentials' as const,
    ...options,
  }),

  email: (options: {
    server: string | { host: string; port: number; auth: any };
    from: string;
  }): AuthProvider => ({
    id: 'email',
    name: 'Email',
    type: 'email' as const,
    ...options,
  }),
};

// Auth.js middleware that integrates with MoroJS's hooks system
export const auth = (options: AuthOptions): MiddlewareInterface => ({
  name: 'auth',
  version: '2.0.0',
  metadata: {
    name: 'auth',
    version: '2.0.0',
    description: 'Auth.js authentication middleware with OAuth, JWT, and session support',
    author: 'MoroJS Team',
    dependencies: [], // No dependencies - auth middleware is self-contained
    tags: ['authentication', 'oauth', 'jwt', 'security'],
  },

  install: async (hooks: any, middlewareOptions: Partial<AuthOptions> = {}) => {
    logger.debug('Installing Auth.js middleware', 'Installation', { options: middlewareOptions });

    // Merge configuration
    const config: AuthOptions = {
      secret: process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || 'default-secret',
      session: {
        strategy: 'jwt',
        maxAge: 30 * 24 * 60 * 60, // 30 days
        updateAge: 24 * 60 * 60, // 24 hours
      },
      basePath: '/api/auth',
      trustHost: true,
      debug: process.env.NODE_ENV === 'development',
      ...options,
      ...middlewareOptions,
    };

    if (!config.providers || config.providers.length === 0) {
      throw new Error('At least one authentication provider must be configured');
    }

    // Initialize Auth.js
    let authInstance: any;
    try {
      authInstance = await initializeAuthJS(config);
      logger.info('Auth.js initialized successfully', 'Initialization');
    } catch (error) {
      logger.error('Failed to initialize Auth.js', 'InitializationError', { error });
      throw error;
    }

    // Register hooks for request processing
    hooks.before('request', async (context: HookContext) => {
      const req = context.request as any;
      const res = context.response as any;

      // Handle Auth.js API routes first
      if (req.url?.startsWith(config.basePath!)) {
        try {
          const response = await authInstance.handler(req, res);
          if (response) {
            // Auth.js handled the request, don't call next()
            return response;
          }
        } catch (error) {
          logger.error('Auth.js handler error', 'HandlerError', { error });
          throw error;
        }
      }

      // Add auth object to request for all other routes

      // Extend request with auth methods
      const authRequest: AuthRequest = {
        user: undefined,
        session: undefined,
        token: undefined,
        isAuthenticated: false,
        signIn: async (provider?: string, options?: any) => {
          return authInstance.signIn(provider, options);
        },
        signOut: async (options?: any) => {
          return authInstance.signOut(options);
        },
        getSession: async () => {
          return authInstance.getSession({ req });
        },
        getToken: async () => {
          try {
            return authInstance.verifyJWT(authRequest.token || '');
          } catch (error: any) {
            // Handle JWT errors gracefully in getToken method
            logger.debug('Failed to verify token in getToken', 'TokenValidation', {
              error: error.message,
            });
            return null;
          }
        },
        getCsrfToken: async () => {
          return authInstance.getCsrfToken();
        },
        getProviders: async () => {
          return config.providers.reduce((acc: Record<string, AuthProvider>, provider) => {
            acc[provider.id] = provider;
            return acc;
          }, {});
        },
      };

      // Get session/token from request
      let session: AuthSession | null = null;
      let token: string | null = null;

      // Try JWT token first (Authorization header)
      const authHeader = req.headers?.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
        try {
          const decoded = await authInstance.verifyJWT(token);
          if (decoded) {
            session = await authInstance.getSession({ req: { ...req, token } });
          }
        } catch (error: any) {
          // Handle specific JWT errors gracefully and return proper HTTP responses
          if (error.name === 'TokenExpiredError') {
            logger.debug('JWT token expired', 'TokenValidation', {
              message: error.message,
              expiredAt: error.expiredAt,
            });

            // If this is a protected route request, return a proper 401 response
            if (req.headers.accept?.includes('application/json')) {
              return res.status(401).json(
                createAuthErrorResponse({
                  type: 'expired',
                  message: error.message,
                  expiredAt: error.expiredAt,
                })
              );
            }
          } else if (error.name === 'JsonWebTokenError') {
            logger.debug('Invalid JWT token format', 'TokenValidation', {
              message: error.message,
            });

            // If this is a protected route request, return a proper 401 response
            if (req.headers.accept?.includes('application/json')) {
              return res.status(401).json(
                createAuthErrorResponse({
                  type: 'invalid',
                  message: error.message,
                })
              );
            }
          } else if (error.name === 'NotBeforeError') {
            logger.debug('JWT token not active yet', 'TokenValidation', {
              message: error.message,
              date: error.date,
            });

            // If this is a protected route request, return a proper 401 response
            if (req.headers.accept?.includes('application/json')) {
              return res.status(401).json(
                createAuthErrorResponse({
                  type: 'malformed',
                  message: error.message,
                  date: error.date,
                })
              );
            }
          } else {
            logger.debug('JWT token validation failed', 'TokenValidation', {
              error: error.message || error,
            });
          }
          // Continue with unauthenticated state for non-API requests
        }
      }

      // Try session cookie if no valid token
      if (!session) {
        try {
          session = await authInstance.getSession({ req });
        } catch (error) {
          logger.debug('No valid session found', 'SessionValidation', { error });
        }
      }

      // Populate auth request
      if (session?.user) {
        authRequest.user = session.user;
        authRequest.session = session;
        authRequest.token = token || undefined;
        authRequest.isAuthenticated = true;

        logger.debug('User authenticated', 'Authentication', {
          userId: session.user.id,
          provider: session.user.provider || 'unknown',
        });
      }

      // Attach auth to request
      req.auth = authRequest;
    });

    // Response processing hook
    hooks.after('response', async (context: HookContext) => {
      const req = context.request as any;

      if (req.auth?.session) {
        // Update session activity if needed
        try {
          await authInstance.updateSession(req.auth.session);
        } catch (error) {
          logger.warn('Failed to update session', 'SessionUpdate', { error });
        }
      }
    });

    logger.info(
      `Auth.js middleware installed with ${config.providers.length} providers`,
      'Installation'
    );
  },
});

// Auth.js implementation with proper JWT handling
async function initializeAuthJS(config: AuthOptions): Promise<any> {
  return {
    handler: async (req: any, res: any) => {
      // Basic Auth.js request handler
      const path = req.url.replace(config.basePath!, '');

      if (path.startsWith('/signin')) {
        // Handle sign in
        return handleSignIn(req, res, config);
      } else if (path.startsWith('/signout')) {
        // Handle sign out
        return handleSignOut(req, res, config);
      } else if (path.startsWith('/callback')) {
        // Handle OAuth callback
        return handleCallback(req, res, config);
      } else if (path.startsWith('/session')) {
        // Handle session endpoint
        return handleSession(req, res, config);
      }

      return null;
    },

    getSession: async ({ req }: { req: any }) => {
      // Basic session retrieval
      const sessionId =
        req.cookies?.['next-auth.session-token'] ||
        req.cookies?.['__Secure-next-auth.session-token'];

      if (sessionId && req.session) {
        return {
          user: req.session.user || null,
          expires: new Date(Date.now() + config.session!.maxAge! * 1000).toISOString(),
        };
      }

      return null;
    },

    verifyJWT: async (token: string) => {
      const secret = process.env.JWT_SECRET || config.jwt?.secret || config.secret || '';

      // Use the safe JWT verification function
      const result = safeVerifyJWT(token, secret);

      if (!result.success) {
        // Create a custom error that includes the structured error information
        const customError = new Error(result.error?.message || 'JWT verification failed');

        // Add the error type information for upstream handling
        (customError as any).jwtErrorType = result.error?.type;
        (customError as any).jwtErrorDetails = result.error;

        // Map the safe error types back to standard JWT error names for compatibility
        if (result.error?.type === 'expired') {
          customError.name = 'TokenExpiredError';
          (customError as any).expiredAt = result.error.expiredAt;
        } else if (result.error?.type === 'invalid') {
          customError.name = 'JsonWebTokenError';
        } else if (result.error?.type === 'malformed') {
          customError.name = 'NotBeforeError';
          (customError as any).date = result.error.date;
        }

        throw customError;
      }

      return result.payload;
    },

    signIn: async (provider?: string, options?: any) => {
      // Basic sign in redirect
      return { url: `${config.basePath}/signin${provider ? `/${provider}` : ''}` };
    },

    signOut: async (options?: any) => {
      // Basic sign out redirect
      return { url: `${config.basePath}/signout` };
    },

    updateSession: async (session: any) => {
      // Basic session update
      return session;
    },

    getCsrfToken: async () => {
      // Basic CSRF token generation
      const crypto = require('crypto');
      return crypto.randomBytes(32).toString('hex');
    },
  };
}

// Mock Auth.js handlers
async function handleSignIn(req: any, res: any, config: AuthOptions) {
  // Implementation would depend on the provider
  logger.debug('Handling sign in request', 'SignIn');
  return null;
}

async function handleSignOut(req: any, res: any, config: AuthOptions) {
  // Clear session and redirect
  logger.debug('Handling sign out request', 'SignOut');
  return null;
}

async function handleCallback(req: any, res: any, config: AuthOptions) {
  // Handle OAuth callback
  logger.debug('Handling OAuth callback', 'Callback');
  return null;
}

async function handleSession(req: any, res: any, config: AuthOptions) {
  // Return current session
  logger.debug('Handling session request', 'Session');
  return null;
}
