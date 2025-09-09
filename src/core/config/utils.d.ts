import { z } from 'zod';
import { AppConfig } from './schema';
/**
 * Set the global configuration (used by framework initialization)
 */
export declare function setConfig(config: AppConfig): void;
/**
 * Get the global configuration
 */
export declare function getConfig(): AppConfig;
/**
 * Create module-specific configuration with environment override support
 */
export declare function createModuleConfig<T>(
  schema: z.ZodSchema<T>,
  defaultConfig: Partial<T>,
  envPrefix?: string
): T;
/**
 * Get environment variable with type conversion
 */
export declare function getEnvVar<T>(
  key: string,
  defaultValue: T,
  converter?: (value: string) => T
): T;
/**
 * Parse comma-separated environment variable as array
 */
export declare function getEnvArray(key: string, defaultValue?: string[]): string[];
/**
 * Parse JSON environment variable safely
 */
export declare function getEnvJson<T>(key: string, defaultValue: T): T;
/**
 * Validate required environment variables
 */
export declare function requireEnvVars(...keys: string[]): void;
/**
 * Create environment variable name with prefix
 */
export declare function envVar(prefix: string, name: string): string;
/**
 * Get configuration value with dot notation
 */
export declare function getConfigValue(path: string): any;
/**
 * Check if we're in development environment
 */
export declare function isDevelopment(): boolean;
/**
 * Check if we're in production environment
 */
export declare function isProduction(): boolean;
/**
 * Check if we're in staging environment
 */
export declare function isStaging(): boolean;
