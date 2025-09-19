// Configuration File Loader - Load moro.config.js/ts files
import { existsSync } from 'fs';
import { join } from 'path';
import { AppConfig } from './schema';
import { createFrameworkLogger } from '../logger';

const logger = createFrameworkLogger('ConfigFile');

/**
 * Supported configuration file names in order of preference
 */
const CONFIG_FILES = ['moro.config.js', 'moro.config.ts'] as const;

/**
 * Find and load configuration from moro.config.js (synchronously)
 * @param cwd Current working directory to search for config files
 * @returns Partial configuration object or null if no config file found
 */
export function loadConfigFileSync(cwd: string = process.cwd()): Partial<AppConfig> | null {
  const configFile = findConfigFile(cwd);

  if (!configFile) {
    logger.debug('No configuration file found');
    return null;
  }
  // Handle TypeScript files by trying dynamic import (works with tsx/ts-node runtimes)
  if (configFile.endsWith('.ts')) {
    logger.debug('Found TypeScript config file, attempting to load with dynamic import');
    try {
      // When running under tsx/ts-node, dynamic imports work synchronously for TypeScript
      // We can use require() with the current environment that already has TypeScript support
      const config = require(configFile);
      const configData = config.default || config;

      if (!configData || typeof configData !== 'object') {
        logger.warn(`Configuration file ${configFile} did not export a valid configuration object`);
        return null;
      }

      logger.info(`TypeScript configuration loaded from: ${configFile}`);
      return configData;
    } catch (error) {
      logger.debug(
        'TypeScript config loading failed in sync mode, this is expected if not running with tsx/ts-node'
      );
      logger.debug('Error details:', String(error));
      return null;
    }
  }

  // Only .js files use the standard synchronous loading
  if (!configFile.endsWith('.js')) {
    logger.debug(
      'Found config file with unsupported extension. Only .js and .ts files are supported.'
    );
    return null;
  }

  logger.debug(`Loading configuration from: ${configFile}`);

  try {
    // Clear module cache to ensure fresh load
    delete require.cache[require.resolve(configFile)];

    const config = require(configFile);
    const configData = config.default || config;

    if (!configData || typeof configData !== 'object') {
      logger.warn(`Configuration file ${configFile} did not export a valid configuration object`);
      return null;
    }

    logger.info(`Configuration loaded from: ${configFile}`);
    return configData;
  } catch (error) {
    logger.error(`Failed to load configuration file ${configFile}:`, String(error));
    logger.warn('Falling back to environment variable configuration');
    return null;
  }
}

/**
 * Find and load configuration from moro.config.js or moro.config.ts (async)
 * @param cwd Current working directory to search for config files
 * @returns Partial configuration object or null if no config file found
 */
export async function loadConfigFile(
  cwd: string = process.cwd()
): Promise<Partial<AppConfig> | null> {
  const configFile = findConfigFile(cwd);

  if (!configFile) {
    logger.debug('No configuration file found');
    return null;
  }

  logger.debug(`Loading configuration from: ${configFile}`);

  try {
    const config = await importConfigFile(configFile);

    if (!config || typeof config !== 'object') {
      logger.warn(`Configuration file ${configFile} did not export a valid configuration object`);
      return null;
    }

    logger.info(`Configuration loaded from: ${configFile}`);
    return config;
  } catch (error) {
    logger.error(`Failed to load configuration file ${configFile}:`, String(error));
    logger.warn('Falling back to environment variable configuration');
    return null;
  }
}

/**
 * Find the first existing configuration file in the given directory
 */
function findConfigFile(cwd: string): string | null {
  for (const fileName of CONFIG_FILES) {
    const filePath = join(cwd, fileName);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Dynamically import a configuration file
 */
async function importConfigFile(filePath: string): Promise<Partial<AppConfig> | null> {
  const isTypeScript = filePath.endsWith('.ts');

  if (isTypeScript) {
    // For TypeScript files, we need to handle ts-node/tsx or similar
    await setupTypeScriptLoader();
  }

  try {
    // Use dynamic import to load the configuration
    const configModule = await import(filePath);

    // Handle both default export and module.exports
    const config = configModule.default || configModule;

    return config;
  } catch (error) {
    // If TypeScript loading fails, provide helpful error message
    if (
      isTypeScript &&
      error instanceof Error &&
      error.message.includes('Unknown file extension')
    ) {
      throw new Error(
        `Failed to load TypeScript config file. Run your application with tsx or ts-node: "tsx your-app.ts" or "ts-node your-app.ts"`
      );
    }
    throw error;
  }
}

/**
 * Setup TypeScript loader for .ts config files
 * Note: This function is intentionally minimal because TypeScript config files
 * should be handled by the runtime environment (tsx, ts-node, etc.) when the
 * user runs their application, not by the framework itself.
 */
async function setupTypeScriptLoader(): Promise<void> {
  // No-op: TypeScript loading is handled by the runtime environment
  // When users run `tsx moro.config.ts` or `ts-node moro.config.ts`,
  // the TypeScript transpilation is already handled by those tools.
  logger.debug('TypeScript config loading delegated to runtime environment');
}
