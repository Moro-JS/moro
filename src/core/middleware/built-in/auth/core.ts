// Auth Core - Reusable authentication logic with Better Auth
import crypto from 'crypto';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import {
  AuthOptions,
  AuthProvider,
  AuthSession,
  AuthRequest,
  AuthUser,
  AuthJWT,
} from '../../../../types/auth.js';
import { safeVerifyJWT, createAuthErrorResponse } from './jwt-helpers.js';
import { createFrameworkLogger } from '../../../logger/index.js';
import { resolveUserPackage } from '../../../utilities/package-utils.js';
import {
  MoroJSAuth,
  mountAuthRoutes,
  isBetterAuthInstalled,
  checkAuthStorage,
  servedByApp,
  type MoroJSAuthConfig,
  type MoroJSAuthHandlers,
} from '../../../auth/morojs-adapter.js';
import {
  authFeatureNames,
  helperSettings,
  usesAuthFeatures,
  type AccountLinkingSettings,
  type AnonymousSettings,
  type AuthFeatureOptions,
  type BearerTokenSettings,
  type OrganizationSettings,
  type RateLimitSettings,
  type TwoFactorSettings,
} from '../../../auth/feature-helpers.js';

const logger = createFrameworkLogger('AuthCore');

// ===== Better Auth Provider Factory Functions =====
//
// Each helper builds a provider entry for `auth({ providers })` /
// `createAuthMiddleware({ providers })`. The OAuth entries name a Better Auth
// social provider and are configured on it. `credentials`, `email`,
// `magicLink`, `otp` and `passkey` describe sign-in methods that are not
// social providers: Better Auth has them as options and plugins
// (`emailAndPassword`, the `magicLink` / `emailOTP` / `passkey` plugins), to
// be passed through `betterAuth`. An entry from those five is not configured,
// and start-up logs a warning naming it.

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
    // Kept under its own name too: the Better Auth adapter reads the entry's
    // fields, not the URLs above
    ...(options.tenant !== undefined ? { tenant: options.tenant } : {}),
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

// ===== Feature helpers =====
//
// twoFactor(), organization(), anonymous() and bearerToken() each stand for a
// Better Auth plugin; accountLinking() and rateLimit() for a Better Auth
// option. They are passed to auth() or createAuthMiddleware():
//
//   auth({
//     plugins: [twoFactor(), organization(), anonymous(), bearerToken()],
//     accountLinking: accountLinking(),
//     rateLimit: rateLimit(),
//     betterAuth: { database, emailAndPassword: { enabled: true } },
//   })
//
// Each returns a settings object with its defaults filled in. The Better Auth
// adapter (core/auth/feature-helpers) loads the plugin from the application's
// `better-auth` and maps the settings onto the plugin's own options; an
// option Better Auth has no equivalent for is named in a start-up warning.
// What the plugins add (routes under `basePath`, fields on the user and the
// session) is served by the routes auth() already mounts.

export interface TwoFactorAuthOptions {
  /**
   * TOTP codes from an authenticator app. `false` turns them off (Better
   * Auth's `totpOptions.disable`), which leaves the plugin's emailed one-time
   * codes: pass `betterAuth: { otpOptions: { sendOTP } }` for those.
   * @default true
   */
  totp?: boolean;

  /**
   * Backup codes for account recovery. `false` issues none (Better Auth's
   * `backupCodeOptions.amount: 0`).
   * @default true
   */
  backupCodes?: boolean;

  /**
   * Number of backup codes issued when two-factor is enabled (Better Auth's
   * `backupCodeOptions.amount`).
   * @default 10
   */
  backupCodesCount?: number;

  /**
   * Let a user who verifies with `trustDevice: true` skip the second factor
   * on that device. `false` lets no device be trusted (Better Auth's
   * `trustDeviceMaxAge: 0`).
   * @default true
   */
  trustDevice?: boolean;

  /**
   * How long a trusted device stays trusted, in seconds (Better Auth's
   * `trustDeviceMaxAge`).
   * @default 2592000 (30 days)
   */
  trustDeviceDuration?: number;

  /**
   * The name an authenticator app shows for the account (Better Auth's
   * `issuer`). Left out, it is `betterAuth.appName` when the application set
   * one, and `'MoroJS App'` otherwise.
   */
  issuer?: string;

  /**
   * Options handed to Better Auth's `twoFactor` plugin as they are, over the
   * ones derived from the options above: `otpOptions`, `totpOptions`,
   * `accountLockout`, `skipVerificationOnEnable`, ...
   */
  betterAuth?: Record<string, any>;
}

