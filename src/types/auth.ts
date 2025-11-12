// Auth.js Types for MoroJS (Better Auth Compatible)
export interface AuthProvider {
  id: string;
  name: string;
  type: 'oauth' | 'oidc' | 'credentials' | 'email';

  // OAuth/OIDC specific
  authorization?: string | { url: string; params?: Record<string, any> };
  token?: string | { url: string; params?: Record<string, any> };
  userinfo?: string | { url: string; params?: Record<string, any> };
  issuer?: string;
  wellKnown?: string;

  // Client configuration
  clientId?: string;
  clientSecret?: string;

  // Scope and claims
  scope?: string;
  claims?: Record<string, any>;

  // Profile mapping
  profile?: (profile: any, tokens: any) => Promise<any> | any;

  // Custom authorization parameters
  authorization_params?: Record<string, any>;

  // Token handling
  token_endpoint_auth_method?: 'client_secret_post' | 'client_secret_basic';

  // Additional provider-specific options
  [key: string]: any;
}

export interface OAuthProvider extends AuthProvider {
  type: 'oauth';
  authorization: string | { url: string; params?: Record<string, any> };
  token: string | { url: string; params?: Record<string, any> };
  userinfo?: string | { url: string; params?: Record<string, any> };
}

export interface OIDCProvider extends AuthProvider {
  type: 'oidc';
  issuer: string;
  wellKnown?: string;
}

export interface CredentialsProvider extends AuthProvider {
  type: 'credentials';
  credentials: Record<
    string,
    {
      label?: string;
      type?: string;
      placeholder?: string;
      [key: string]: any;
    }
  >;
  authorize: (credentials: Record<string, any>, req: any) => Promise<any> | any;
}

export interface EmailProvider extends AuthProvider {
  type: 'email';
  server:
    | string
    | {
        host: string;
        port: number;
        auth: {
          user: string;
          pass: string;
        };
        secure?: boolean;
        tls?: any;
      };
  from: string;
  sendVerificationRequest?: (params: {
    identifier: string;
    url: string;
    expires: Date;
    provider: EmailProvider;
    token: string;
    theme: any;
    request: any;
  }) => Promise<void>;
}

export interface AuthUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  [key: string]: any;
}

export interface AuthAccount {
  userId: string;
  type: 'oauth' | 'oidc' | 'email' | 'credentials';
  provider: string;
  providerAccountId: string;
  access_token?: string;
  expires_at?: number;
  id_token?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  session_state?: string;
  [key: string]: any;
}

export interface AuthSession {
  sessionToken: string;
  userId: string;
  expires: Date;
  user: AuthUser;
  [key: string]: any;
}

export interface VerificationToken {
  identifier: string;
  token: string;
  expires: Date;
}

export interface AuthJWT {
  name?: string | null;
  email?: string | null;
  picture?: string | null;
  sub?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  [key: string]: any;
}

export interface AuthCallbacks {
  signIn?: (params: {
    user: AuthUser;
    account: AuthAccount | null;
    profile?: any;
    email?: { verificationRequest?: boolean };
    credentials?: Record<string, any>;
  }) => Awaitable<boolean | string>;

  redirect?: (params: { url: string; baseUrl: string }) => Awaitable<string>;

  session?: (params: {
    session: AuthSession;
    user: AuthUser;
    token: AuthJWT;
  }) => Awaitable<AuthSession>;

  jwt?: (params: {
    token: AuthJWT;
    user?: AuthUser;
    account?: AuthAccount;
    profile?: any;
    trigger?: 'signIn' | 'signUp' | 'update';
    isNewUser?: boolean;
    session?: any;
  }) => Awaitable<AuthJWT>;
}

export interface AuthPages {
  signIn?: string;
  signOut?: string;
  error?: string;
  verifyRequest?: string;
  newUser?: string;
}

export interface AuthEvents {
  signIn?: (message: {
    user: AuthUser;
    account: AuthAccount | null;
    profile?: any;
    isNewUser?: boolean;
  }) => Awaitable<void>;
  signOut?: (message: { session: AuthSession; token: AuthJWT }) => Awaitable<void>;
  createUser?: (message: { user: AuthUser }) => Awaitable<void>;
  updateUser?: (message: { user: AuthUser }) => Awaitable<void>;
  linkAccount?: (message: {
    user: AuthUser;
    account: AuthAccount;
    profile: any;
  }) => Awaitable<void>;
  session?: (message: { session: AuthSession; token: AuthJWT }) => Awaitable<void>;
}

export interface AuthCookies {
  sessionToken: {
    name: string;
    options?: CookieOptions;
  };
  callbackUrl: {
    name: string;
    options?: CookieOptions;
  };
  csrfToken: {
    name: string;
    options?: CookieOptions;
  };
  pkceCodeVerifier: {
    name: string;
    options?: CookieOptions;
  };
  state: {
    name: string;
    options?: CookieOptions;
  };
  nonce: {
    name: string;
    options?: CookieOptions;
  };
}

export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: 'strict' | 'lax' | 'none';
  secure?: boolean;
}

