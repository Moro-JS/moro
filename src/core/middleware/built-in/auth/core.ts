// Auth Core - Reusable Auth.js authentication logic
import crypto from 'crypto';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { AuthOptions, AuthProvider, AuthSession, AuthRequest } from '../../../../types/auth.js';
import { safeVerifyJWT, createAuthErrorResponse } from './jwt-helpers.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('AuthCore');

// ===== Auth.js Provider Factory Functions =====

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

// ===== Auth.js Implementation =====

interface AuthInstance {
  handler: (req: any, res: any) => Promise<any>;
  getSession: ({ req }: { req: any }) => Promise<AuthSession | null>;
  verifyJWT: (token: string) => Promise<any>;
  signIn: (provider?: string, options?: any) => Promise<{ url: string }>;
  signOut: (options?: any) => Promise<{ url: string }>;
  updateSession: (session: any) => Promise<any>;
  getCsrfToken: () => Promise<string>;
}

async function handleSignIn(_req: any, _res: any, _config: AuthOptions) {
  logger.debug('Handling sign in request', 'SignIn');
  return null;
}

async function handleSignOut(_req: any, _res: any, _config: AuthOptions) {
  logger.debug('Handling sign out request', 'SignOut');
  return null;
}

async function handleCallback(_req: any, _res: any, _config: AuthOptions) {
  logger.debug('Handling OAuth callback', 'Callback');
  return null;
}

async function handleSession(_req: any, _res: any, _config: AuthOptions) {
  logger.debug('Handling session request', 'Session');
  return null;
}

