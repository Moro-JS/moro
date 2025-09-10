// Configuration Utilities for Modules and Environment Handling
import { z } from 'zod';
import { AppConfig } from './schema';
import { createFrameworkLogger } from '../logger';

const logger = createFrameworkLogger('ConfigUtils');

// Global configuration store
let appConfig: AppConfig | null = null;

/**
 * Set the global configuration (used by framework initialization)
 */
export function setConfig(config: AppConfig): void {
  appConfig = config;
  logger.debug('Global configuration updated');
}

/**
 * Get the global configuration
 */
export function getConfig(): AppConfig {
  if (!appConfig) {
    throw new Error('Configuration not initialized. Call loadConfig() first.');
  }
  return appConfig;
}

/**
 * Coerce environment variable string values to appropriate types
 */
function coerceEnvironmentValue(value: string): any {
  // Handle boolean values
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // Handle numeric values
  if (/^\d+$/.test(value)) {
    const num = parseInt(value, 10);
    return num;
  }

  if (/^\d+\.\d+$/.test(value)) {
    const num = parseFloat(value);
    return num;
  }

  // Handle JSON objects/arrays
  if (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      // If JSON parsing fails, return as string
      return value;
    }
  }

  // Return as string for all other cases
  return value;
}

/**
 * Create module-specific configuration with environment override support
 */
export function createModuleConfig<T>(
  schema: z.ZodSchema<T>,
  defaultConfig: Partial<T>,
  envPrefix?: string
): T {
  // Try to get global config, but don't fail if not initialized
  let globalConfig = {};
  try {
    const { getGlobalConfig } = require('./index');
    globalConfig = getGlobalConfig();
  } catch {
    // Global config not initialized - use empty object (module config can still work independently)
    globalConfig = {};
  }

  // Build environment configuration object with type coercion
  const envConfig: Record<string, any> = {};

  if (envPrefix) {
    // Extract environment variables with the given prefix
    Object.keys(process.env).forEach(key => {
      if (key.startsWith(envPrefix)) {
        const configKey = key
          .substring(envPrefix.length)
          .toLowerCase()
          .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

        const envValue = process.env[key];
        if (envValue !== undefined) {
          // Attempt basic type coercion for common types
          envConfig[configKey] = coerceEnvironmentValue(envValue);
        }
      }
    });
  }

  // Merge default config, global defaults, and environment overrides
  // Priority: environment variables > global config > default config
  const mergedConfig = {
    ...defaultConfig,
    ...globalConfig, // Now actually using global config!
    ...envConfig,
  };

  try {
    return schema.parse(mergedConfig);
  } catch (error) {
    logger.error(`Module configuration validation failed for prefix ${envPrefix}:`, String(error));
    throw error;
  }
}

/**
 * Get environment variable with type conversion
 */
export function getEnvVar<T>(key: string, defaultValue: T, converter?: (value: string) => T): T {
  const value = process.env[key];

  if (value === undefined) {
    return defaultValue;
  }

  if (converter) {
    try {
      return converter(value);
    } catch (error) {
      logger.warn(`Failed to convert environment variable ${key}:`, String(error));
      return defaultValue;
    }
  }

  // Default type conversions
  if (typeof defaultValue === 'boolean') {
    return (value.toLowerCase() === 'true') as T;
  }

  if (typeof defaultValue === 'number') {
    const num = Number(value);
    return (isNaN(num) ? defaultValue : num) as T;
  }

  return value as T;
}

/**
 * Parse comma-separated environment variable as array
 */
export function getEnvArray(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];

  if (!value) {
    return defaultValue;
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Parse JSON environment variable safely
 */
export function getEnvJson<T>(key: string, defaultValue: T): T {
  const value = process.env[key];

  if (!value) {
    return defaultValue;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn(`Failed to parse JSON environment variable ${key}:`, String(error));
    return defaultValue;
  }
}

/**
 * Validate required environment variables
 */
export function requireEnvVars(...keys: string[]): void {
  const missing: string[] = [];

  keys.forEach(key => {
    if (!process.env[key]) {
      missing.push(key);
    }
  });

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Create environment variable name with prefix
 */
export function envVar(prefix: string, name: string): string {
  return `${prefix.toUpperCase()}_${name.toUpperCase()}`;
}

/**
 * Get configuration value with dot notation
 */
export function getConfigValue(path: string): any {
  const config = getConfig();

  return path.split('.').reduce((obj, key) => {
    return obj && obj[key] !== undefined ? obj[key] : undefined;
  }, config as any);
}

/**
 * Check if we're in development environment
 */
export function isDevelopment(): boolean {
  try {
    return getConfig().server.environment === 'development';
  } catch {
    return process.env.NODE_ENV === 'development';
  }
}

/**
 * Check if we're in production environment
 */
export function isProduction(): boolean {
  try {
    return getConfig().server.environment === 'production';
  } catch {
    return process.env.NODE_ENV === 'production';
  }
}

/**
 * Check if we're in staging environment
 */
export function isStaging(): boolean {
  try {
    return getConfig().server.environment === 'staging';
  } catch {
    return process.env.NODE_ENV === 'staging';
  }
}
