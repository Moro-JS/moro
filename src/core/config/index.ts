/**
 * Configuration System - Immutable Config with createApp Override Support
 *
 * This is the main entry point for the MoroJS configuration system.
 * It provides a clean, immutable configuration that is locked at createApp() time.
 *
 * Key Features:
 * - Immutable configuration after initialization
 * - Clear precedence: Env Vars > createApp Options > Config File > Defaults
 * - Type-safe validation
 * - Single source of truth
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
} from './config-manager.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfigSystem');

/**
 * Configuration is one-per-process: the first createApp() locks it and every
 * later createApp() in the same process (or worker thread) receives that
 * same config. A second app that passes its OWN options (another port, TLS,
 * ...) would otherwise silently boot with the first app's settings, so name
 * the ignored keys at ERROR rather than a debug line nobody sees.
 */
function warnIgnoredOptions(options?: MoroOptions): void {
  const ignored = options ? Object.keys(options).filter(k => k !== 'logger') : [];
  if (ignored.length === 0) {
    logger.debug('Configuration already locked, returning existing config');
    return;
  }
  logger.error(
    `createApp() called again after the configuration was locked; ignoring options [${ignored.join(', ')}]. ` +
      'MoroJS keeps one configuration per process: the first createApp() wins and later apps share it. ' +
      'Run a second differently-configured app in its own process.',
    'ConfigLock'
  );
}

/**
 * Initialize configuration system with createApp options
 * This is the main entry point called by createApp()
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
 * Initialize configuration system asynchronously.
 * Uses dynamic import() for the config file — supports ESM config files in
 * projects with "type":"module". Called internally by the async createApp().
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
 * Get the current global configuration
 * Alias for getGlobalConfig() for backward compatibility
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