async function initializeAuthJS(config: AuthOptions): Promise<AuthInstance> {
  return {
    handler: async (req: any, res: any) => {
      const basePath = config.basePath || '/api/auth';
      const path = req.url.replace(basePath, '');

      if (path.startsWith('/signin')) {
        return handleSignIn(req, res, config);
      } else if (path.startsWith('/signout')) {
        return handleSignOut(req, res, config);
      } else if (path.startsWith('/callback')) {
        return handleCallback(req, res, config);
      } else if (path.startsWith('/session')) {
        return handleSession(req, res, config);
      }

      return null;
    },

    getSession: async ({ req }: { req: any }) => {
      const sessionId =
        req.cookies?.['next-auth.session-token'] ||
        req.cookies?.['__Secure-next-auth.session-token'];

      if (sessionId && req.session) {
        const sessionMaxAge = config.session?.maxAge || 30 * 24 * 60 * 60;
        return {
          user: req.session.user || null,
          expires: new Date(Date.now() + sessionMaxAge * 1000),
          sessionToken: sessionId,
          userId: req.session.user?.id || '',
        };
      }

      return null;
    },

    verifyJWT: async (token: string) => {
      const secret = process.env.JWT_SECRET || config.jwt?.secret || config.secret || '';
      const result = await safeVerifyJWT(token, secret);

      if (!result.success) {
        const customError = new Error(result.error?.message || 'JWT verification failed');
        (customError as any).jwtErrorType = result.error?.type;
        (customError as any).jwtErrorDetails = result.error;

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

    signIn: async (provider?: string, _options?: any) => {
      return { url: `${config.basePath}/signin${provider ? `/${provider}` : ''}` };
    },

    signOut: async (_options?: any) => {
      return { url: `${config.basePath}/signout` };
    },

    updateSession: async (session: any) => {
      return session;
    },

    getCsrfToken: async () => {
      return crypto.randomBytes(32).toString('hex');
    },
  };
}

// ===== Core Logic =====

/**
 * AuthCore - Core Auth.js authentication logic
 * Used directly by the router for route-based authentication
 */
export class AuthCore {
  private config: AuthOptions;
  private authInstance: AuthInstance | null = null;

  constructor(options: AuthOptions) {
    this.config = {
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
    };
  }

  /**
   * Initialize Auth.js instance
   */
  async initialize(): Promise<void> {
    if (!this.config.providers || this.config.providers.length === 0) {
      throw new Error('At least one authentication provider must be configured');
    }

    try {
      this.authInstance = await initializeAuthJS(this.config);
      logger.info('Auth.js initialized successfully', 'Initialization');
    } catch (error) {
      logger.error('Failed to initialize Auth.js', 'InitializationError', { error });
      throw error;
    }
  }

  /**
   * Check if request is for Auth.js API routes
   */
  isAuthRoute(url?: string): boolean {
    if (!url) {
      return false;
    }
    const basePath = this.config.basePath || '/api/auth';
    return url.startsWith(basePath);
  }

  /**
   * Handle Auth.js API routes
   */
  async handleAuthRoute(req: HttpRequest, res: HttpResponse): Promise<any> {
    if (!this.authInstance) {
      throw new Error('Auth instance not initialized');
    }

    try {
      const response = await this.authInstance.handler(req, res);
      return response;
    } catch (error) {
      logger.error('Auth.js handler error', 'HandlerError', { error });
      throw error;
    }
  }

  /**
   * Extract and verify JWT token from request
   */
  async verifyToken(
    authHeader?: string
  ): Promise<{ token: string | null; session: AuthSession | null; error?: any }> {
    if (!authHeader?.startsWith('Bearer ') || !this.authInstance) {
      return { token: null, session: null };
    }

    const token = authHeader.substring(7);

    try {
      const decoded = await this.authInstance.verifyJWT(token);
      if (decoded) {
        const session = await this.authInstance.getSession({ req: { token } });
        return { token, session };
      }
    } catch (error: any) {
      return { token, session: null, error };
    }

    return { token: null, session: null };
  }

  /**
   * Get session from request
   */
  async getSession(req: HttpRequest): Promise<AuthSession | null> {
    if (!this.authInstance) {
      return null;
    }

    try {
      return await this.authInstance.getSession({ req });
    } catch (error) {
      logger.debug('No valid session found', 'SessionValidation', { error });
      return null;
    }
  }

  /**
   * Create auth request object with methods
   */
  createAuthRequest(session: AuthSession | null, token?: string): AuthRequest {
    const authRequest: AuthRequest = {
      user: session?.user || undefined,
      session: session || undefined,
      token: token || undefined,
      isAuthenticated: !!session?.user,
      signIn: async (provider?: string, options?: any) => {
        if (!this.authInstance) {
          throw new Error('Auth instance not initialized');
        }
        return this.authInstance.signIn(provider, options);
      },
      signOut: async (options?: any) => {
        if (!this.authInstance) {
          throw new Error('Auth instance not initialized');
        }
        return this.authInstance.signOut(options);
      },
      getSession: async () => {
        if (!this.authInstance) {
          return null;
        }
        return this.authInstance.getSession({ req: {} });
      },
      getToken: async () => {
        if (!this.authInstance || !token) {
          return null;
        }
        try {
          return this.authInstance.verifyJWT(token);
        } catch (error: any) {
          logger.debug('Failed to verify token in getToken', 'TokenValidation', {
            error: error.message,
          });
          return null;
        }
      },
      getCsrfToken: async () => {
        if (!this.authInstance) {
          return '';
        }
        return this.authInstance.getCsrfToken();
      },
      getProviders: async () => {
        return this.config.providers.reduce((acc: Record<string, AuthProvider>, provider) => {
          acc[provider.id] = provider;
          return acc;
        }, {});
      },
    };

    return authRequest;
  }

  /**
   * Handle JWT verification errors
   */
  handleJWTError(error: any, req: HttpRequest, res: HttpResponse): any | null {
    const acceptsJson = req.headers.accept?.includes('application/json');

    if (error.name === 'TokenExpiredError') {
      logger.debug('JWT token expired', 'TokenValidation', {
        message: error.message,
        expiredAt: error.expiredAt,
      });

      if (acceptsJson) {
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

      if (acceptsJson) {
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

      if (acceptsJson) {
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

    return null;
  }

  /**
   * Update session activity
   */
  async updateSession(session: AuthSession): Promise<void> {
    if (!this.authInstance) {
      return;
    }

    try {
      await this.authInstance.updateSession(session);
    } catch (error) {
      logger.warn('Failed to update session', 'SessionUpdate', { error });
    }
  }

  /**
   * Get provider count
   */
  getProviderCount(): number {
    return this.config.providers.length;
  }
}
