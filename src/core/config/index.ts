/**
 * Configuration System - Immutable Config with createApp Override Support
 *
 * This is the main entry point for the MoroJS configuration system.
 * Each app gets a clean, immutable configuration, built at createApp() time.
 *
 * Key Features:
 * - Immutable configuration after initialization
 * - Clear precedence: createApp Options > Env Vars > Config File > Defaults
 * - Type-safe validation
 * - One configuration per app; getGlobalConfig() is the current app's
 */

// Export types and core components
export * from './schema.js';
export * from './config-sources.js';
export * from './config-validator.js';
export * from './file-loader.js';
export type { OriginFunction } from '../../types/config.js';

// Export specific functions from config-manager to avoid conflicts
export {
  initializeAndLockConfig,
  isConfigLocked,
  resetConfigForTesting,
} from './config-manager.js';

// Export utilities for backward compatibility
export * from './utils.js';

import { MoroOptions } from '../../types/core.js';
import { AppConfig } from '../../types/config.js';
import { loadConfigFromAllSources, loadConfigFromAllSourcesAsync } from './config-sources.js';
import {
  initializeAndLockConfig,
  getGlobalConfig as getConfig,
  isConfigLocked,
  resetConfigForTesting,
  lockAppConfig,
  claimPendingConfig,
} from './config-manager.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfigSystem');

/**
 * initializeConfig() sets the configuration up once: a later call returns
 * what exists, and the first app created after a direct call uses that
 * configuration as it is. Options that come with either are not applied, so
 * name them at ERROR rather than a debug line nobody sees.
 */
function warnIgnoredOptions(options?: MoroOptions): void {
  const ignored = options ? Object.keys(options).filter(k => k !== 'logger') : [];
  if (ignored.length === 0) {
    logger.debug('Configuration already locked, returning existing config');
    return;
  }
  logger.error(
    `A configuration was already initialized before this call; ignoring options [${ignored.join(', ')}]. ` +
      'initializeConfig() sets the configuration up once, and the first app created after it uses ' +
      'that configuration as it is. Pass the options to the first initializeConfig() call, or drop ' +
      'that call and pass them to createApp(): every app builds its own configuration from the ' +
      'options it is created with.',
    'ConfigLock'
  );
}

/**
 * Initialize the configuration system directly, before any app exists.
 * createApp() does this itself; a direct call is for code that needs the
 * configuration first. The first app created afterwards uses the
 * configuration this returns. Called again, it returns the current
 * configuration unchanged.
 *
 * @param options - createApp options that can override config file and defaults
 * @returns Immutable, validated configuration object
 */
export function initializeConfig(options?: MoroOptions): Readonly<AppConfig> {
  if (isConfigLocked()) {
    warnIgnoredOptions(options);
    return getConfig();
  }

  logger.debug('Initializing configuration system');

  // Load configuration from all sources with proper precedence
  const config = loadConfigFromAllSources(options);

  // Lock the configuration to prevent further changes
  initializeAndLockConfig(config);

  logger.info(
    `Configuration system initialized and locked: ${process.env.NODE_ENV || 'development'}:${config.server.port} (sources: env + file + options + defaults)`
  );

  return config;
}

/**
 * initializeConfig(), loading the config file with dynamic import() so that
 * ESM config files in projects with "type":"module" are supported.
 *
 * @param options - createApp options that can override config file and defaults
 * @returns Immutable, validated configuration object
 */
export async function initializeConfigAsync(options?: MoroOptions): Promise<Readonly<AppConfig>> {
  if (isConfigLocked()) {
    warnIgnoredOptions(options);
    return getConfig();
  }

  logger.debug('Initializing configuration system (async)');

  const config = await loadConfigFromAllSourcesAsync(options);

  initializeAndLockConfig(config);

  logger.info(
    `Configuration system initialized and locked: ${process.env.NODE_ENV || 'development'}:${config.server.port} (sources: env + file + options + defaults)`
  );

  return config;
}

// A configuration set up directly before any app exists is the first app's.
function pendingConfigForApp(options?: MoroOptions): Readonly<AppConfig> | null {
  const pending = claimPendingConfig();
  if (pending !== null) warnIgnoredOptions(options);
  return pending;
}

function appConfigLoaded(config: AppConfig): Readonly<AppConfig> {
  const locked = lockAppConfig(config);
  logger.info(
    `Configuration system initialized and locked: ${process.env.NODE_ENV || 'development'}:${config.server.port} (sources: env + file + options + defaults)`
  );
  return locked;
}

/**
 * The configuration of an app that is being created: its own, built from
 * every source with the options the app was given, frozen, and from now on
 * the current configuration (getGlobalConfig()). Apps created earlier keep
 * the configuration they were created with.
 *
 * @internal
 */
export function createAppConfig(options?: MoroOptions): Readonly<AppConfig> {
  return pendingConfigForApp(options) ?? appConfigLoaded(loadConfigFromAllSources(options));
}

/**
 * createAppConfig(), loading the config file with dynamic import(). Called by
 * the async createApp() factories.
 *
 * @internal
 */
export async function createAppConfigAsync(options?: MoroOptions): Promise<Readonly<AppConfig>> {
  return (
    pendingConfigForApp(options) ?? appConfigLoaded(await loadConfigFromAllSourcesAsync(options))
  );
}

/**
 * Load configuration without locking (for testing and utilities)
 * This maintains backward compatibility with existing code
 */
export function loadConfig(): AppConfig {
  return loadConfigFromAllSources();
}

/**
 * Load configuration with createApp options (for testing and utilities)
 * This maintains backward compatibility with existing code
 */
export function loadConfigWithOptions(options: MoroOptions): AppConfig {
  return loadConfigFromAllSources(options);
}

/**
 * The configuration of the current app: the one created most recently that
 * has not been closed (see getApp()). With one app in the process, that
 * app's configuration.
 */
export function getGlobalConfig(): Readonly<AppConfig> {
  return getConfig();
}

/**
 * Check if configuration has been initialized and locked
 * Alias for isConfigLocked() for backward compatibility
 */
export function isConfigInitialized(): boolean {
  return isConfigLocked();
}

/**
 * Reset configuration state (for testing only)
 * @internal
 */
export function resetConfig(): void {
  resetConfigForTesting();
}
