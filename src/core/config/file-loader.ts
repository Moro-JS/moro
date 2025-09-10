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

  // Only support .js files for synchronous loading to avoid complexity
  if (!configFile.endsWith('.js')) {
    logger.debug(
      'Found config file, but only JavaScript files are supported in sync mode. Use loadConfigFile() for TypeScript support.'
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
        `Failed to load TypeScript config file. Make sure you have ts-node installed: npm install --save-dev ts-node`
      );
    }
    throw error;
  }
}

/**
 * Setup TypeScript loader for .ts config files
 */
async function setupTypeScriptLoader(): Promise<void> {
  try {
    // Try to register ts-node if available
    const tsNode = await import('ts-node');
    if (!tsNode.register) {
      // ts-node might already be registered
      return;
    }

    tsNode.register({
      transpileOnly: true,
      compilerOptions: {
        module: 'commonjs',
        target: 'es2020',
        moduleResolution: 'node',
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
      },
    });
  } catch (error) {
    // ts-node not available, try other methods or fail gracefully
    logger.debug('ts-node not available for TypeScript config loading');
  }
}

/**
 * Convert a configuration object to environment variable mappings
 * This function flattens the config object and sets corresponding environment variables
 */
export function applyConfigAsEnvironmentVariables(config: Partial<AppConfig>): void {
  if (!config || typeof config !== 'object') {
    return;
  }

  // Apply server configuration
  if (config.server) {
    setEnvIfNotSet('PORT', config.server.port?.toString());
    setEnvIfNotSet('HOST', config.server.host);
    setEnvIfNotSet('NODE_ENV', config.server.environment);
    setEnvIfNotSet('MAX_CONNECTIONS', config.server.maxConnections?.toString());
    setEnvIfNotSet('REQUEST_TIMEOUT', config.server.timeout?.toString());
  }

  // Apply database configuration
  if (config.database) {
    setEnvIfNotSet('DATABASE_URL', config.database.url);

    if (config.database.redis) {
      setEnvIfNotSet('REDIS_URL', config.database.redis.url);
      setEnvIfNotSet('REDIS_MAX_RETRIES', config.database.redis.maxRetries?.toString());
      setEnvIfNotSet('REDIS_RETRY_DELAY', config.database.redis.retryDelay?.toString());
      setEnvIfNotSet('REDIS_KEY_PREFIX', config.database.redis.keyPrefix);
    }

    if (config.database.mysql) {
      setEnvIfNotSet('MYSQL_HOST', config.database.mysql.host);
      setEnvIfNotSet('MYSQL_PORT', config.database.mysql.port?.toString());
      setEnvIfNotSet('MYSQL_DATABASE', config.database.mysql.database);
      setEnvIfNotSet('MYSQL_USERNAME', config.database.mysql.username);
      setEnvIfNotSet('MYSQL_PASSWORD', config.database.mysql.password);
      setEnvIfNotSet('MYSQL_CONNECTION_LIMIT', config.database.mysql.connectionLimit?.toString());
      setEnvIfNotSet('MYSQL_ACQUIRE_TIMEOUT', config.database.mysql.acquireTimeout?.toString());
      setEnvIfNotSet('MYSQL_TIMEOUT', config.database.mysql.timeout?.toString());
    }
  }

  // Apply service discovery configuration
  if (config.serviceDiscovery) {
    setEnvIfNotSet('SERVICE_DISCOVERY_ENABLED', config.serviceDiscovery.enabled?.toString());
    setEnvIfNotSet('DISCOVERY_TYPE', config.serviceDiscovery.type);
    setEnvIfNotSet('CONSUL_URL', config.serviceDiscovery.consulUrl);
    setEnvIfNotSet('K8S_NAMESPACE', config.serviceDiscovery.kubernetesNamespace);
    setEnvIfNotSet(
      'HEALTH_CHECK_INTERVAL',
      config.serviceDiscovery.healthCheckInterval?.toString()
    );
    setEnvIfNotSet('DISCOVERY_RETRY_ATTEMPTS', config.serviceDiscovery.retryAttempts?.toString());
  }

  // Apply logging configuration
  if (config.logging) {
    setEnvIfNotSet('LOG_LEVEL', config.logging.level);
    setEnvIfNotSet('LOG_FORMAT', config.logging.format);
    setEnvIfNotSet('LOG_COLORS', config.logging.enableColors?.toString());
    setEnvIfNotSet('LOG_TIMESTAMP', config.logging.enableTimestamp?.toString());
    setEnvIfNotSet('LOG_CONTEXT', config.logging.enableContext?.toString());

    if (config.logging.outputs) {
      setEnvIfNotSet('LOG_CONSOLE', config.logging.outputs.console?.toString());

      if (config.logging.outputs.file) {
        setEnvIfNotSet('LOG_FILE_ENABLED', config.logging.outputs.file.enabled?.toString());
        setEnvIfNotSet('LOG_FILE_PATH', config.logging.outputs.file.path);
        setEnvIfNotSet('LOG_FILE_MAX_SIZE', config.logging.outputs.file.maxSize);
        setEnvIfNotSet('LOG_FILE_MAX_FILES', config.logging.outputs.file.maxFiles?.toString());
      }

      if (config.logging.outputs.webhook) {
        setEnvIfNotSet('LOG_WEBHOOK_ENABLED', config.logging.outputs.webhook.enabled?.toString());
        setEnvIfNotSet('LOG_WEBHOOK_URL', config.logging.outputs.webhook.url);
        if (config.logging.outputs.webhook.headers) {
          setEnvIfNotSet(
            'LOG_WEBHOOK_HEADERS',
            JSON.stringify(config.logging.outputs.webhook.headers)
          );
        }
      }
    }
  }

  // Apply module defaults
  if (config.modules) {
    if (config.modules.cache) {
      setEnvIfNotSet('CACHE_ENABLED', config.modules.cache.enabled?.toString());
      setEnvIfNotSet('DEFAULT_CACHE_TTL', config.modules.cache.defaultTtl?.toString());
      setEnvIfNotSet('CACHE_MAX_SIZE', config.modules.cache.maxSize?.toString());
      setEnvIfNotSet('CACHE_STRATEGY', config.modules.cache.strategy);
    }

    if (config.modules.rateLimit) {
      setEnvIfNotSet('RATE_LIMIT_ENABLED', config.modules.rateLimit.enabled?.toString());
      setEnvIfNotSet(
        'DEFAULT_RATE_LIMIT_REQUESTS',
        config.modules.rateLimit.defaultRequests?.toString()
      );
      setEnvIfNotSet(
        'DEFAULT_RATE_LIMIT_WINDOW',
        config.modules.rateLimit.defaultWindow?.toString()
      );
      setEnvIfNotSet(
        'RATE_LIMIT_SKIP_SUCCESS',
        config.modules.rateLimit.skipSuccessfulRequests?.toString()
      );
      setEnvIfNotSet(
        'RATE_LIMIT_SKIP_FAILED',
        config.modules.rateLimit.skipFailedRequests?.toString()
      );
    }

    if (config.modules.validation) {
      setEnvIfNotSet('VALIDATION_ENABLED', config.modules.validation.enabled?.toString());
      setEnvIfNotSet(
        'VALIDATION_STRIP_UNKNOWN',
        config.modules.validation.stripUnknown?.toString()
      );
      setEnvIfNotSet('VALIDATION_ABORT_EARLY', config.modules.validation.abortEarly?.toString());
    }
  }

  // Apply security configuration
  if (config.security) {
    if (config.security.cors) {
      setEnvIfNotSet('CORS_ENABLED', config.security.cors.enabled?.toString());
      if (typeof config.security.cors.origin === 'string') {
        setEnvIfNotSet('CORS_ORIGIN', config.security.cors.origin);
      } else if (Array.isArray(config.security.cors.origin)) {
        setEnvIfNotSet('CORS_ORIGIN', config.security.cors.origin.join(','));
      } else if (typeof config.security.cors.origin === 'boolean') {
        setEnvIfNotSet('CORS_ORIGIN', config.security.cors.origin.toString());
      }
      setEnvIfNotSet('CORS_METHODS', config.security.cors.methods?.join(','));
      setEnvIfNotSet('CORS_HEADERS', config.security.cors.allowedHeaders?.join(','));
      setEnvIfNotSet('CORS_CREDENTIALS', config.security.cors.credentials?.toString());
    }

    if (config.security.helmet) {
      setEnvIfNotSet('HELMET_ENABLED', config.security.helmet.enabled?.toString());
      setEnvIfNotSet('HELMET_CSP', config.security.helmet.contentSecurityPolicy?.toString());
      setEnvIfNotSet('HELMET_HSTS', config.security.helmet.hsts?.toString());
      setEnvIfNotSet('HELMET_NO_SNIFF', config.security.helmet.noSniff?.toString());
      setEnvIfNotSet('HELMET_FRAMEGUARD', config.security.helmet.frameguard?.toString());
    }

    if (config.security.rateLimit?.global) {
      setEnvIfNotSet(
        'GLOBAL_RATE_LIMIT_ENABLED',
        config.security.rateLimit.global.enabled?.toString()
      );
      setEnvIfNotSet(
        'GLOBAL_RATE_LIMIT_REQUESTS',
        config.security.rateLimit.global.requests?.toString()
      );
      setEnvIfNotSet(
        'GLOBAL_RATE_LIMIT_WINDOW',
        config.security.rateLimit.global.window?.toString()
      );
    }
  }

  // Apply external services configuration
  if (config.external) {
    if (config.external.stripe) {
      setEnvIfNotSet('STRIPE_SECRET_KEY', config.external.stripe.secretKey);
      setEnvIfNotSet('STRIPE_PUBLISHABLE_KEY', config.external.stripe.publishableKey);
      setEnvIfNotSet('STRIPE_WEBHOOK_SECRET', config.external.stripe.webhookSecret);
      setEnvIfNotSet('STRIPE_API_VERSION', config.external.stripe.apiVersion);
    }

    if (config.external.paypal) {
      setEnvIfNotSet('PAYPAL_CLIENT_ID', config.external.paypal.clientId);
      setEnvIfNotSet('PAYPAL_CLIENT_SECRET', config.external.paypal.clientSecret);
      setEnvIfNotSet('PAYPAL_WEBHOOK_ID', config.external.paypal.webhookId);
      setEnvIfNotSet('PAYPAL_ENVIRONMENT', config.external.paypal.environment);
    }

    if (config.external.smtp) {
      setEnvIfNotSet('SMTP_HOST', config.external.smtp.host);
      setEnvIfNotSet('SMTP_PORT', config.external.smtp.port?.toString());
      setEnvIfNotSet('SMTP_SECURE', config.external.smtp.secure?.toString());
      setEnvIfNotSet('SMTP_USERNAME', config.external.smtp.username);
      setEnvIfNotSet('SMTP_PASSWORD', config.external.smtp.password);
    }
  }

  // Apply performance configuration
  if (config.performance) {
    if (config.performance.compression) {
      setEnvIfNotSet('COMPRESSION_ENABLED', config.performance.compression.enabled?.toString());
      setEnvIfNotSet('COMPRESSION_LEVEL', config.performance.compression.level?.toString());
      setEnvIfNotSet('COMPRESSION_THRESHOLD', config.performance.compression.threshold?.toString());
    }

    if (config.performance.circuitBreaker) {
      setEnvIfNotSet(
        'CIRCUIT_BREAKER_ENABLED',
        config.performance.circuitBreaker.enabled?.toString()
      );
      setEnvIfNotSet(
        'CIRCUIT_BREAKER_THRESHOLD',
        config.performance.circuitBreaker.failureThreshold?.toString()
      );
      setEnvIfNotSet(
        'CIRCUIT_BREAKER_RESET',
        config.performance.circuitBreaker.resetTimeout?.toString()
      );
      setEnvIfNotSet(
        'CIRCUIT_BREAKER_MONITOR',
        config.performance.circuitBreaker.monitoringPeriod?.toString()
      );
    }

    if (config.performance.clustering) {
      setEnvIfNotSet('CLUSTERING_ENABLED', config.performance.clustering.enabled?.toString());
      setEnvIfNotSet('CLUSTER_WORKERS', config.performance.clustering.workers?.toString());
    }
  }
}

/**
 * Set environment variable only if it's not already set
 * This ensures environment variables take precedence over config file values
 */
function setEnvIfNotSet(key: string, value: string | undefined): void {
  if (value !== undefined && process.env[key] === undefined) {
    process.env[key] = value;
  }
}
