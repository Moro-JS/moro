// Configuration System - Main Exports and Utilities
export * from "./schema";
export * from "./loader";
export * from "./utils";

// Re-export common Zod utilities for configuration
export { z } from "zod";

// Main configuration loading function
import { loadConfig } from "./loader";
import type { AppConfig } from "./schema";

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
  return globalConfig;
}

/**
 * Get the current global configuration
 * Throws if configuration hasn't been initialized
 */
export function getGlobalConfig(): AppConfig {
  if (!globalConfig) {
    throw new Error(
      "Configuration not initialized. Call initializeConfig() first.",
    );
  }
  return globalConfig;
}

/**
 * Check if configuration has been initialized
 */
export function isConfigInitialized(): boolean {
  return globalConfig !== null;
}