/**
 * Two-factor authentication: Better Auth's `twoFactor` plugin.
 *
 * Pass it in `plugins`. A signed-in user enables it with
 * `POST <basePath>/two-factor/enable` (password in the body; answers the
 * `totpURI` for the authenticator app and the backup codes) and confirms with
 * `POST <basePath>/two-factor/verify-totp`. From then on a password sign-in
 * answers `{ twoFactorRedirect: true }` with no session, and the session is
 * issued by `verify-totp` or `verify-backup-code`. `req.auth.user.twoFactorEnabled`
 * tells whether the user has it on.
 *
 * Stores: table `twoFactor`, column `user.twoFactorEnabled`.
 *
 * @example
 * ```ts
 * app.use(
 *   auth({
 *     plugins: [twoFactor({ issuer: 'Acme' })],
 *     betterAuth: { database, emailAndPassword: { enabled: true } },
 *   })
 * );
 * ```
 */
export function twoFactor(options: TwoFactorAuthOptions = {}): TwoFactorSettings {
  return helperSettings(
    {
      type: '2fa' as const,
      totp: options.totp !== false,
      backupCodes: options.backupCodes !== false,
      backupCodesCount: options.backupCodesCount || 10,
      trustDevice: options.trustDevice !== false,
      trustDeviceDuration: options.trustDeviceDuration || 2592000,
      issuer: options.issuer || 'MoroJS App',
      ...(options.betterAuth !== undefined ? { betterAuth: options.betterAuth } : {}),
    },
    options
  );
}

/**
 * Organizations (multi-tenant applications): options of `organization()`
 */
export interface OrganizationOptions {
  /**
   * Allow users to create organizations (Better Auth's
   * `allowUserToCreateOrganization`).
   * @default true
   */
  allowUserCreate?: boolean;

  /**
   * How many organizations a user may belong to and still create another
   * (Better Auth's `organizationLimit`). Better Auth on its own sets no
   * limit; this helper's default is 10.
   * @default 10
   */
  maxOrganizationsPerUser?: number;

  /**
   * Member roles within an organization. Better Auth's organizations always
   * have them (owner, admin, member), so `true` changes nothing and `false`
   * cannot be honoured: it is named in a start-up warning.
   * @default true
   */
  organizationRoles?: boolean;

  /**
   * Options handed to Better Auth's `organization` plugin as they are, over
   * the ones derived from the options above: `sendInvitationEmail`, `teams`,
   * `membershipLimit`, `creatorRole`, `ac`, `roles`, ...
   */
  betterAuth?: Record<string, any>;
}

/**
 * Organizations: Better Auth's `organization` plugin.
 *
 * Pass it in `plugins`. It serves the organization routes under
 * `<basePath>/organization/` (`create`, `list`, `set-active`,
 * `get-full-organization`, `invite-member`, ...) and keeps the organization a
 * session is working in on the session: `req.auth.session.activeOrganizationId`.
 *
 * Stores: tables `organization`, `member`, `invitation`, column
 * `session.activeOrganizationId`.
 *
 * @example
 * ```ts
 * app.use(
 *   auth({
 *     plugins: [organization({ maxOrganizationsPerUser: 3 })],
 *     betterAuth: { database, emailAndPassword: { enabled: true } },
 *   })
 * );
 * ```
 */
export function organization(options: OrganizationOptions = {}): OrganizationSettings {
  return helperSettings(
    {
      type: 'organization' as const,
      allowUserCreate: options.allowUserCreate !== false,
      maxOrganizationsPerUser: options.maxOrganizationsPerUser || 10,
      organizationRoles: options.organizationRoles !== false,
      ...(options.betterAuth !== undefined ? { betterAuth: options.betterAuth } : {}),
    },
    options
  );
}

/**
 * Anonymous users: options of `anonymous()`
 */
export interface AnonymousOptions {
  /**
   * What happens to the anonymous user when its visitor signs up or signs
   * in. `true` is Better Auth's behaviour: `onLinkAccount` (pass it as
   * `betterAuth: { onLinkAccount }`) is called with the anonymous user and
   * the new one, for the application to move the visitor's data across, and
   * the anonymous user is then deleted. `false` leaves the anonymous user in
   * place (Better Auth's `disableDeleteAnonymousUser`, which also refuses
   * `POST <basePath>/delete-anonymous-user`).
   * @default true
   */
  linkOnSignUp?: boolean;

  /**
   * Not applied: Better Auth has one session lifetime for every user
   * (`session.maxAge`, 30 days unless set). A value given here that differs
   * from it is named in a start-up warning.
   * @default 2592000 (30 days)
   */
  sessionDuration?: number;

  /**
   * Options handed to Better Auth's `anonymous` plugin as they are, over the
   * ones derived from the options above: `onLinkAccount`, `emailDomainName`,
   * `generateName`, ...
   */
  betterAuth?: Record<string, any>;
}

