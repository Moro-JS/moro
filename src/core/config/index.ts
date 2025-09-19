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
export * from './schema';
export * from './config-sources';
export * from './config-validator';
export * from './file-loader';

// Export specific functions from config-manager to avoid conflicts
export { initializeAndLockConfig, isConfigLocked, resetConfigForTesting } from './config-manager';

// Export utilities for backward compatibility
export * from './utils';

import { MoroOptions } from '../../types/core';
import { AppConfig } from '../../types/config';
import { loadConfigFromAllSources } from './config-sources';
import {
  initializeAndLockConfig,
  getGlobalConfig as getConfig,
  isConfigLocked,
  resetConfigForTesting,
} from './config-manager';
import { createFrameworkLogger } from '../logger';

const logger = createFrameworkLogger('ConfigSystem');

/**
 * Initialize configuration system with createApp options
 * This is the main entry point called by createApp()
 *
 * @param options - createApp options that can override config file and defaults
 * @returns Immutable, validated configuration object
 */
export function initializeConfig(options?: MoroOptions): Readonly<AppConfig> {
  if (isConfigLocked()) {
    logger.debug('Configuration already locked, returning existing config');
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
