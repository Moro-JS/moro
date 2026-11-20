/**
 * The auth feature helpers, on Better Auth
 *
 * `twoFactor()`, `organization()`, `anonymous()` and `bearerToken()` describe a
 * Better Auth plugin; `accountLinking()` and `rateLimit()` describe a Better
 * Auth option. They are passed to `auth()` / `createAuthMiddleware()` /
 * `MoroJSAuth()`:
 *
 *   auth({
 *     plugins: [twoFactor(), organization(), anonymous(), bearerToken()],
 *     accountLinking: accountLinking(),
 *     rateLimit: rateLimit(),
 *   })
 *
 * This module turns what they describe into the plugins and options handed to
 * `betterAuth()`. The plugin modules are loaded from the application's
 * `better-auth`, and only for the helpers that are used. An option Better
 * Auth has no equivalent for is named in a start-up warning.
 */

import { resolveUserPackage } from '../utilities/package-utils.js';

// ===== What the helpers return =====

/** What `twoFactor()` returns. */
export interface TwoFactorSettings {
  type: '2fa';
  totp: boolean;
  backupCodes: boolean;
  backupCodesCount: number;
  trustDevice: boolean;
  trustDeviceDuration: number;
  issuer: string;
  /** Options handed to Better Auth's `twoFactor` plugin as they are. */
  betterAuth?: Record<string, any>;
}

/** What `organization()` returns. */
export interface OrganizationSettings {
  type: 'organization';
  allowUserCreate: boolean;
  maxOrganizationsPerUser: number;
  organizationRoles: boolean;
  /** Options handed to Better Auth's `organization` plugin as they are. */
  betterAuth?: Record<string, any>;
}

/** What `anonymous()` returns. */
export interface AnonymousSettings {
  type: 'anonymous';
  linkOnSignUp: boolean;
  sessionDuration: number;
  /** Options handed to Better Auth's `anonymous` plugin as they are. */
  betterAuth?: Record<string, any>;
}

/** What `bearerToken()` returns. */
export interface BearerTokenSettings {
  type: 'bearer-token';
  expiresIn: number;
  refreshTokens: boolean;
  refreshTokenExpiresIn: number;
  /** Options handed to Better Auth's `bearer` plugin as they are. */
  betterAuth?: Record<string, any>;
}

/** What `accountLinking()` returns. */
export interface AccountLinkingSettings {
  type: 'account-linking';
  autoLinkSameEmail: boolean;
  allowManualLink: boolean;
}

/** What `rateLimit()` returns. */
export interface RateLimitSettings {
  type: 'rate-limit';
  maxAttempts: number;
  lockoutDuration: number;
  window: number;
}

/** A helper that stands for a Better Auth plugin: an entry of `plugins`. */
export type AuthPluginHelper =
  TwoFactorSettings | OrganizationSettings | AnonymousSettings | BearerTokenSettings;

/** The keys of `auth()` / `createAuthMiddleware()` the helpers are passed under. */
export interface AuthFeatureOptions {
  /**
   * Better Auth plugins, by helper: `twoFactor()`, `organization()`,
   * `anonymous()`, `bearerToken()`. Each loads the plugin from the
   * application's `better-auth` and configures it. A Better Auth plugin object
   * goes in `betterAuth.plugins` instead; one given there under the same id
   * is the one used.
   */
  plugins?: AuthPluginHelper[];
  /** `accountLinking()`: Better Auth's `account.accountLinking` option. */
  accountLinking?: AccountLinkingSettings;
  /** `rateLimit()`: Better Auth's `rateLimit` option, for its sign-in routes. */
  rateLimit?: RateLimitSettings;
}

// ===== Which options were given =====

// The helpers fill in defaults, so the object alone does not say whether an
// option was asked for. Kept beside the object rather than on it: what a
// helper returns stays exactly its documented fields.
const GIVEN = new WeakMap<object, ReadonlySet<string>>();

/** Record which of `options` the caller set, and return `settings`. */
export function helperSettings<T extends object>(settings: T, options: object): T {
  const given = new Set<string>();
  for (const key of Object.keys(options)) {
    if ((options as Record<string, unknown>)[key] !== undefined) given.add(key);
  }
  GIVEN.set(settings, given);
  return settings;
}

