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
          return authInstance.verifyJWT(authRequest.token || '');
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
        } catch (error) {
          logger.debug('Invalid JWT token', 'TokenValidation', { error });
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

// Mock Auth.js implementation (would be replaced with actual Auth.js)
async function initializeAuthJS(config: AuthOptions): Promise<any> {
  return {
    handler: async (req: any, res: any) => {
      // Mock Auth.js request handler
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
      // Mock session retrieval
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
      // Mock JWT verification
      try {
        // In real implementation, use jose or jsonwebtoken
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return payload;
      } catch {
        return null;
      }
    },

    signIn: async (provider?: string, options?: any) => {
      // Mock sign in
      return { url: `${config.basePath}/signin${provider ? `/${provider}` : ''}` };
    },

    signOut: async (options?: any) => {
      // Mock sign out
      return { url: `${config.basePath}/signout` };
    },

    updateSession: async (session: any) => {
      // Mock session update
      return session;
    },

    getCsrfToken: async () => {
      // Mock CSRF token generation
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