/**
 * Anonymous users: Better Auth's `anonymous` plugin.
 *
 * Pass it in `plugins`. `POST <basePath>/sign-in/anonymous` creates a user
 * with no credentials and signs it in; `req.auth.user.isAnonymous` is `true`
 * for it. When that visitor later signs up or signs in, the session moves to
 * the real user (see `linkOnSignUp`).
 *
 * Stores: column `user.isAnonymous`.
 *
 * @example
 * ```ts
 * app.use(
 *   auth({
 *     plugins: [
 *       anonymous({
 *         betterAuth: {
 *           onLinkAccount: async ({ anonymousUser, newUser }) => {
 *             await carts.move(anonymousUser.user.id, newUser.user.id);
 *           },
 *         },
 *       }),
 *     ],
 *     betterAuth: { database, emailAndPassword: { enabled: true } },
 *   })
 * );
 * ```
 */
export function anonymous(options: AnonymousOptions = {}): AnonymousSettings {
  return helperSettings(
    {
      type: 'anonymous' as const,
      linkOnSignUp: options.linkOnSignUp !== false,
      sessionDuration: options.sessionDuration || 2592000,
      ...(options.betterAuth !== undefined ? { betterAuth: options.betterAuth } : {}),
    },
    options
  );
}

/**
 * Account linking (several sign-in providers on one user): options of
 * `accountLinking()`
 */
export interface AccountLinkingOptions {
  /**
   * Link a provider sign-in to the existing user with the same email address
   * without asking. `false` is Better Auth's `disableImplicitLinking: true`:
   * such a sign-in is refused (`account_not_linked`) and the user links the
   * provider while signed in. `true` leaves Better Auth's own conditions in
   * force: the provider must report the address as verified (or be listed in
   * `betterAuth.account.accountLinking.trustedProviders`) and the existing
   * user's address must be verified. Better Auth on its own links
   * automatically; this helper's default does not.
   * @default false
   */
  autoLinkSameEmail?: boolean;

  /**
   * Let a signed-in user link another provider (`POST <basePath>/link-social`).
   * `false` together with `autoLinkSameEmail: false` turns linking off
   * (Better Auth's `enabled: false`). `false` together with
   * `autoLinkSameEmail: true` cannot be honoured, and is named in a start-up
   * warning: Better Auth cannot turn off only the manual kind.
   * @default true
   */
  allowManualLink?: boolean;
}

/**
 * Account linking: Better Auth's `account.accountLinking` option.
 *
 * Pass it as `accountLinking`. A key the application also sets in
 * `betterAuth.account.accountLinking` (`trustedProviders`,
 * `allowDifferentEmails`, ...) is the one used.
 *
 * Stores nothing of its own: linked providers are rows of Better Auth's
 * `account` table.
 *
 * @example
 * ```ts
 * app.use(auth({ providers, accountLinking: accountLinking(), betterAuth: { database } }));
 * ```
 */
export function accountLinking(options: AccountLinkingOptions = {}): AccountLinkingSettings {
  return helperSettings(
    {
      type: 'account-linking' as const,
      autoLinkSameEmail: options.autoLinkSameEmail || false,
      allowManualLink: options.allowManualLink !== false,
    },
    options
  );
}

/**
 * Rate limit of the sign-in routes: options of `rateLimit()`
 */
export interface RateLimitOptions {
  /**
   * Sign-in attempts one client address may make within `window` (the `max`
   * of Better Auth's rule for `/sign-in/*`). Better Auth counts every
   * attempt, successful or not; the next one is answered `429`.
   * @default 5
   */
  maxAttempts?: number;

  /**
   * Not applied: Better Auth's rate limiter has no separate lockout. A client
   * that has used its attempts is refused until `window` seconds have passed
   * since the last attempt that was counted. A value given here that differs
   * from `window` is named in a start-up warning.
   * @default 900 (15 minutes)
   */
  lockoutDuration?: number;

  /**
   * The window attempts are counted in, in seconds (the `window` of Better
   * Auth's rule for `/sign-in/*`).
   * @default 300 (5 minutes)
   */
  window?: number;
}

/**
 * Rate limit of the sign-in routes: Better Auth's `rateLimit` option.
 *
 * Pass it as `rateLimit`. It turns Better Auth's rate limiter on in every
 * environment (on its own it runs in production only) and sets the rule for
 * the routes under `<basePath>/sign-in/`: `maxAttempts` requests per client
 * address within `window` seconds, then `429` with an `X-Retry-After` header.
 * Better Auth's own limits for its other routes apply as well once the
 * limiter is on. A key the application also sets in `betterAuth.rateLimit`
 * (`storage`, `customRules`, `enabled`, ...) is the one used.
 *
 * Counts are kept in the memory of the process unless
 * `betterAuth: { rateLimit: { storage: 'database' } }` says otherwise (table
 * `rateLimit`).
 *
 * @example
 * ```ts
 * app.use(
 *   auth({
 *     rateLimit: rateLimit({ maxAttempts: 5, window: 300 }),
 *     betterAuth: { database, emailAndPassword: { enabled: true } },
 *   })
 * );
 * ```
 */
