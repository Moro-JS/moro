/**
 * Configuration Sources - Load from Environment, Files, and Options
 *
 * This module handles loading configuration from different sources with clear precedence:
 * Environment Variables > createApp Options > Config File > Schema Defaults
 */

import { AppConfig } from '../../types/config';
import { MoroOptions } from '../../types/core';
import { DEFAULT_CONFIG } from './schema';
import { loadConfigFileSync } from './file-loader';
import { createFrameworkLogger } from '../logger';
import { validateConfig } from './config-validator';

const logger = createFrameworkLogger('ConfigSources');

/**
 * Configuration source metadata for debugging
 */
export interface ConfigSourceInfo {
  source: 'environment' | 'createApp' | 'configFile' | 'default';
  path: string;
  value: any;
}

/**
 * Load configuration from all sources with proper precedence
 * Returns a validated, complete configuration object
 */
export function loadConfigFromAllSources(createAppOptions?: MoroOptions): AppConfig {
  logger.debug('Loading configuration from all sources');

  // 1. Start with schema defaults
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  const sourceMap = new Map<string, ConfigSourceInfo>();

  // Track default values
  trackConfigSource(config, sourceMap, 'default', 'schema');

  // 2. Load and merge config file (if exists)
  try {
    const fileConfig = loadConfigFileSync();
    if (fileConfig) {
      config = deepMerge(config, fileConfig);
      trackConfigSource(fileConfig, sourceMap, 'configFile', 'moro.config.js/ts');
      logger.debug('Config file loaded and merged');
    }
  } catch (error) {
    logger.warn('Config file loading failed, continuing without it:', String(error));
  }

  // 3. Load and merge environment variables
  const envConfig = loadEnvironmentConfig();
  config = deepMerge(config, envConfig);
  trackConfigSource(envConfig, sourceMap, 'environment', 'process.env');

  // 4. Load and merge createApp options (highest precedence)
  if (createAppOptions) {
    const normalizedOptions = normalizeCreateAppOptions(createAppOptions);
    config = deepMerge(config, normalizedOptions);
    trackConfigSource(normalizedOptions, sourceMap, 'createApp', 'createApp()');
    logger.debug('createApp options merged');
  }

  // 5. Validate the final configuration
  const validatedConfig = validateConfig(config);

  // Log configuration sources for debugging
  logConfigurationSources(sourceMap);

  return validatedConfig;
}

/**
 * Load configuration from environment variables
 * Handles both standard and MORO_ prefixed variables
 */
