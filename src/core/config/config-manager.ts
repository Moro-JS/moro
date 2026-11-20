/**
 * Configuration Manager - Immutable Single Source of Truth
 *
 * Every app has its own configuration: createApp() builds it from the options
 * it is given, freezes it, and the app keeps it for its lifetime. What this
 * module holds is the configuration of the current app (the one created most
 * recently, see UnifiedRouter.getInstance), which is what getGlobalConfig()
 * and the helpers built on it return.
 *
 * Precedence: createApp Options > Environment Variables > Config File > Defaults
 */

import { AppConfig } from '../../types/config.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfigManager');

/**
 * The current configuration - immutable after initialization
 */
let globalConfig: Readonly<AppConfig> | null = null;
let isLocked = false;
// Whether an app was created with the current configuration. One that was
// set up directly (initializeConfig() before any app) waits for the first app
// created, which uses it.
let ownedByApp = false;

/**
 * Initialize and lock global configuration state
 * This should only be called once during createApp() initialization
 */
export function initializeAndLockConfig(config: AppConfig): void {
  if (isLocked) {
    throw new Error(
      'Configuration is already locked and cannot be changed. ' +
        'Configuration can only be set once during createApp() initialization.'
    );
  }

  // Deep freeze the configuration to make it truly immutable
  globalConfig = deepFreeze(config);
  isLocked = true;
  ownedByApp = false;

  logger.info(
    `Configuration locked and initialized: ${process.env.NODE_ENV || 'development'}:${config.server.port}`
  );
}

/**
 * Freeze the configuration a new app was created with and make it the
 * current one. Unlike initializeAndLockConfig() this replaces what is
 * current: the app created before keeps its own configuration object.
 * @internal
 */
export function lockAppConfig(config: AppConfig): Readonly<AppConfig> {
  globalConfig = deepFreeze(config);
  isLocked = true;
  ownedByApp = true;
  return globalConfig;
}

/**
 * The configuration that was initialized directly, before any app existed,
 * handed to the app now being created; null when there is none or an app
 * already has it.
 * @internal
 */
export function claimPendingConfig(): Readonly<AppConfig> | null {
  if (!isLocked || globalConfig === null || ownedByApp) return null;
  ownedByApp = true;
  return globalConfig;
}

/**
 * Make an existing app's configuration the current one again (the current
 * app changed: the newer one was closed, or route files of this one are
 * being loaded).
 * @internal
 */
export function useAppConfig(config: Readonly<AppConfig>): void {
  globalConfig = config;
  isLocked = true;
  ownedByApp = true;
}

/**
 * The configuration of the app that is handling `req`, for code that runs
 * inside a request: the HTTP servers put themselves on the request and hold
 * their app's router, which knows the app's configuration. A request that
 * did not come through one of them (a runtime adapter, a test double) gets
 * the current configuration, or undefined when none is initialized.
 * @internal
 */
export function configForRequest(req: unknown): Readonly<AppConfig> | undefined {
  const own = (req as { _server?: { router?: { appConfig?: Readonly<AppConfig> } } } | undefined)
    ?._server?.router?.appConfig;
  if (own !== undefined) return own;
  return isLocked && globalConfig !== null ? globalConfig : undefined;
}

/**
 * Get the current global configuration
 * Throws if configuration hasn't been initialized
 */
export function getGlobalConfig(): Readonly<AppConfig> {
  if (!globalConfig || !isLocked) {
    throw new Error(
      'Configuration not initialized. Call createApp() to initialize the configuration system.'
    );
  }
  return globalConfig;
}

/**
 * Check if configuration has been initialized and locked
 */
export function isConfigLocked(): boolean {
  return isLocked && globalConfig !== null;
}

/**
 * Reset configuration state (for testing only)
 * @internal - This should only be used in tests
 */
export function resetConfigForTesting(): void {
  if (
    process.env.NODE_ENV !== 'test' &&
    !process.env.MORO_ALLOW_CONFIG_RESET &&
    !process.env.JEST_WORKER_ID
  ) {
    throw new Error(
      'Configuration reset is only allowed in test environments. ' +
        'Set MORO_ALLOW_CONFIG_RESET=true to override this check.'
    );
  }

  globalConfig = null;
  isLocked = false;
  ownedByApp = false;
  logger.debug('Configuration state reset for testing');
}

/**
 * Deep freeze the configuration to make it truly immutable.
 *
 * Only the configuration's own structure is frozen: plain objects and arrays.
 * A value of any other kind is something the application handed over to be
 * used, not configuration data (a TLS key in a Buffer, a Redis client under
 * `storeOptions` or `jobs.leaderElection`), and stays as it is: a Buffer
 * cannot be frozen at all, and a frozen client can no longer work. Objects
 * already visited are skipped, so a structure that refers to itself ends.
 */
function deepFreeze<T>(obj: T, seen: WeakSet<object> = new WeakSet()): Readonly<T> {
  if (!isFreezable(obj) || seen.has(obj)) {
    return obj;
  }
  seen.add(obj);

  // Freeze properties before freezing self
  for (const name of Object.getOwnPropertyNames(obj)) {
    deepFreeze((obj as any)[name], seen);
  }

  return Object.freeze(obj);
}

function isFreezable(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Get a specific configuration value using dot notation
 * This provides a safe way to access nested config values
 *
 * @example
 * getConfigValue('server.port') // Returns the server port
 * getConfigValue('database.redis.url') // Returns the Redis URL
 */
export function getConfigValue<T = any>(path: string): T | undefined {
  const config = getGlobalConfig();

  return path.split('.').reduce((obj: any, key: string) => {
    return obj && obj[key] !== undefined ? obj[key] : undefined;
  }, config);
}

/**
 * Utility functions for common environment checks
 * These now read NODE_ENV directly for consistency with Node.js ecosystem
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function isStaging(): boolean {
  return process.env.NODE_ENV === 'staging';
}
