// Configuration File Loader - Load moro.config.js/ts files
import { existsSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { AppConfig } from './schema.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfigFile');

// Create require function for ESM to enable synchronous config loading
// Use process.cwd() as base since we're loading with absolute paths anyway
const moduleRequire = createRequire(join(process.cwd(), 'index.js'));

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

  logger.debug(`Loading configuration from: ${configFile}`);

  try {
    // Use createRequire to enable synchronous loading in ESM
    // Clear the require cache to ensure fresh config on each load
    delete moduleRequire.cache[moduleRequire.resolve(configFile)];

    const config = moduleRequire(configFile);

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