function loadEnvironmentConfig(): Partial<AppConfig> {
  const config: Partial<AppConfig> = {};

  // Server configuration
  if (process.env.PORT || process.env.MORO_PORT) {
    if (!config.server) config.server = {} as any;
    config.server!.port = parseInt(process.env.PORT || process.env.MORO_PORT || '3001', 10);
  }

  if (process.env.HOST || process.env.MORO_HOST) {
    if (!config.server) config.server = {} as any;
    config.server!.host = process.env.HOST || process.env.MORO_HOST || 'localhost';
  }

  if (process.env.MAX_CONNECTIONS || process.env.MORO_MAX_CONNECTIONS) {
    if (!config.server) config.server = {} as any;
    config.server!.maxConnections = parseInt(
      process.env.MAX_CONNECTIONS || process.env.MORO_MAX_CONNECTIONS || '1000',
      10
    );
  }

  if (process.env.REQUEST_TIMEOUT || process.env.MORO_TIMEOUT) {
    if (!config.server) config.server = {} as any;
    config.server!.timeout = parseInt(
      process.env.REQUEST_TIMEOUT || process.env.MORO_TIMEOUT || '30000',
      10
    );
  }

  // Database configuration
  if (process.env.DATABASE_URL || process.env.MORO_DATABASE_URL) {
    if (!config.database) config.database = {} as any;
    config.database!.url = process.env.DATABASE_URL || process.env.MORO_DATABASE_URL;
  }

  // Redis configuration
  if (process.env.REDIS_URL || process.env.MORO_REDIS_URL) {
    if (!config.database) config.database = {} as any;
    if (!config.database!.redis) config.database!.redis = {} as any;
    config.database!.redis!.url =
      process.env.REDIS_URL || process.env.MORO_REDIS_URL || 'redis://localhost:6379';
    config.database!.redis!.maxRetries = parseInt(
      process.env.REDIS_MAX_RETRIES || process.env.MORO_REDIS_MAX_RETRIES || '3',
      10
    );
    config.database!.redis!.retryDelay = parseInt(
      process.env.REDIS_RETRY_DELAY || process.env.MORO_REDIS_RETRY_DELAY || '1000',
      10
    );
    config.database!.redis!.keyPrefix =
      process.env.REDIS_KEY_PREFIX || process.env.MORO_REDIS_KEY_PREFIX || 'moro:';
  }

  // MySQL configuration - only include if MYSQL_HOST is set
  if (process.env.MYSQL_HOST || process.env.MORO_MYSQL_HOST) {
    if (!config.database) config.database = {} as any;
    config.database!.mysql = {
      host: process.env.MYSQL_HOST || process.env.MORO_MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || process.env.MORO_MYSQL_PORT || '3306', 10),
      database: process.env.MYSQL_DATABASE || process.env.MORO_MYSQL_DB,
      username: process.env.MYSQL_USERNAME || process.env.MORO_MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || process.env.MORO_MYSQL_PASS,
      connectionLimit: parseInt(
        process.env.MYSQL_CONNECTION_LIMIT || process.env.MORO_MYSQL_CONNECTIONS || '10',
        10
      ),
      acquireTimeout: parseInt(
        process.env.MYSQL_ACQUIRE_TIMEOUT || process.env.MORO_MYSQL_ACQUIRE || '60000',
        10
      ),
      timeout: parseInt(process.env.MYSQL_TIMEOUT || process.env.MORO_MYSQL_TIMEOUT || '60000', 10),
    } as any;
  }

  // Logging configuration
  if (process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL) {
    const level = process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL;
    if (
      level === 'debug' ||
      level === 'info' ||
      level === 'warn' ||
      level === 'error' ||
      level === 'fatal'
    ) {
      if (!config.logging) config.logging = {} as any;
      config.logging!.level = level;
    }
  }

  // External services - only include if configured
  const externalConfig: Partial<AppConfig['external']> = {};

  // Stripe
  if (process.env.STRIPE_SECRET_KEY || process.env.MORO_STRIPE_SECRET) {
    externalConfig.stripe = {
      secretKey: process.env.STRIPE_SECRET_KEY || process.env.MORO_STRIPE_SECRET,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || process.env.MORO_STRIPE_PUBLIC,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || process.env.MORO_STRIPE_WEBHOOK,
      apiVersion: process.env.STRIPE_API_VERSION || process.env.MORO_STRIPE_VERSION || '2023-10-16',
    };
  }

  // PayPal
  if (process.env.PAYPAL_CLIENT_ID || process.env.MORO_PAYPAL_CLIENT) {
    externalConfig.paypal = {
      clientId: process.env.PAYPAL_CLIENT_ID || process.env.MORO_PAYPAL_CLIENT,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET || process.env.MORO_PAYPAL_SECRET,
      webhookId: process.env.PAYPAL_WEBHOOK_ID || process.env.MORO_PAYPAL_WEBHOOK,
      environment:
        (process.env.PAYPAL_ENVIRONMENT || process.env.MORO_PAYPAL_ENV) === 'production'
          ? 'production'
          : 'sandbox',
    };
  }

  // SMTP
  if (process.env.SMTP_HOST || process.env.MORO_SMTP_HOST) {
    externalConfig.smtp = {
      host: process.env.SMTP_HOST || process.env.MORO_SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || process.env.MORO_SMTP_PORT || '587', 10),
      secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
      username: process.env.SMTP_USERNAME || process.env.MORO_SMTP_USER,
      password: process.env.SMTP_PASSWORD || process.env.MORO_SMTP_PASS,
    };
  }

  if (Object.keys(externalConfig).length > 0) {
    config.external = externalConfig;
  }

  return config;
}

/**
 * Normalize createApp options to match AppConfig structure
 * This handles the flexible createApp API while converting to structured config
 */