/**
 * True when the caller set `key`. For an object that did not come straight
 * from a helper (a copy, a literal) a value other than the default counts.
 */
function wasGiven(settings: Record<string, any>, key: string, defaultValue: unknown): boolean {
  const given = GIVEN.get(settings);
  return given ? given.has(key) : settings[key] !== defaultValue;
}

// ===== The plugins =====

interface PluginSource {
  /** The MoroJS helper's name */
  helper: string;
  /** The id of the Better Auth plugin */
  id: string;
  /** The name the plugin is exported under */
  factory: string;
  /** The module of the application's better-auth that exports it */
  module: string;
  /** What the plugin keeps in the database, or null */
  stores: string | null;
}

const PLUGIN_SOURCES: Record<AuthPluginHelper['type'], PluginSource> = {
  '2fa': {
    helper: 'twoFactor',
    id: 'two-factor',
    factory: 'twoFactor',
    module: 'better-auth/plugins/two-factor',
    stores: 'table `twoFactor`, column `user.twoFactorEnabled`',
  },
  organization: {
    helper: 'organization',
    id: 'organization',
    factory: 'organization',
    module: 'better-auth/plugins/organization',
    stores: 'tables `organization`, `member`, `invitation`, column `session.activeOrganizationId`',
  },
  anonymous: {
    helper: 'anonymous',
    id: 'anonymous',
    factory: 'anonymous',
    module: 'better-auth/plugins/anonymous',
    stores: 'column `user.isAnonymous`',
  },
  'bearer-token': {
    helper: 'bearerToken',
    id: 'bearer',
    factory: 'bearer',
    module: 'better-auth/plugins/bearer',
    stores: null,
  },
};

const OPTION_HELPERS: Record<string, string> = {
  'account-linking': 'accountLinking',
  'rate-limit': 'rateLimit',
};

function isPluginHelperType(type: unknown): type is AuthPluginHelper['type'] {
  return typeof type === 'string' && Object.hasOwn(PLUGIN_SOURCES, type);
}

type PluginFactory = (options?: Record<string, any>) => unknown;

/**
 * The plugin's factory from the application's better-auth: its own module
 * first, then the `better-auth/plugins` barrel. Throws, naming what to
 * install, when the installed package has neither.
 */
async function loadPluginFactory(source: PluginSource): Promise<PluginFactory> {
  for (const specifier of [source.module, 'better-auth/plugins']) {
    try {
      const loaded = await import(resolveUserPackage(specifier));
      const factory = loaded[source.factory] ?? loaded.default?.[source.factory];
      if (typeof factory === 'function') return factory as PluginFactory;
    } catch {
      // Not in this layout of the package: try the next
    }
  }
  throw new Error(
    `${source.helper}() needs the '${source.factory}' plugin of the 'better-auth' package, and the ` +
      `installed better-auth does not have it ('${source.module}' and 'better-auth/plugins' ` +
      `could not be loaded). Install a current version: npm install better-auth@latest`
  );
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `extra` over `mapped`; an option that is an object on both sides is merged. */
function withPassThrough(mapped: Record<string, any>, extra: unknown): Record<string, any> {
  if (!isPlainObject(extra)) return mapped;
  const merged: Record<string, any> = { ...mapped };
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (value === undefined) continue;
    merged[key] =
      isPlainObject(value) && isPlainObject(mapped[key]) ? { ...mapped[key], ...value } : value;
  }
  return merged;
}

interface MappingContext {
  /** `betterAuth.appName`, when the application set one */
  appName: unknown;
  /** The session lifetime handed to Better Auth, in seconds */
  sessionExpiresIn: unknown;
  warnings: string[];
}

