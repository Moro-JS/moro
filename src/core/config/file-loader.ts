// Configuration File Loader - Load moro.config.js/ts files
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { AppConfig, DeepPartial } from '../../types/config.js';
import { createFrameworkLogger } from '../logger/index.js';
import { filePathToImportURL } from '../utilities/package-utils.js';
import { foundThroughWorkingDirectory } from '../utilities/working-directory.js';

const logger = createFrameworkLogger('ConfigFile');

// Create require function for ESM to enable synchronous config loading
// Use process.cwd() as base since we're loading with absolute paths anyway
const moduleRequire = createRequire(join(process.cwd(), 'index.js'));

/**
 * Supported configuration file names in order of preference.
 *
 * moro.config.cjs is checked first — users in ESM projects ("type":"module")
 * should name their config file .cjs to guarantee CJS loading via require().
 *
 * moro.config.js is checked second. If the project has "type":"module" this
 * file will be ESM and cannot be require()'d. The error is caught and logged
 * as a clear warning — the pipeline then falls back to env vars + createApp().
 */
const CONFIG_FILES = ['moro.config.cjs', 'moro.config.js', 'moro.config.ts'] as const;

/**
 * A configuration file that exists and could not be loaded, in production.
 * `file` is its path and `cause` the original error.
 */
export class ConfigFileLoadError extends Error {
  constructor(
    public readonly file: string,
    cause: unknown
  ) {
    super(
      `Configuration file ${file} could not be loaded: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        'In production the app does not start without it: running on defaults would ' +
        'drop the port, TLS and security settings the file was written to set.',
      { cause }
    );
    this.name = 'ConfigFileLoadError';
  }
}

/**
 * A config file that is present but fails to load (a syntax error, an import
 * that cannot be resolved, a TypeScript file with no loader) is logged. In
 * production that is fatal; elsewhere the app starts without the file.
 */
function reportUnloadableConfigFile(configFile: string, error: unknown): null {
  logger.error(`Failed to load configuration file ${configFile}: ${String(error)}`);
  if (process.env.NODE_ENV === 'production') {
    throw new ConfigFileLoadError(configFile, error);
  }
  logger.warn('Falling back to environment variable configuration');
  return null;
}

/**
 * Find and load configuration from moro.config.cjs / moro.config.js (synchronously).
 *
 * Note on ESM projects: if your project has "type":"module" in package.json,
 * the compiled moro.config.js will be treated as ESM by Node.js and cannot be
 * loaded with require(). In that case this function logs a clear warning and
 * returns null. Configuration still works via environment variables and
 * createApp() options. To use a config file, rename it moro.config.cjs and
 * use module.exports = { ... }.
 *
 * @param cwd Current working directory to search for config files
 * @returns DeepPartial configuration object or null if no config file found
 */
export function loadConfigFileSync(cwd: string = process.cwd()): DeepPartial<AppConfig> | null {
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

    const configModule = moduleRequire(configFile);

    // Handle ES module default export
    const config = configModule.default || configModule;

    if (!config || typeof config !== 'object') {
      logger.warn(`Configuration file ${configFile} did not export a valid configuration object`);
      return null;
    }

    loadedFrom(configFile, cwd);
    return config;
  } catch (error) {
    const isEsmError =
      error instanceof Error &&
      ((error as NodeJS.ErrnoException).code === 'ERR_REQUIRE_ESM' ||
        error.message.includes('ERR_REQUIRE_ESM'));

    if (isEsmError) {
      // Expected when the project has "type":"module" — the compiled .js config
      // is an ES module and cannot be loaded with require(). This is a Node.js
      // restriction, not a framework bug. Config from env vars still applies.
      logger.warn(
        `Config file ${configFile} is an ES module (your project has "type":"module") ` +
          `and cannot be loaded synchronously. Configuration will be read from environment ` +
          `variables and createApp() options. To use a config file, rename it to ` +
          `moro.config.cjs and export with module.exports = { ... }.`
      );
    } else {
      return reportUnloadableConfigFile(configFile, error);
    }

    return null;
  }
}

/**
 * Find and load configuration from moro.config.js or moro.config.ts (async).
 * Uses dynamic import() so it works with both CJS and ESM config files.
 *
 * @param cwd Current working directory to search for config files
 * @returns DeepPartial configuration object or null if no config file found
 */
export async function loadConfigFile(
  cwd: string = process.cwd()
): Promise<DeepPartial<AppConfig> | null> {
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

    loadedFrom(configFile, cwd);
    return config;
  } catch (error) {
    return reportUnloadableConfigFile(configFile, error);
  }
}

/**
 * The configuration file to load: the one `MORO_CONFIG_FILE` names, else the
 * first of the supported names that exists in the given directory.
 *
 * `MORO_CONFIG_FILE` pins the file for a deployment: a path, absolute or
 * relative to the working directory. Nothing is looked for anywhere else
 * then, and a file that is not there is reported like one that cannot be
 * loaded (fatal in production).
 */
function findConfigFile(cwd: string): string | null {
  const pinned = process.env.MORO_CONFIG_FILE;
  if (pinned) {
    const filePath = resolve(cwd, pinned);
    if (existsSync(filePath)) return filePath;
    return reportUnloadableConfigFile(
      filePath,
      new Error('MORO_CONFIG_FILE names a file that does not exist')
    );
  }

  for (const fileName of CONFIG_FILES) {
    const filePath = join(cwd, fileName);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

/** A file found by its name in `cwd`, not pinned: say so when the app was started elsewhere. */
function loadedFrom(configFile: string, cwd: string): void {
  logger.info(`Configuration loaded from: ${configFile}`);
  if (process.env.MORO_CONFIG_FILE) return;
  foundThroughWorkingDirectory(
    logger,
    'configuration file',
    configFile,
    cwd,
    'set MORO_CONFIG_FILE to the path of the configuration file'
  );
}

/**
 * Dynamically import a configuration file
 */
async function importConfigFile(filePath: string): Promise<DeepPartial<AppConfig> | null> {
  const isTypeScript = filePath.endsWith('.ts');

  if (isTypeScript) {
    await setupTypeScriptLoader();
  }

  try {
    const importURL = filePathToImportURL(filePath);
    const configModule = await import(importURL);

    // Handle both default export and module.exports
    const config = configModule.default || configModule;

    return config;
  } catch (error) {
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
 * Setup TypeScript loader for .ts config files.
 * TypeScript loading is delegated to the runtime environment (tsx, ts-node).
 */
async function setupTypeScriptLoader(): Promise<void> {
  logger.debug('TypeScript config loading delegated to runtime environment');
}