export function rateLimit(options: RateLimitOptions = {}): RateLimitSettings {
  return helperSettings(
    {
      type: 'rate-limit' as const,
      maxAttempts: options.maxAttempts || 5,
      lockoutDuration: options.lockoutDuration || 900,
      window: options.window || 300,
    },
    options
  );
}

/**
 * Session tokens as Bearer tokens: options of `bearerToken()`
 */
export interface BearerTokenOptions {
  /**
   * Not applied: the token is the session token and lives as long as the
   * session (`session.maxAge`). A value given here is named in a start-up
   * warning.
   * @default 3600 (1 hour)
   */
  expiresIn?: number;

  /**
   * Not applied: there are no refresh tokens. Better Auth extends a session
   * that is in use (`session.updateAge`). A value given here is named in a
   * start-up warning.
   * @default true
   */
  refreshTokens?: boolean;

  /**
   * Not applied: there are no refresh tokens. A value given here is named in
   * a start-up warning.
   * @default 2592000 (30 days)
   */
  refreshTokenExpiresIn?: number;

  /**
   * Options handed to Better Auth's `bearer` plugin as they are:
   * `requireSignature`.
   */
  betterAuth?: Record<string, any>;
}

/**
 * Session tokens as Bearer tokens: Better Auth's `bearer` plugin.
 *
 * Pass it in `plugins`. A sign-in then also answers the session token in the
 * `set-auth-token` response header, and a request that sends it as
 * `Authorization: Bearer <token>` is authenticated as that session, on the
 * auth routes and on the application's own (`req.auth`), with no cookie.
 *
 * This is beside `auth({ jwt })`, not instead of it: a Bearer token is first
 * verified as a JWT signed with the application's secret, exactly as without
 * this helper, and only a token that is not such a JWT is offered to Better
 * Auth as a session token.
 *
 * Stores nothing of its own.
 *
 * @example
 * ```ts
 * app.use(
 *   auth({
 *     plugins: [bearerToken()],
 *     betterAuth: { database, emailAndPassword: { enabled: true } },
 *   })
 * );
 * ```
 */
export function bearerToken(options: BearerTokenOptions = {}): BearerTokenSettings {
  return helperSettings(
    {
      type: 'bearer-token' as const,
      expiresIn: options.expiresIn || 3600,
      refreshTokens: options.refreshTokens !== false,
      refreshTokenExpiresIn: options.refreshTokenExpiresIn || 2592000,
      ...(options.betterAuth !== undefined ? { betterAuth: options.betterAuth } : {}),
    },
    options
  );
}

// ===== Auth Implementation =====

/**
 * What `auth()` takes: `AuthOptions`, with `providers` optional (an API that
 * only verifies Bearer tokens has none) and the keys that reach Better Auth,
 * among them the feature helpers: `plugins: [twoFactor(), organization(),
 * anonymous(), bearerToken()]`, `accountLinking: accountLinking()`,
 * `rateLimit: rateLimit()`.
 */
export type AuthMiddlewareOptions = Omit<AuthOptions, 'providers' | 'jwt'> & {
  providers?: AuthProvider[];
  jwt?: AuthOptions['jwt'] & {
    /** Accepted `aud` claim(s). A token for another audience is refused. */
    audience?: string | string[];
    /** Accepted `iss` claim(s). */
    issuer?: string | string[];
    /** Accepted signing algorithms. Default `['HS256']`. */
    algorithms?: string[];
  };
  /** The public URL of the application, for OAuth redirect URIs. */
  baseURL?: string;
  /** Origins allowed to call the sign-in routes and to be redirected to. */
  trustedOrigins?: string[];
  /** Options handed to `betterAuth()` as they are (database, plugins, ...). */
  betterAuth?: Record<string, any>;
  /** `false`: do not serve the sign-in routes; `req.auth` is still set. */
  mountRoutes?: boolean;
} & AuthFeatureOptions;

// Claims that describe the token rather than its holder
const REGISTERED_CLAIMS = new Set(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The user a verified token stands for, or null when the token names nobody.
 *
 * `sub` (or `userId`, or `id`) becomes `user.id`. Every other claim that is
 * not one of the registered JWT claims is copied onto the user as it is, so
 * `name`, `email`, `roles`, `permissions` and an application's own claims are
 * what the guards and `req.auth.user` see. `picture` is also offered as
 * `image`.
 */
function userFromClaims(claims: Record<string, any>): AuthUser | null {
  const subject = claims.sub ?? claims.userId ?? claims.id;
  if (subject === undefined || subject === null || subject === '') return null;
  if (typeof subject !== 'string' && typeof subject !== 'number') return null;

  const user: AuthUser = { id: String(subject) };
  for (const key of Object.keys(claims)) {
    if (key === 'id' || REGISTERED_CLAIMS.has(key) || UNSAFE_KEYS.has(key)) continue;
    user[key] = claims[key];
  }
  if (user.image === undefined && typeof claims.picture === 'string') {
    user.image = claims.picture;
  }
  return user;
}

/** True when the application can load `name` (the way the JWT helper does). */
function canResolve(name: string): boolean {
  try {
    resolveUserPackage(name);
    return true;
  } catch {
    return false;
  }
}

function tokenError(name: string, message: string, details: Record<string, any> = {}): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, details);
  return error;
}

