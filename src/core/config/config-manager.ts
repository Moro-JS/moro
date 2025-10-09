/**
 * Configuration Manager - Immutable Single Source of Truth
 *
 * This module provides centralized, immutable configuration state management.
 * Configuration is locked at createApp() initialization and cannot be changed afterward.
 *
 * Precedence: Environment Variables > createApp Options > Config File > Defaults
 */

import { AppConfig } from '../../types/config.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfigManager');

/**
 * Global configuration state - immutable after initialization
 */
let globalConfig: Readonly<AppConfig> | null = null;
let isLocked = false;

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

  logger.info(
    `Configuration locked and initialized: ${process.env.NODE_ENV || 'development'}:${config.server.port}`
  );
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
  logger.debug('Configuration state reset for testing');
}

/**
 * Deep freeze an object to make it truly immutable
 * This prevents any accidental mutations to the configuration
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  // Get property names
  const propNames = Object.getOwnPropertyNames(obj);

  // Freeze properties before freezing self
  for (const name of propNames) {
    const value = (obj as any)[name];

    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
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