function normalizeCreateAppOptions(options: MoroOptions): Partial<AppConfig> {
  const config: Partial<AppConfig> = {};

  // Direct config section overrides - merge with existing config
  if (options.server) {
    config.server = { ...config.server, ...options.server } as any;
  }
  if (options.database) {
    config.database = { ...config.database, ...options.database } as any;
  }
  if (options.modules) {
    config.modules = { ...config.modules, ...options.modules } as any;
  }
  if (options.logging) {
    config.logging = { ...config.logging, ...options.logging } as any;
  }
  if (options.security) {
    config.security = { ...config.security, ...options.security } as any;
  }
  if (options.external) {
    config.external = { ...config.external, ...options.external } as any;
  }
  if (options.performance) {
    config.performance = { ...config.performance, ...options.performance } as any;
  }

  // Handle shorthand boolean/object options
  if (options.cors !== undefined) {
    config.security = {
      ...config.security,
      cors:
        typeof options.cors === 'boolean'
          ? { ...DEFAULT_CONFIG.security.cors, enabled: options.cors }
          : { ...DEFAULT_CONFIG.security.cors, ...options.cors },
    } as any;
  }

  if (options.compression !== undefined) {
    config.performance = {
      ...config.performance,
      compression:
        typeof options.compression === 'boolean'
          ? { ...DEFAULT_CONFIG.performance.compression, enabled: options.compression }
          : { ...DEFAULT_CONFIG.performance.compression, ...options.compression },
    } as any;
  }

  if (options.helmet !== undefined) {
    config.security = {
      ...config.security,
      helmet:
        typeof options.helmet === 'boolean'
          ? { ...DEFAULT_CONFIG.security.helmet, enabled: options.helmet }
          : { ...DEFAULT_CONFIG.security.helmet, ...options.helmet },
    } as any;
  }

  return config;
}

/**
 * Check if a config field contains sensitive information
 */
function isSensitiveField(path: string): boolean {
  const sensitivePatterns = [
    'password',
    'secret',
    'key',
    'token',
    'auth',
    'stripe',
    'paypal',
    'smtp.password',
    'smtp.username',
    'database.url',
    'redis.url',
    'mysql.password',
  ];

  return sensitivePatterns.some(pattern => path.toLowerCase().includes(pattern.toLowerCase()));
}

/**
 * Deep merge two configuration objects
 * Later object properties override earlier ones
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      (result as any)[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      (result as any)[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Track configuration sources for debugging
 */
function trackConfigSource(
  config: any,
  sourceMap: Map<string, ConfigSourceInfo>,
  source: ConfigSourceInfo['source'],
  path: string
): void {
  function traverse(obj: any, currentPath: string): void {
    for (const key in obj) {
      const value = obj[key];
      const fullPath = currentPath ? `${currentPath}.${key}` : key;

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        traverse(value, fullPath);
      } else {
        sourceMap.set(fullPath, { source, path, value });
      }
    }
  }

  traverse(config, '');
}

/**
 * Log configuration sources for debugging
 */
function logConfigurationSources(sourceMap: Map<string, ConfigSourceInfo>): void {
  const allSources = Array.from(sourceMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const nonDefaultSources = allSources.filter(([_, info]) => info.source !== 'default');

  if (process.env.NODE_ENV === 'production') {
    // In production, only show non-default values with sensitive data obfuscated
    if (nonDefaultSources.length > 0) {
      logger.debug(`Configuration overrides loaded (${nonDefaultSources.length} total)`);

      nonDefaultSources.forEach(([path, info]) => {
        const valueStr = isSensitiveField(path)
          ? '***'
          : typeof info.value === 'object'
            ? JSON.stringify(info.value)
            : String(info.value);
        logger.debug(`  ${path}: ${valueStr} (from ${info.source})`);
      });
    } else {
      logger.debug('Using default configuration (no overrides)');
    }
  } else {
    // In development, show all sources for debugging
    logger.debug(`Configuration sources loaded (${allSources.length} total)`);

    allSources.forEach(([path, info]) => {
      const valueStr =
        typeof info.value === 'object' ? JSON.stringify(info.value) : String(info.value);
      logger.debug(`  ${path}: ${valueStr} (from ${info.source})`);
    });
  }
}