// Keys of the options that only make sense with Better Auth's sign-in routes.
// When the routes are not there, naming them beats accepting them in silence.
const SIGN_IN_ONLY_KEYS = ['callbacks', 'events', 'pages', 'adapter', 'cookies', 'theme'] as const;

// ===== Core Logic =====

// Provider fields that never leave the server through req.auth.getProviders().
// `server` is the email provider's SMTP connection (URL or object with
// credentials).
const PRIVATE_PROVIDER_FIELDS = new Set([
  'clientSecret',
  'secret',
  'apiKey',
  'privateKey',
  'password',
  'server',
]);

/**
 * A copy of a provider entry without credentials and without function-valued
 * fields (authorize, profile, send hooks); id, name, type and the remaining
 * descriptive fields are kept.
 */
function publicProviderInfo(provider: AuthProvider): AuthProvider {
  const info: Record<string, any> = {};
  for (const key of Object.keys(provider)) {
    if (PRIVATE_PROVIDER_FIELDS.has(key)) continue;
    const value = provider[key];
    if (typeof value === 'function') continue;
    info[key] = value;
  }
  return info as AuthProvider;
}

/**
 * AuthCore - what `auth()` does for a request
 *
 * - a `Authorization: Bearer <jwt>` header is verified and, when valid,
 *   authenticates the request from the token's claims;
 * - when providers are configured and `better-auth` is installed, sign-in,
 *   callback, session and sign-out are served by the Better Auth adapter
 *   (core/auth/morojs-adapter) and its session authenticates the request;
 * - the result is `req.auth`.
 */
export class AuthCore {
  private config: AuthMiddlewareOptions & { providers: AuthProvider[]; basePath: string };
  private options: AuthMiddlewareOptions;
  private jwtSecret: string;
  private betterAuth: MoroJSAuthHandlers | null = null;
  private wantsBetterAuth: boolean;
  private signInRoutes: boolean;
  private answeredOnApp: ((req: any) => boolean) | null = null;
  private app: unknown = undefined;
  private initialized = false;
  private cachedProviderMap: Record<string, AuthProvider> | null = null;

  constructor(options: AuthMiddlewareOptions = {}) {
    this.options = options;

    const secret =
      options.secret ||
      process.env.NEXTAUTH_SECRET ||
      process.env.AUTH_SECRET ||
      (() => {
        // A JWT-only setup configured through jwt.secret or JWT_SECRET has
        // its secret; nothing is missing
        if (options.jwt?.secret || process.env.JWT_SECRET) return undefined;
        const generated = crypto.randomBytes(32).toString('hex');
        logger.warn(
          '[MoroJS Security] No secret configured for auth. A random secret was generated — sessions will NOT survive restarts. Set an explicit secret for production use.',
          'AuthCore'
        );
        return generated;
      })();

    this.config = {
      session: {
        strategy: 'jwt',
        maxAge: 30 * 24 * 60 * 60, // 30 days
        updateAge: 24 * 60 * 60, // 24 hours
      },
      trustHost: true,
      debug: process.env.NODE_ENV === 'development',
      ...options,
      ...(secret !== undefined ? { secret: options.secret || secret } : {}),
      basePath: options.basePath || '/api/auth',
      providers: options.providers || [],
    };

    // Sign-in runs on Better Auth: asked for by configuring providers, a
    // feature helper (or handing Better Auth options through), available when
    // it is installed
    this.wantsBetterAuth =
      (options.providers !== undefined && options.providers.length > 0) ||
      options.betterAuth !== undefined ||
      usesAuthFeatures(options);
    this.signInRoutes =
      this.wantsBetterAuth && options.mountRoutes !== false && isBetterAuthInstalled();

    // The secret a Bearer token is verified with: what the options name
    // first, then the environment. JWT_SECRET is the environment's JWT-specific
    // name and never overrides an option.
    this.jwtSecret = (options.jwt?.secret ||
      options.secret ||
      process.env.JWT_SECRET ||
      secret) as string;
  }