export interface AuthTheme {
  colorScheme?: 'light' | 'dark' | 'auto';
  logo?: string;
  brandColor?: string;
  buttonText?: string;
  [key: string]: any;
}

export interface AuthLogger {
  error: (code: string, metadata?: any) => void;
  warn: (code: string) => void;
  debug: (code: string, metadata?: any) => void;
}

export interface AuthAdapter {
  createUser?: (user: Omit<AuthUser, 'id'>) => Awaitable<AuthUser>;
  getUser?: (id: string) => Awaitable<AuthUser | null>;
  getUserByEmail?: (email: string) => Awaitable<AuthUser | null>;
  getUserByAccount?: (
    providerAccountId: Pick<AuthAccount, 'provider' | 'providerAccountId'>
  ) => Awaitable<AuthUser | null>;
  updateUser?: (user: Partial<AuthUser> & Pick<AuthUser, 'id'>) => Awaitable<AuthUser>;
  deleteUser?: (userId: string) => Awaitable<void>;
  linkAccount?: (account: AuthAccount) => Awaitable<void>;
  unlinkAccount?: (
    providerAccountId: Pick<AuthAccount, 'provider' | 'providerAccountId'>
  ) => Awaitable<void>;
  createSession?: (session: {
    sessionToken: string;
    userId: string;
    expires: Date;
  }) => Awaitable<AuthSession>;
  getSessionAndUser?: (
    sessionToken: string
  ) => Awaitable<{ session: AuthSession; user: AuthUser } | null>;
  updateSession?: (
    session: Partial<AuthSession> & Pick<AuthSession, 'sessionToken'>
  ) => Awaitable<AuthSession | null | undefined>;
  deleteSession?: (sessionToken: string) => Awaitable<void>;
  createVerificationToken?: (
    verificationToken: VerificationToken
  ) => Awaitable<VerificationToken | null | undefined>;
  useVerificationToken?: (params: {
    identifier: string;
    token: string;
  }) => Awaitable<VerificationToken | null>;
}

export interface AuthOptions {
  // Core configuration
  providers: AuthProvider[];
  secret?: string;

  // Session configuration
  session?: {
    strategy?: 'jwt' | 'database';
    maxAge?: number; // in seconds
    updateAge?: number; // in seconds
    generateSessionToken?: () => string;
  };

  // JWT configuration
  jwt?: {
    secret?: string;
    maxAge?: number;
    encode?: (params: { token?: AuthJWT; secret: string; maxAge?: number }) => Awaitable<string>;
    decode?: (params: { token?: string; secret: string }) => Awaitable<AuthJWT | null>;
  };

  // Callbacks
  callbacks?: AuthCallbacks;

  // Events
  events?: AuthEvents;

  // Adapter
  adapter?: AuthAdapter;

  // Pages
  pages?: AuthPages;

  // Cookies
  cookies?: Partial<AuthCookies>;

  // Theme
  theme?: AuthTheme;

  // Logger
  logger?: AuthLogger;

  // Configuration
  debug?: boolean;
  basePath?: string;
  useSecureCookies?: boolean;
  trustHost?: boolean;

  // CSRF
  skipCSRFCheck?: string[];

  // Experimental features
  experimental?: {
    enableWebAuthn?: boolean;
    [key: string]: any;
  };
}

export interface AuthRequest {
  user?: AuthUser;
  session?: AuthSession;
  token?: string;
  isAuthenticated: boolean;

  // Auth methods
  signIn: (
    provider?: string,
    options?: {
      callbackUrl?: string;
      redirect?: boolean;
      [key: string]: any;
    }
  ) => Promise<any>;

  signOut: (options?: { callbackUrl?: string; redirect?: boolean }) => Promise<any>;

  getSession: () => Promise<AuthSession | null>;
  getToken: () => Promise<AuthJWT | null>;

  // CSRF protection
  getCsrfToken: () => Promise<string>;

  // Providers
  getProviders: () => Promise<Record<string, AuthProvider>>;
}

export interface AuthResponse {
  status: number;
  headers?: Record<string, string>;
  body?: any;
  redirect?: string;
}

export interface AuthConfig extends AuthOptions {
  // Runtime configuration
  basePath: string;
  baseUrl: string;

  // Internal state
  providers: AuthProvider[];

  // Computed values
  skipCSRFCheck: string[];
  useSecureCookies: boolean;
}

// Utility types
export type Awaitable<T> = T | Promise<T>;

export type ProviderType = 'oauth' | 'oidc' | 'credentials' | 'email';

export type SignInOptions = {
  callbackUrl?: string;
  redirect?: boolean;
  [key: string]: any;
};

export type SignOutOptions = {
  callbackUrl?: string;
  redirect?: boolean;
};

// Error types
export interface AuthError extends Error {
  type: string;
  code?: string;
}

export class SignInError extends Error implements AuthError {
  type = 'SignInError';
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export class CallbackError extends Error implements AuthError {
  type = 'CallbackError';
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export class SessionError extends Error implements AuthError {
  type = 'SessionError';
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

// Re-export for convenience
export type { AuthProvider as Provider };
export type { AuthUser as User };
export type { AuthSession as Session };
export type { AuthAccount as Account };
export type { AuthJWT as JWT };
