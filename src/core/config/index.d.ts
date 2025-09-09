export * from './schema';
export * from './loader';
export * from './utils';
export { z } from 'zod';
import type { AppConfig } from './schema';
/**
 * Initialize and load the global application configuration
 * This should be called once at application startup
 */
export declare function initializeConfig(): AppConfig;
/**
 * Get the current global configuration
 * Throws if configuration hasn't been initialized
 */
export declare function getGlobalConfig(): AppConfig;
/**
 * Check if configuration has been initialized
 */
export declare function isConfigInitialized(): boolean;