function twoFactorOptions(settings: TwoFactorSettings, context: MappingContext) {
  // The name an authenticator app shows: the one asked for, else the
  // application's name when Better Auth was given one, else the helper's own
  const issuer =
    wasGiven(settings, 'issuer', 'MoroJS App') || typeof context.appName !== 'string'
      ? settings.issuer
      : context.appName;
  return withPassThrough(
    {
      issuer,
      ...(settings.totp === false ? { totpOptions: { disable: true } } : {}),
      // No backup codes: none are generated, so none can be used
      backupCodeOptions: { amount: settings.backupCodes === false ? 0 : settings.backupCodesCount },
      // No trusted devices: a trust that has already expired when it is issued
      trustDeviceMaxAge: settings.trustDevice === false ? 0 : settings.trustDeviceDuration,
    },
    settings.betterAuth
  );
}

function organizationOptions(settings: OrganizationSettings, context: MappingContext) {
  if (settings.organizationRoles === false) {
    context.warnings.push(
      "organization(): 'organizationRoles: false' is not applied: Better Auth's organizations " +
        'always have member roles (owner, admin, member) and they cannot be turned off.'
    );
  }
  return withPassThrough(
    {
      allowUserToCreateOrganization: settings.allowUserCreate !== false,
      organizationLimit: settings.maxOrganizationsPerUser,
    },
    settings.betterAuth
  );
}

function anonymousOptions(settings: AnonymousSettings, context: MappingContext) {
  if (
    wasGiven(settings, 'sessionDuration', 2592000) &&
    settings.sessionDuration !== context.sessionExpiresIn
  ) {
    context.warnings.push(
      "anonymous(): 'sessionDuration' is not applied: Better Auth has one session lifetime for " +
        `every user, anonymous or not (\`session.maxAge\`, ${String(context.sessionExpiresIn)} seconds here).`
    );
  }
  return withPassThrough(
    // Not linking: the anonymous user is left as it is when its visitor signs
    // up or signs in
    settings.linkOnSignUp === false ? { disableDeleteAnonymousUser: true } : {},
    settings.betterAuth
  );
}

function bearerOptions(settings: BearerTokenSettings, context: MappingContext) {
  const unused: Array<[key: keyof BearerTokenSettings, defaultValue: unknown, instead: string]> = [
    [
      'expiresIn',
      3600,
      'the token is the session token and lives as long as the session (`session.maxAge`)',
    ],
    [
      'refreshTokens',
      true,
      'there are no refresh tokens; Better Auth extends a session that is in use (`session.updateAge`)',
    ],
    ['refreshTokenExpiresIn', 2592000, 'there are no refresh tokens'],
  ];
  for (const [key, defaultValue, instead] of unused) {
    if (wasGiven(settings, key, defaultValue)) {
      context.warnings.push(`bearerToken(): '${key}' is not applied: ${instead}.`);
    }
  }
  return withPassThrough({}, settings.betterAuth);
}

function pluginOptions(helper: AuthPluginHelper, context: MappingContext): Record<string, any> {
  switch (helper.type) {
    case '2fa':
      return twoFactorOptions(helper, context);
    case 'organization':
      return organizationOptions(helper, context);
    case 'anonymous':
      return anonymousOptions(helper, context);
    case 'bearer-token':
      return bearerOptions(helper, context);
  }
}

// ===== The options =====

/** Better Auth's `account.accountLinking` for `accountLinking()`. */
function accountLinkingOptions(settings: AccountLinkingSettings, warnings: string[]) {
  const automatic = settings.autoLinkSameEmail === true;
  const manual = settings.allowManualLink !== false;
  if (automatic && !manual) {
    warnings.push(
      "accountLinking(): 'allowManualLink: false' is not applied together with " +
        "'autoLinkSameEmail: true': Better Auth can turn linking off as a whole, or only the " +
        'automatic kind, but not only the manual kind.'
    );
  }
  if (!automatic && !manual) return { enabled: false };
  return { enabled: true, disableImplicitLinking: !automatic };
}

/** The sign-in routes of Better Auth, for its rate limiter's `customRules`. */
const SIGN_IN_ROUTES = '/sign-in/*';