  /**
   * Start-up work: connect the sign-in routes to Better Auth when they are
   * asked for and the package is there, and say so when it is not.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const wantsSignIn = this.wantsBetterAuth;

    if (wantsSignIn && isBetterAuthInstalled()) {
      try {
        this.betterAuth = await MoroJSAuth(this.adapterConfig());
        if (this.app !== undefined) servedByApp(this.betterAuth, this.app);
        await checkAuthStorage(this.betterAuth);
        logger.info(
          `Sign-in routes served by Better Auth under ${this.betterAuth.basePath}`,
          'Initialization'
        );
      } catch (error) {
        logger.error('Failed to initialize Better Auth', 'InitializationError', { error });
        throw error;
      }
    } else {
      if (wantsSignIn) {
        const helpers = authFeatureNames(this.options);
        if (this.config.providers.length > 0 || this.options.betterAuth !== undefined) {
          logger.warn(
            `auth(): providers are configured but the 'better-auth' package is not installed, so no ` +
              `sign-in routes exist under ${this.config.basePath}. Install it (npm install better-auth) ` +
              `to serve sign-in, callback, session and sign-out. Bearer tokens and the guards work without it.`,
            'Initialization'
          );
        }
        if (helpers.length > 0) {
          logger.warn(
            `auth(): ${helpers.join(', ')} ${helpers.length === 1 ? 'is' : 'are'} not active: ` +
              `${helpers.length === 1 ? 'it runs' : 'they run'} on the 'better-auth' package, which is ` +
              `not installed, and no routes exist under ${this.config.basePath}. Install it: ` +
              `npm install better-auth`,
            'Initialization'
          );
        }
      }
      for (const key of SIGN_IN_ONLY_KEYS) {
        if ((this.options as Record<string, unknown>)[key] !== undefined) {
          logger.warn(
            `auth(): '${key}' is not used: it has no effect without Better Auth's sign-in routes, ` +
              `and with them see the Better Auth adapter's \`betterAuth\` option.`,
            'Initialization'
          );
        }
      }
    }

    if (this.options.jwt?.encode !== undefined) {
      logger.warn(
        "auth(): 'jwt.encode' is not used: auth() verifies Bearer tokens, it does not issue them. " +
          'Sign tokens with your JWT library and the same secret.',
        'Initialization'
      );
    }
    if (this.options.jwt?.decode === undefined && !canResolve('jsonwebtoken')) {
      logger.info(
        "auth(): Bearer tokens are not verified because the 'jsonwebtoken' package is not installed " +
          '(npm install jsonwebtoken); a request that sends one stays unauthenticated.',
        'Initialization'
      );
    }
  }

  /** The Better Auth adapter's configuration for these options. */
  private adapterConfig(): MoroJSAuthConfig {
    // The Bearer-token settings are this middleware's own; everything else is
    // the adapter's to translate or to warn about.
    const adapterConfig: MoroJSAuthConfig = { ...this.options };
    delete adapterConfig.jwt;
    delete adapterConfig.secret;
    adapterConfig.providers = this.config.providers;
    adapterConfig.basePath = this.config.basePath;
    if (this.config.secret) adapterConfig.secret = this.config.secret;
    return adapterConfig;
  }

  /**
   * The application this middleware is installed on. Its `server.trustProxy`
   * decides which client address Better Auth is given. Known before Better
   * Auth has loaded when app.use() installed the middleware; told afterwards
   * otherwise.
   */
  installedOn(app: unknown): void {
    this.app = app;
    if (this.betterAuth) servedByApp(this.betterAuth, app);
  }

  /**
   * True when the sign-in routes are (or are about to be) served by Better
   * Auth. Known before initialize() has finished, so a caller can take its
   * place in the middleware chain at once.
   */
  hasSignInRoutes(): boolean {
    return this.signInRoutes;
  }

  /**
   * Serve the sign-in routes on `app` (from its middleware chain, after the
   * application's own routes under the base path). Without an app they are
   * answered where the request is authenticated; see isAuthRoute().
   */
  mountRoutes(app: unknown, initialized: Promise<void>): void {
    if (!this.signInRoutes || this.answeredOnApp) return;
    this.answeredOnApp = mountAuthRoutes(
      app,
      this.config.basePath,
      initialized.then(
        () => (this.betterAuth ? this.betterAuth.handler : null),
        () => null
      )
    );
  }

  /**
   * True when the request is for a sign-in route. A caller that is not
   * mounted on an app answers it with handleAuthRoute(); one that is leaves
   * it to the mounted routes.
   */
  isAuthRoute(req: { url?: string; path?: string; method?: string }): boolean {
    if (!this.betterAuth || !this.signInRoutes) return false;
    if (this.answeredOnApp) return this.answeredOnApp(req);
    if (req.method === 'OPTIONS' || req.method === 'HEAD') return false;
    const url = req.path ?? req.url;
    if (!url) return false;
    const query = url.indexOf('?');
    const path = query === -1 ? url : url.slice(0, query);
    const basePath = this.config.basePath;
    return path === basePath || path.startsWith(`${basePath}/`);
  }

