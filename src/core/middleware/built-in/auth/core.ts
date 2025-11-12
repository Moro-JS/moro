// Auth Core - Reusable authentication logic with Better Auth
import crypto from 'crypto';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import { AuthOptions, AuthProvider, AuthSession, AuthRequest } from '../../../../types/auth.js';
import { safeVerifyJWT, createAuthErrorResponse } from './jwt-helpers.js';
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('AuthCore');

// ===== Auth.js Provider Factory Functions =====

export const providers = {
  // OAuth Providers - Better Auth native support
  google: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'google',
    name: 'Google',
    type: 'oauth' as const,
    authorization: 'https://accounts.google.com/oauth/authorize',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
    ...options,
  }),

  github: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'github',
    name: 'GitHub',
    type: 'oauth' as const,
    authorization: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    ...options,
  }),

  discord: (options: { clientId: string; clientSecret: string; scope?: string }): AuthProvider => ({
    id: 'discord',
    name: 'Discord',
    type: 'oauth' as const,
    authorization: 'https://discord.com/api/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    ...options,
  }),

  twitter: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'twitter',
    name: 'Twitter',
    type: 'oauth' as const,
    authorization: 'https://twitter.com/i/oauth2/authorize',
    token: 'https://api.twitter.com/2/oauth2/token',
    userinfo: 'https://api.twitter.com/2/users/me',
    ...options,
  }),

  microsoft: (options: {
    clientId: string;
    clientSecret: string;
    tenant?: string;
  }): AuthProvider => ({
    id: 'microsoft',
    name: 'Microsoft',
    type: 'oauth' as const,
    authorization: `https://login.microsoftonline.com/${options.tenant || 'common'}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${options.tenant || 'common'}/oauth2/v2.0/token`,
    userinfo: 'https://graph.microsoft.com/oidc/userinfo',
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  }),

  apple: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'apple',
    name: 'Apple',
    type: 'oauth' as const,
    authorization: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    ...options,
  }),

  facebook: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'facebook',
    name: 'Facebook',
    type: 'oauth' as const,
    authorization: 'https://www.facebook.com/v18.0/dialog/oauth',
    token: 'https://graph.facebook.com/v18.0/oauth/access_token',
    userinfo: 'https://graph.facebook.com/me?fields=id,name,email,picture',
    ...options,
  }),

  linkedin: (options: { clientId: string; clientSecret: string }): AuthProvider => ({
    id: 'linkedin',
    name: 'LinkedIn',
    type: 'oauth' as const,
    authorization: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    userinfo: 'https://api.linkedin.com/v2/me',
    ...options,
  }),

  // Traditional Providers
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

  // Modern Passwordless Authentication
  magicLink: (options: {
    from: string;
    sendMagicLink?: (email: string, url: string) => Promise<void>;
    expiresIn?: number; // in seconds, default 300 (5 minutes)
  }): AuthProvider => ({
    id: 'magic-link',
    name: 'Magic Link',
    type: 'email' as const,
    from: options.from,
    sendMagicLink: options.sendMagicLink,
    expiresIn: options.expiresIn || 300,
  }),

  otp: (options: {
    from?: string;
    sendOTP?: (contact: string, code: string) => Promise<void>;
    expiresIn?: number; // in seconds, default 300 (5 minutes)
    length?: number; // OTP code length, default 6
  }): AuthProvider => ({
    id: 'otp',
    name: 'One-Time Password',
    type: 'email' as const,
    from: options.from || '',
    sendOTP: options.sendOTP,
    expiresIn: options.expiresIn || 300,
    length: options.length || 6,
  }),

  passkey: (options: {
    rpName?: string; // Relying Party name
    rpId?: string; // Relying Party ID (usually your domain)
    origin?: string; // Origin URL
  }): AuthProvider => ({
    id: 'passkey',
    name: 'Passkey (WebAuthn)',
    type: 'credentials' as const,
    rpName: options.rpName || 'MoroJS App',
    rpId: options.rpId,
    origin: options.origin,
  }),
};

// ===== Two-Factor Authentication (2FA) Options =====
// 2FA in Better Auth is configured as a plugin, not a provider
// These helper types define 2FA configuration options

export interface TwoFactorAuthOptions {
  /**
   * Enable TOTP (Time-based One-Time Password) via authenticator apps
   * @default true
   */
  totp?: boolean;

  /**
   * Enable backup codes for account recovery
   * @default true
   */
  backupCodes?: boolean;

  /**
   * Number of backup codes to generate
   * @default 10
   */
  backupCodesCount?: number;

  /**
   * Trust device after successful 2FA verification
   * @default true
   */
  trustDevice?: boolean;

  /**
   * Duration to trust a device (in seconds)
   * @default 2592000 (30 days)
   */
  trustDeviceDuration?: number;

  /**
   * Issuer name for TOTP (shown in authenticator apps)
   */
  issuer?: string;
}

/**
 * Helper to create 2FA configuration
 * Usage in auth config:
 * ```ts
 * auth({
 *   plugins: [twoFactor({ issuer: 'MyApp' })],
 *   ...
 * })
 * ```
 */
