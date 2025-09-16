// Configuration System - Main Exports and Utilities
export * from './schema';
export * from './loader';
export * from './utils';
export * from './file-loader';

// Main configuration loading function
import { loadConfig } from './loader';
import type { AppConfig } from './schema';
import { setConfig } from './utils';

// Global configuration instance
let globalConfig: AppConfig | null = null;

/**
 * Initialize and load the global application configuration
 * This should be called once at application startup
 */
export function initializeConfig(): AppConfig {
  if (globalConfig) {
    return globalConfig;
  }

  globalConfig = loadConfig();

  // Also set the config for utils functions
  setConfig(globalConfig);

  return globalConfig;
}

/**
 * Get the current global configuration
 * Throws if configuration hasn't been initialized
 */
export function getGlobalConfig(): AppConfig {
  if (!globalConfig) {
    throw new Error('Configuration not initialized. Call initializeConfig() first.');
  }
  return globalConfig;
}

/**
 * Check if configuration has been initialized
 */
export function isConfigInitialized(): boolean {
  return globalConfig !== null;
}

/**
 * Reset the global configuration state (for testing purposes)
 * @internal
 */
export function resetConfig(): void {
  globalConfig = null;

  // Also reset the utils config (by setting it to null via direct access)
  const { setConfig } = require('./utils');
  setConfig(null as any);
}