  /** True when the sign-in routes are answered by the app's middleware chain. */
  isMountedOnApp(): boolean {
    return this.answeredOnApp !== null;
  }

  /**
   * Answer a sign-in route. Resolves to true when the response has been
   * written, false when there are no sign-in routes.
   */
  async handleAuthRoute(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    if (!this.betterAuth) return false;
    await this.betterAuth.handler(req as any, res as any);
    return true;
  }

  /** Verify a JWT and return its claims; throws a named error otherwise. */
  private async verifyJWT(token: string): Promise<AuthJWT> {
    const jwt = this.options.jwt;

    if (typeof jwt?.decode === 'function') {
      const decoded = await jwt.decode({ token, secret: this.jwtSecret });
      if (!decoded) throw tokenError('JsonWebTokenError', 'Invalid JWT token format or signature');
      return decoded;
    }

    const result = await safeVerifyJWT(token, this.jwtSecret, {
      ...(jwt?.algorithms !== undefined ? { algorithms: jwt.algorithms } : {}),
      ...(jwt?.audience !== undefined ? { audience: jwt.audience } : {}),
      ...(jwt?.issuer !== undefined ? { issuer: jwt.issuer } : {}),
      ...(jwt?.maxAge !== undefined ? { maxAge: jwt.maxAge } : {}),
    });

    if (!result.success) {
      const type = result.error?.type;
      const details = { jwtErrorType: type, jwtErrorDetails: result.error };
      const message = result.error?.message || 'JWT verification failed';
      if (type === 'expired') {
        throw tokenError('TokenExpiredError', message, {
          ...details,
          expiredAt: result.error?.expiredAt,
        });
      }
      if (type === 'invalid') throw tokenError('JsonWebTokenError', message, details);
      if (type === 'malformed') {
        throw tokenError('NotBeforeError', message, { ...details, date: result.error?.date });
      }
      throw tokenError('Error', message, details);
    }

    return result.payload;
  }