export function twoFactor(options: TwoFactorAuthOptions = {}) {
  return {
    type: '2fa' as const,
    totp: options.totp !== false,
    backupCodes: options.backupCodes !== false,
    backupCodesCount: options.backupCodesCount || 10,
    trustDevice: options.trustDevice !== false,
    trustDeviceDuration: options.trustDeviceDuration || 2592000,
    issuer: options.issuer || 'MoroJS App',
  };
}

// ===== Additional Plugin Helpers =====

/**
 * Organization/Multi-tenant plugin configuration
 * Enables support for organizations, teams, and multi-tenant applications
 */
export interface OrganizationOptions {
  /**
   * Allow users to create organizations
   * @default true
   */
  allowUserCreate?: boolean;

  /**
   * Maximum number of organizations per user
   * @default 10
   */
  maxOrganizationsPerUser?: number;

  /**
   * Enable role-based access within organizations
   * @default true
   */
  organizationRoles?: boolean;
}

export function organization(options: OrganizationOptions = {}) {
  return {
    type: 'organization' as const,
    allowUserCreate: options.allowUserCreate !== false,
    maxOrganizationsPerUser: options.maxOrganizationsPerUser || 10,
    organizationRoles: options.organizationRoles !== false,
  };
}

/**
 * Anonymous user support
 * Allows users to interact with your app before signing up
 */
export interface AnonymousOptions {
  /**
   * Automatically link anonymous accounts when user signs up
   * @default true
   */
  linkOnSignUp?: boolean;

  /**
   * Anonymous session duration (in seconds)
   * @default 2592000 (30 days)
   */
  sessionDuration?: number;
}

export function anonymous(options: AnonymousOptions = {}) {
  return {
    type: 'anonymous' as const,
    linkOnSignUp: options.linkOnSignUp !== false,
    sessionDuration: options.sessionDuration || 2592000,
  };
}

/**
 * Account linking - allows users to link multiple auth providers to one account
 */
export interface AccountLinkingOptions {
  /**
   * Automatically link accounts with same email
   * @default false (requires user confirmation for security)
   */
  autoLinkSameEmail?: boolean;

  /**
   * Allow users to manually link additional providers
   * @default true
   */
  allowManualLink?: boolean;
}

export function accountLinking(options: AccountLinkingOptions = {}) {
  return {
    type: 'account-linking' as const,
    autoLinkSameEmail: options.autoLinkSameEmail || false,
    allowManualLink: options.allowManualLink !== false,
  };
}

/**
 * Rate limiting configuration for authentication endpoints
 */
export interface RateLimitOptions {
  /**
   * Maximum failed login attempts before lockout
   * @default 5
   */
  maxAttempts?: number;

  /**
   * Lockout duration in seconds
   * @default 900 (15 minutes)
   */
  lockoutDuration?: number;

  /**
   * Window to track attempts (in seconds)
   * @default 300 (5 minutes)
   */
  window?: number;
}

export function rateLimit(options: RateLimitOptions = {}) {
  return {
    type: 'rate-limit' as const,
    maxAttempts: options.maxAttempts || 5,
    lockoutDuration: options.lockoutDuration || 900,
    window: options.window || 300,
  };
}

/**
 * Bearer token support for API authentication
 */
export interface BearerTokenOptions {
  /**
   * Token expiration time (in seconds)
   * @default 3600 (1 hour)
   */
  expiresIn?: number;

  /**
   * Allow refresh tokens
   * @default true
   */
  refreshTokens?: boolean;

  /**
   * Refresh token expiration (in seconds)
   * @default 2592000 (30 days)
   */
  refreshTokenExpiresIn?: number;
}

export function bearerToken(options: BearerTokenOptions = {}) {
  return {
    type: 'bearer-token' as const,
    expiresIn: options.expiresIn || 3600,
    refreshTokens: options.refreshTokens !== false,
    refreshTokenExpiresIn: options.refreshTokenExpiresIn || 2592000,
  };
}

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
 * AuthCore - Core authentication logic with Better Auth
 * Used directly by the router for route-based authentication
 * Now delegates to the main morojs-adapter for Better Auth integration
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
   * Initialize Better Auth instance
   */
  async initialize(): Promise<void> {
    if (!this.config.providers || this.config.providers.length === 0) {
      throw new Error('At least one authentication provider must be configured');
    }

    try {
      this.authInstance = await initializeAuthJS(this.config);
      logger.info('Better Auth initialized successfully', 'Initialization');
    } catch (error) {
      logger.error('Failed to initialize Better Auth', 'InitializationError', { error });
      throw error;
    }
  }

  /**
   * Check if request is for Better Auth API routes
   */
  isAuthRoute(url?: string): boolean {
    if (!url) {
      return false;
    }
    const basePath = this.config.basePath || '/api/auth';
    return url.startsWith(basePath);
  }

  /**
   * Handle Better Auth API routes
   */
  async handleAuthRoute(req: HttpRequest, res: HttpResponse): Promise<any> {
    if (!this.authInstance) {
      throw new Error('Auth instance not initialized');
    }

    try {
      const response = await this.authInstance.handler(req, res);
      return response;
    } catch (error) {
      logger.error('Better Auth handler error', 'HandlerError', { error });
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