/** Better Auth's `rateLimit` for `rateLimit()`. */
function rateLimitOptions(settings: RateLimitSettings, warnings: string[]) {
  if (wasGiven(settings, 'lockoutDuration', 900) && settings.lockoutDuration !== settings.window) {
    warnings.push(
      "rateLimit(): 'lockoutDuration' is not applied: Better Auth's rate limiter has no separate " +
        `lockout. After ${settings.maxAttempts} sign-in attempts it refuses that client until ` +
        `${settings.window} seconds ('window') have passed since the last one it counted.`
    );
  }
  return {
    enabled: true,
    customRules: { [SIGN_IN_ROUTES]: { window: settings.window, max: settings.maxAttempts } },
  };
}

// ===== Putting them on the options handed to betterAuth() =====

/** True when `config` passes any of the helpers. */
export function usesAuthFeatures(config: AuthFeatureOptions): boolean {
  const plugins: unknown = config.plugins;
  return (
    (Array.isArray(plugins) ? plugins.length > 0 : plugins !== undefined) ||
    config.accountLinking !== undefined ||
    config.rateLimit !== undefined
  );
}

/** The helpers `config` passes, by name: `['twoFactor()', 'rateLimit()']`. */
export function authFeatureNames(config: AuthFeatureOptions): string[] {
  const names: string[] = [];
  for (const entry of Array.isArray(config.plugins) ? config.plugins : []) {
    const type = (entry as { type?: unknown } | null)?.type;
    const helper = isPluginHelperType(type)
      ? PLUGIN_SOURCES[type].helper
      : typeof type === 'string' && Object.hasOwn(OPTION_HELPERS, type)
        ? OPTION_HELPERS[type]
        : undefined;
    if (helper && !names.includes(`${helper}()`)) names.push(`${helper}()`);
  }
  if (config.accountLinking !== undefined && !names.includes('accountLinking()')) {
    names.push('accountLinking()');
  }
  if (config.rateLimit !== undefined && !names.includes('rateLimit()')) names.push('rateLimit()');
  return names;
}

export interface AppliedAuthFeatures {
  /** What to say at start-up */
  warnings: string[];
  /** The helpers in use whose plugin keeps data in the database, with what it keeps */
  stored: Array<{ helper: string; stores: string }>;
}

/**
 * Add what the helpers of `config` describe to `options`, the options about
 * to be handed to `betterAuth()` (already holding the `betterAuth`
 * pass-through). A plugin or option the application also gave by hand through
 * `betterAuth` is the one used.
 *
 * Rejects when a plugin a helper needs cannot be loaded from the installed
 * better-auth.
 */