  /**
   * Verify the Bearer token of an Authorization header.
   *
   * A valid token comes back with the session it stands for. A token that
   * does not verify, or names no subject, comes back as `error` and never as
   * `token`: an unverified token is not something to hand to a route.
   */
  async verifyToken(authHeader?: string): Promise<{
    token: string | null;
    session: AuthSession | null;
    claims?: AuthJWT;
    error?: any;
  }> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return { token: null, session: null };
    }

    const token = authHeader.substring(7).trim();
    if (!token) return { token: null, session: null };

    try {
      const claims = await this.verifyJWT(token);
      const user = claims && typeof claims === 'object' ? userFromClaims(claims) : null;
      if (!user) {
        return {
          token: null,
          session: null,
          error: tokenError('JsonWebTokenError', 'JWT token names no subject (sub)'),
        };
      }
      const maxAge = this.config.session?.maxAge || 30 * 24 * 60 * 60;
      return {
        token,
        claims,
        session: {
          user,
          userId: user.id,
          sessionToken: token,
          expires:
            typeof claims.exp === 'number'
              ? new Date(claims.exp * 1000)
              : new Date(Date.now() + maxAge * 1000),
        },
      };
    } catch (error: any) {
      return { token: null, session: null, error };
    }
  }

  /** The Better Auth session of the request, in this middleware's session shape. */
  private async betterAuthSession(req: HttpRequest): Promise<AuthSession | null> {
    if (!this.betterAuth) return null;
    const session = await this.betterAuth.auth(req as any);
    if (!session?.user) return null;
    return {
      user: session.user as AuthUser,
      userId: session.user.id,
      sessionToken: '',
      expires: new Date(session.expires),
      // What the organization plugin keeps on the session
      ...(session.activeOrganizationId !== undefined
        ? { activeOrganizationId: session.activeOrganizationId }
        : {}),
      ...(session.activeTeamId !== undefined ? { activeTeamId: session.activeTeamId } : {}),
    };
  }

  /**
   * Get session from request: Better Auth's when it is active, otherwise the
   * user an application's own session middleware stored (`req.session.user`,
   * with the session-token cookie present).
   */
  async getSession(req: HttpRequest): Promise<AuthSession | null> {
    try {
      const fromBetterAuth = await this.betterAuthSession(req);
      if (fromBetterAuth) return fromBetterAuth;

      const anyReq = req as any;
      const sessionId =
        anyReq.cookies?.['next-auth.session-token'] ||
        anyReq.cookies?.['__Secure-next-auth.session-token'];

      if (sessionId && anyReq.session) {
        const sessionMaxAge = this.config.session?.maxAge || 30 * 24 * 60 * 60;
        return {
          user: anyReq.session.user || null,
          expires: new Date(Date.now() + sessionMaxAge * 1000),
          sessionToken: sessionId,
          userId: anyReq.session.user?.id || '',
        };
      }
    } catch (error) {
      logger.debug('No valid session found', 'SessionValidation', { error });
    }
    return null;
  }

  /**
   * Authenticate a request and set `req.auth`.
   *
   * Resolves to true when the request has been answered here (a Bearer token
   * that does not verify, from a client that asked for JSON, gets a 401) and
   * must go no further.
   */
  async authenticate(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    const anyReq = req as any;
    let session: AuthSession | null = null;
    let token: string | undefined;
    let claims: AuthJWT | undefined;

    const authorization = anyReq.headers?.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      const verified = await this.verifyToken(authorization);
      if (verified.session && verified.token) {
        session = verified.session;
        token = verified.token;
        claims = verified.claims;
      } else if (verified.error) {
        // Not one of this middleware's tokens. With Better Auth active it may
        // be one of its own (the bearer plugin): ask before refusing.
        session = await this.betterAuthSession(req).catch(() => null);
        if (!session && this.handleJWTError(verified.error, req, res)) return true;
      }
    }

    if (!session) session = await this.getSession(req);

    const authRequest = this.createAuthRequest(session, token, claims);
    anyReq.auth = authRequest;

    if (authRequest.isAuthenticated) {
      logger.debug('User authenticated', 'Authentication', {
        userId: authRequest.user?.id,
        provider: authRequest.user?.provider || 'unknown',
      });
    }
    return false;
  }

  /**
   * Create auth request object with methods
   */
  createAuthRequest(session: AuthSession | null, token?: string, claims?: AuthJWT): AuthRequest {
    const basePath = this.config.basePath;
    const authRequest: AuthRequest = {
      ...(session?.user ? { user: session.user } : {}),
      ...(session ? { session } : {}),
      ...(token ? { token } : {}),
      isAuthenticated: !!session?.user,
      // The URL to send the browser to. It is served when Better Auth's
      // sign-in routes are (see hasSignInRoutes), or by the application.
      signIn: async (provider?: string, options?: any) => {
        const query = options?.callbackUrl
          ? `?callbackUrl=${encodeURIComponent(options.callbackUrl)}`
          : '';
        return { url: `${basePath}/signin${provider ? `/${provider}` : ''}${query}` };
      },
      signOut: async (options?: any) => {
        const query = options?.callbackUrl
          ? `?callbackUrl=${encodeURIComponent(options.callbackUrl)}`
          : '';
        return { url: `${basePath}/signout${query}` };
      },
      getSession: async () => session,
      // The verified claims of the request's Bearer token
      getToken: async () => claims ?? null,
      // A random value. Nothing stores or checks it: the sign-in routes are
      // protected by Better Auth's origin check, an application's own forms
      // by middleware.csrf().
      getCsrfToken: async () => crypto.randomBytes(32).toString('hex'),
      getProviders: async () => {
        // Public metadata only: this is what a hand-written /providers
        // endpoint returns to anonymous callers.
        if (!this.cachedProviderMap) {
          this.cachedProviderMap = {};
          for (const provider of this.config.providers) {
            this.cachedProviderMap[provider.id] = publicProviderInfo(provider);
          }
        }
        return this.cachedProviderMap;
      },
    };

    return authRequest;
  }

  /**
   * Answer a Bearer token that did not verify. A client that asked for JSON
   * gets a 401 naming the reason; any other request goes on unauthenticated,
   * for a guard to answer or redirect. Returns true when a response was sent.
   */
  handleJWTError(error: any, req: HttpRequest, res: HttpResponse): boolean {
    const acceptsJson = req.headers.accept?.includes('application/json');

    if (error.name === 'TokenExpiredError') {
      logger.debug('JWT token expired', 'TokenValidation', {
        message: error.message,
        expiredAt: error.expiredAt,
      });

      if (acceptsJson) {
        res.status(401).json(
          createAuthErrorResponse({
            type: 'expired',
            message: error.message,
            expiredAt: error.expiredAt,
          })
        );
        return true;
      }
    } else if (error.name === 'JsonWebTokenError') {
      logger.debug('Invalid JWT token format', 'TokenValidation', {
        message: error.message,
      });

      if (acceptsJson) {
        res.status(401).json(
          createAuthErrorResponse({
            type: 'invalid',
            message: error.message,
          })
        );
        return true;
      }
    } else if (error.name === 'NotBeforeError') {
      logger.debug('JWT token not active yet', 'TokenValidation', {
        message: error.message,
        date: error.date,
      });

      if (acceptsJson) {
        res.status(401).json(
          createAuthErrorResponse({
            type: 'malformed',
            message: error.message,
            date: error.date,
          })
        );
        return true;
      }
    } else {
      logger.debug('JWT token validation failed', 'TokenValidation', {
        error: error.message || error,
      });
    }

    return false;
  }

  /**
   * Get provider count
   */
  getProviderCount(): number {
    return this.config.providers.length;
  }
}