export async function applyAuthFeatures(
  config: AuthFeatureOptions,
  options: Record<string, any>
): Promise<AppliedAuthFeatures> {
  const warnings: string[] = [];
  const stored: AppliedAuthFeatures['stored'] = [];

  let accountLinking: unknown = config.accountLinking;
  let rateLimit: unknown = config.rateLimit;
  const pluginHelpers: AuthPluginHelper[] = [];

  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    warnings.push("'plugins' is not used: it takes a list, for example `plugins: [twoFactor()]`.");
  }
  for (const entry of Array.isArray(config.plugins) ? config.plugins : []) {
    const type = (entry as { type?: unknown } | null)?.type;
    if (isPluginHelperType(type)) {
      pluginHelpers.push(entry);
    } else if (type === 'account-linking') {
      warnings.push(
        'accountLinking() was passed in `plugins`; it belongs under `accountLinking`. Applied as if it were there.'
      );
      accountLinking ??= entry;
    } else if (type === 'rate-limit') {
      warnings.push(
        'rateLimit() was passed in `plugins`; it belongs under `rateLimit`. Applied as if it were there.'
      );
      rateLimit ??= entry;
    } else {
      warnings.push(
        'an entry of `plugins` is not one of twoFactor(), organization(), anonymous(), ' +
          'bearerToken() and was not used. A Better Auth plugin goes in `betterAuth: { plugins: [...] }`.'
      );
    }
  }

  // Plugins
  const byHand: unknown[] = Array.isArray(options.plugins) ? options.plugins : [];
  const present = new Set<string>();
  for (const plugin of byHand) {
    const id = (plugin as { id?: unknown } | null)?.id;
    if (typeof id === 'string') present.add(id);
  }
  const context: MappingContext = {
    appName: options.appName,
    sessionExpiresIn: options.session?.expiresIn,
    warnings,
  };
  const added: unknown[] = [];
  const seen = new Set<string>();
  for (const helper of pluginHelpers) {
    const source = PLUGIN_SOURCES[helper.type];
    if (seen.has(source.id)) {
      warnings.push(`${source.helper}() was passed more than once; the first one is used.`);
      continue;
    }
    seen.add(source.id);
    if (source.stores) stored.push({ helper: `${source.helper}()`, stores: source.stores });
    if (present.has(source.id)) {
      warnings.push(
        `${source.helper}(): \`betterAuth.plugins\` already holds Better Auth's '${source.id}' ` +
          'plugin. That one is used, and the options of the helper are not applied.'
      );
      continue;
    }
    const factory = await loadPluginFactory(source);
    added.push(factory(pluginOptions(helper, context)));
  }
  if (added.length > 0) options.plugins = [...byHand, ...added];

  // Account linking: what `betterAuth.account.accountLinking` names itself wins
  if ((accountLinking as { type?: unknown } | null | undefined)?.type === 'account-linking') {
    const account: Record<string, any> = isPlainObject(options.account) ? options.account : {};
    options.account = {
      ...account,
      accountLinking: {
        ...accountLinkingOptions(accountLinking as AccountLinkingSettings, warnings),
        ...(isPlainObject(account.accountLinking) ? account.accountLinking : {}),
      },
    };
  } else if (accountLinking !== undefined && accountLinking !== null) {
    warnings.push("'accountLinking' is not used: it takes what accountLinking() returns.");
  }

  // Rate limit: what `betterAuth.rateLimit` names itself wins, rule by rule
  if ((rateLimit as { type?: unknown } | null | undefined)?.type === 'rate-limit') {
    const given: Record<string, any> = isPlainObject(options.rateLimit) ? options.rateLimit : {};
    const derived = rateLimitOptions(rateLimit as RateLimitSettings, warnings);
    options.rateLimit = {
      ...derived,
      ...given,
      customRules: {
        ...derived.customRules,
        ...(isPlainObject(given.customRules) ? given.customRules : {}),
      },
    };
  } else if (rateLimit !== undefined && rateLimit !== null) {
    warnings.push("'rateLimit' is not used: it takes what rateLimit() returns.");
  }

  return { warnings, stored };
}

/** `twoFactor(): table ...; organization(): tables ...` */
function storedBy(stored: AppliedAuthFeatures['stored']): string {
  return stored.map(entry => `${entry.helper}: ${entry.stores}`).join('; ');
}

/**
 * What to say when the helpers in `stored` are used and Better Auth has no
 * database: it then keeps everything in the memory of the process.
 */
export function describeMemoryStorage(stored: AppliedAuthFeatures['stored']): string {
  return (
    `${stored.map(entry => entry.helper).join(', ')} keep their data in Better Auth's database ` +
    'and none is configured, so Better Auth holds it, like its users, in the memory of this ' +
    'process: it is gone at restart and not shared between processes. Pass a database ' +
    `as \`betterAuth: { database }\`. What they store: ${storedBy(stored)}.`
  );
}

/**
 * What to say when the database lacks tables or columns the configuration
 * writes, or null when it has them all (or cannot be asked).
 *
 * Better Auth refuses every request while its schema is behind, and its
 * error says what is missing and which command adds it. `probe` is a request
 * that changes nothing; it makes Better Auth say so before the first real
 * one.
 */
export async function describeMissingTables(
  stored: AppliedAuthFeatures['stored'],
  probe: () => Promise<unknown>
): Promise<string | null> {
  try {
    await probe();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'SCHEMA_MISMATCH') return null;
    // Better Auth's own account, on one line
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    return (
      'the auth database does not have the tables and columns this configuration writes, so ' +
      'Better Auth refuses every request: the auth routes answer 500 and no session is ' +
      `recognised until the schema is brought up to date. What the helpers store: ${storedBy(stored)}. ` +
      `Better Auth reports: ${detail}`
    );
  }
  return null;
}
