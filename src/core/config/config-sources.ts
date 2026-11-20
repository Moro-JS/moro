/* eslint-disable @typescript-eslint/no-non-null-assertion --
 * This module walks the config tree along paths that were just created or
 * validated in the same function (e.g. the parent object is assigned on the
 * line above), so the non-null assertions are provably safe. Consolidated here
 * rather than repeated as ~23 inline disables. */
/**
 * Configuration Sources - Load from Environment, Files, and Options
 *
 * This module handles loading configuration from different sources with clear precedence:
 * createApp Options > Environment Variables > Config File > Schema Defaults
 * (each source is merged over the one before it, so createApp options are applied last).
 */

import { AppConfig, DeepPartial } from '../../types/config.js';
import { MoroOptions } from '../../types/core.js';
import { DEFAULT_CONFIG } from './schema.js';
import { loadConfigFileSync, loadConfigFile, ConfigFileLoadError } from './file-loader.js';
import { createFrameworkLogger } from '../logger/index.js';
import { validateConfig } from './config-validator.js';

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
  applyNoColorDefault(config);
  const sourceMap = new Map<string, ConfigSourceInfo>();

  // Track default values
  trackConfigSource(config, sourceMap, 'default', 'schema');

  // 2. Load and merge config file (if exists)
  try {
    const fileConfig = loadConfigFileSync();
    if (fileConfig) {
      config = deepMerge(config, fileConfig) as AppConfig;
      trackConfigSource(fileConfig, sourceMap, 'configFile', 'moro.config.js/ts');
      logger.debug('Config file loaded and merged');
    }
  } catch (error) {
    if (error instanceof ConfigFileLoadError) throw error;
    logger.warn(`Config file loading failed, continuing without it: ${String(error)}`);
  }

  // 3. Load and merge environment variables
  const envConfig = loadEnvironmentConfig();
  config = deepMerge(config, envConfig) as AppConfig;
  trackConfigSource(envConfig, sourceMap, 'environment', 'process.env');

  // 4. Merge createApp options (highest precedence), 5. validate
  return applyCreateAppOptionsAndValidate(config, sourceMap, createAppOptions);
}

/**
 * Load configuration from all sources with proper precedence — async version.
 * Uses dynamic import() for the config file so ESM config files
 * (projects with "type":"module") are loaded correctly.
 *
 * Called by the async createApp() factory. Precedence is identical to the
 * sync version: createApp Options > Env Vars > Config File > Defaults
 */
export async function loadConfigFromAllSourcesAsync(
  createAppOptions?: MoroOptions
): Promise<AppConfig> {
  logger.debug('Loading configuration from all sources (async)');

  // 1. Start with schema defaults
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
  applyNoColorDefault(config);
  const sourceMap = new Map<string, ConfigSourceInfo>();

  trackConfigSource(config, sourceMap, 'default', 'schema');

  // 2. Load and merge config file via import() — supports both CJS and ESM
  try {
    const fileConfig = await loadConfigFile();
    if (fileConfig) {
      config = deepMerge(config, fileConfig) as AppConfig;
      trackConfigSource(fileConfig, sourceMap, 'configFile', 'moro.config.js/ts');
      logger.debug('Config file loaded and merged (async)');
    }
  } catch (error) {
    if (error instanceof ConfigFileLoadError) throw error;
    logger.warn(`Config file loading failed, continuing without it: ${String(error)}`);
  }

  // 3. Load and merge environment variables
  const envConfig = loadEnvironmentConfig();
  config = deepMerge(config, envConfig) as AppConfig;
  trackConfigSource(envConfig, sourceMap, 'environment', 'process.env');

  // 4. Merge createApp options (highest precedence), 5. validate
  return applyCreateAppOptionsAndValidate(config, sourceMap, createAppOptions);
}

/**
 * The last two steps of loading, shared by the sync and async loaders: merge
 * the createApp() options over what the defaults, the config file and the
 * environment produced, then validate the result.
 */
function applyCreateAppOptionsAndValidate(
  merged: AppConfig,
  sourceMap: Map<string, ConfigSourceInfo>,
  createAppOptions?: MoroOptions
): AppConfig {
  let config = merged;

  if (createAppOptions) {
    const normalizedOptions = normalizeCreateAppOptions(createAppOptions);
    config = deepMerge(config, normalizedOptions) as AppConfig;
    trackConfigSource(normalizedOptions, sourceMap, 'createApp', 'createApp()');
    logger.debug('createApp options merged');
  }

  config = enableCorsForConfiguredOrigin(config, sourceMap);

  const validatedConfig = validateConfig(config);

  warnUnknownKeys(config, validatedConfig, createAppOptions);

  // Log configuration sources for debugging
  logConfigurationSources(sourceMap);

  return validatedConfig;
}

/**
 * A CORS origin that was written down means CORS is wanted. When some source
 * (the config file, `security.cors` or the `cors` shorthand of createApp())
 * sets `origin` and no source sets `enabled`, CORS is switched on; an
 * `enabled` given anywhere, `false` included, is left as it is, and so is
 * `origin: false`, which asks for no CORS headers.
 */
function enableCorsForConfiguredOrigin(
  config: AppConfig,
  sourceMap: Map<string, ConfigSourceInfo>
): AppConfig {
  const origin = sourceMap.get('security.cors.origin');
  if (!origin || origin.source === 'default') return config;
  const enabled = sourceMap.get('security.cors.enabled');
  if (enabled && enabled.source !== 'default' && enabled.value !== undefined) return config;
  const cors = config.security?.cors;
  if (!cors || cors.origin === false || cors.enabled === true) return config;

  return {
    ...config,
    security: { ...config.security, cors: { ...cors, enabled: true } },
  };
}

/**
 * NO_COLOR (https://no-color.org): when present and not empty, ANSI colour is
 * off unless the user asked for it. It replaces the schema default only, so an
 * explicit `logging.enableColors` from the config file, LOG_COLORS /
 * MORO_LOG_COLORS, or createApp() is merged over it and still wins.
 */
function applyNoColorDefault(config: AppConfig): void {
  if (process.env.NO_COLOR) {
    config.logging.enableColors = false;
  }
}

/**
 * Load configuration from environment variables
 * Handles both standard and MORO_ prefixed variables
 */
function loadEnvironmentConfig(): DeepPartial<AppConfig> {
  const config: DeepPartial<AppConfig> = {};

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
      process.env.MAX_CONNECTIONS || process.env.MORO_MAX_CONNECTIONS || '0',
      10
    );
  }

  if (process.env.REQUEST_TIMEOUT || process.env.MORO_TIMEOUT) {
    if (!config.server) config.server = {} as any;
    if (!config.server!.timeouts) config.server!.timeouts = {} as any;
    // Now writes the canonical timeouts.request (timeout is its deprecated alias).
    config.server!.timeouts!.request = parseInt(
      process.env.REQUEST_TIMEOUT || process.env.MORO_TIMEOUT || '0',
      10
    );
  }

  // Additional timeout knobs (all ms).
  const setTimeoutEnv = (envName: string, key: 'idle' | 'keepAlive' | 'headers') => {
    if (process.env[envName]) {
      if (!config.server) config.server = {} as any;
      if (!config.server!.timeouts) config.server!.timeouts = {} as any;
      (config.server!.timeouts as any)[key] = parseInt(process.env[envName] as string, 10);
    }
  };
  setTimeoutEnv('MORO_IDLE_TIMEOUT', 'idle');
  setTimeoutEnv('MORO_KEEPALIVE_TIMEOUT', 'keepAlive');
  setTimeoutEnv('MORO_HEADERS_TIMEOUT', 'headers');

  if (process.env.MORO_BACKLOG) {
    if (!config.server) config.server = {} as any;
    config.server!.backlog = parseInt(process.env.MORO_BACKLOG, 10);
  }

  // Limit knobs. Size values stay as strings so the validator/parser handle
  // '16kb'-style inputs uniformly.
  const setLimitEnv = (envName: string, key: string) => {
    if (process.env[envName]) {
      if (!config.server) config.server = {} as any;
      if (!config.server!.limits) config.server!.limits = {} as any;
      (config.server!.limits as any)[key] = process.env[envName];
    }
  };
  setLimitEnv('MORO_MAX_HEADER_SIZE', 'maxHeaderSize');
  setLimitEnv('MORO_WS_MAX_MESSAGE_SIZE', 'wsMaxMessageSize');
  if (process.env.MORO_MAX_HEADERS) {
    if (!config.server) config.server = {} as any;
    if (!config.server!.limits) config.server!.limits = {} as any;
    config.server!.limits!.maxHeaders = parseInt(process.env.MORO_MAX_HEADERS, 10);
  }
  const setMultipartEnv = (envName: string, key: string, numeric: boolean) => {
    if (process.env[envName]) {
      if (!config.server) config.server = {} as any;
      if (!config.server!.limits) config.server!.limits = {} as any;
      if (!config.server!.limits!.multipart) config.server!.limits!.multipart = {} as any;
      (config.server!.limits!.multipart as any)[key] = numeric
        ? parseInt(process.env[envName] as string, 10)
        : process.env[envName];
    }
  };
  setMultipartEnv('MORO_MULTIPART_MAX_PARTS', 'maxParts', true);
  setMultipartEnv('MORO_MULTIPART_MAX_FILES', 'maxFiles', true);
  setMultipartEnv('MORO_MULTIPART_MAX_FILE_SIZE', 'maxFileSize', false);

  // SSL from env (file paths + passphrase; never fails boot — a partial set is
  // caught by the validator).
  const setSslEnv = (envName: string, key: string) => {
    if (process.env[envName]) {
      if (!config.server) config.server = {} as any;
      if (!config.server!.ssl) config.server!.ssl = {} as any;
      (config.server!.ssl as any)[key] = process.env[envName];
    }
  };
  setSslEnv('MORO_SSL_KEY_FILE', 'keyFile');
  setSslEnv('MORO_SSL_CERT_FILE', 'certFile');
  setSslEnv('MORO_SSL_CA_FILE', 'caFile');
  setSslEnv('MORO_SSL_PASSPHRASE', 'passphrase');

  if (process.env.MORO_HTTP2) {
    const v = process.env.MORO_HTTP2.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'false' || v === '0') {
      if (!config.server) config.server = {} as any;
      config.server!.http2 = v === 'true' || v === '1';
    }
  }

  if (process.env.MORO_SERVER_ENGINE) {
    // Normalize and whitelist like the other env enums (LOG_LEVEL etc.):
    // engine selection must never fail the boot, so an invalid value is
    // ignored rather than being handed to the validator to throw on.
    // Legacy 'auto'/'native' values map to 'moro'. 'uws' (uWebSockets.js,
    // removed in 1.8.24) is passed on: the framework runs it on the Moro
    // engine with a warning instead of ignoring the variable silently.
    const rawEngine = process.env.MORO_SERVER_ENGINE.trim().toLowerCase();
    const engineValue =
      rawEngine === 'auto' || rawEngine === 'native'
        ? 'moro'
        : rawEngine === 'moro' || rawEngine === 'node' || rawEngine === 'uws'
          ? rawEngine
          : undefined;
    if (engineValue) {
      if (!config.server) config.server = {} as any;
      config.server!.engine = engineValue;
    }
  }

  // Database configuration
  const databaseUrl = process.env.DATABASE_URL || process.env.MORO_DATABASE_URL;
  if (databaseUrl) {
    if (!config.database) config.database = {} as any;
    config.database!.url = databaseUrl;
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
  const ensureLoggingBlock = (): NonNullable<DeepPartial<AppConfig>['logging']> => {
    if (!config.logging) config.logging = {} as any;
    return config.logging!;
  };

  // Parses common boolean-ish env strings; returns undefined if not set so we
  // never accidentally clobber a default with `false`.
  const parseBoolEnv = (raw: string | undefined): boolean | undefined => {
    if (raw === undefined) return undefined;
    const v = raw.trim().toLowerCase();
    if (v === '') return undefined;
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
    return undefined;
  };

  if (process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL) {
    const level = process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL;
    if (
      level === 'debug' ||
      level === 'info' ||
      level === 'warn' ||
      level === 'error' ||
      level === 'fatal'
    ) {
      ensureLoggingBlock().level = level;
    }
  }

  if (process.env.LOG_FORMAT || process.env.MORO_LOG_FORMAT) {
    const fmt = (process.env.LOG_FORMAT || process.env.MORO_LOG_FORMAT) as
      'pretty' | 'json' | 'compact';
    if (fmt === 'pretty' || fmt === 'json' || fmt === 'compact') {
      ensureLoggingBlock().format = fmt;
    }
  }

  const colorsEnv = parseBoolEnv(process.env.LOG_COLORS ?? process.env.MORO_LOG_COLORS);
  if (colorsEnv !== undefined) {
    ensureLoggingBlock().enableColors = colorsEnv;
  }

  const timestampEnv = parseBoolEnv(process.env.LOG_TIMESTAMP ?? process.env.MORO_LOG_TIMESTAMP);
  if (timestampEnv !== undefined) {
    ensureLoggingBlock().enableTimestamp = timestampEnv;
  }

  const contextEnv = parseBoolEnv(process.env.LOG_CONTEXT ?? process.env.MORO_LOG_CONTEXT);
  if (contextEnv !== undefined) {
    ensureLoggingBlock().enableContext = contextEnv;
  }

  // Opt-in: appends "{...}" JSON tail to pretty log lines.
  const metadataEnv = parseBoolEnv(process.env.LOG_METADATA ?? process.env.MORO_LOG_METADATA);
  if (metadataEnv !== undefined) {
    ensureLoggingBlock().enableMetadata = metadataEnv;
  }

  // Opt-in: collects/renders memory + duration on each log line.
  const perfEnv = parseBoolEnv(process.env.LOG_PERFORMANCE ?? process.env.MORO_LOG_PERFORMANCE);
  if (perfEnv !== undefined) {
    ensureLoggingBlock().enablePerformance = perfEnv;
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

  // Module configuration
  const moduleEnvVars = [
    // Cache
    'CACHE_ENABLED',
    'MORO_CACHE_ENABLED',
    'DEFAULT_CACHE_TTL',
    'MORO_CACHE_TTL',
    'CACHE_MAX_SIZE',
    'MORO_CACHE_SIZE',
    'CACHE_STRATEGY',
    'MORO_CACHE_STRATEGY',
    // Rate Limit
    'RATE_LIMIT_ENABLED',
    'MORO_RATE_LIMIT_ENABLED',
    'DEFAULT_RATE_LIMIT_REQUESTS',
    'MORO_RATE_LIMIT_REQUESTS',
    'DEFAULT_RATE_LIMIT_WINDOW',
    'MORO_RATE_LIMIT_WINDOW',
    // Validation
    'VALIDATION_ENABLED',
    'MORO_VALIDATION_ENABLED',
    // Auto-Discovery
    'AUTO_DISCOVERY_ENABLED',
    'MORO_AUTO_DISCOVERY_ENABLED',
    'AUTO_DISCOVERY_PATHS',
    'MORO_AUTO_DISCOVERY_PATHS',
    'AUTO_DISCOVERY_PATTERNS',
    'MORO_AUTO_DISCOVERY_PATTERNS',
    'AUTO_DISCOVERY_LOADING_STRATEGY',
    'MORO_AUTO_DISCOVERY_LOADING_STRATEGY',
    'AUTO_DISCOVERY_WATCH_FOR_CHANGES',
    'MORO_AUTO_DISCOVERY_WATCH_FOR_CHANGES',
    'AUTO_DISCOVERY_LOAD_ORDER',
    'MORO_AUTO_DISCOVERY_LOAD_ORDER',
    'AUTO_DISCOVERY_FAIL_ON_ERROR',
    'MORO_AUTO_DISCOVERY_FAIL_ON_ERROR',
    'AUTO_DISCOVERY_MAX_DEPTH',
    'MORO_AUTO_DISCOVERY_MAX_DEPTH',
  ];

  if (moduleEnvVars.some(envVar => process.env[envVar])) {
    if (!config.modules) config.modules = {} as any;

    // Cache configuration
    if (process.env.CACHE_ENABLED || process.env.MORO_CACHE_ENABLED) {
      if (!config.modules!.cache) config.modules!.cache = {} as any;
      config.modules!.cache!.enabled =
        (process.env.CACHE_ENABLED || process.env.MORO_CACHE_ENABLED) === 'true';
    }
    if (process.env.DEFAULT_CACHE_TTL || process.env.MORO_CACHE_TTL) {
      if (!config.modules!.cache) config.modules!.cache = {} as any;
      config.modules!.cache!.defaultTtl = parseInt(
        process.env.DEFAULT_CACHE_TTL || process.env.MORO_CACHE_TTL || '300',
        10
      );
    }
    if (process.env.CACHE_MAX_SIZE || process.env.MORO_CACHE_SIZE) {
      if (!config.modules!.cache) config.modules!.cache = {} as any;
      config.modules!.cache!.maxSize = parseInt(
        process.env.CACHE_MAX_SIZE || process.env.MORO_CACHE_SIZE || '1000',
        10
      );
    }
    if (process.env.CACHE_STRATEGY || process.env.MORO_CACHE_STRATEGY) {
      if (!config.modules!.cache) config.modules!.cache = {} as any;
      const strategy = process.env.CACHE_STRATEGY || process.env.MORO_CACHE_STRATEGY;
      if (['lru', 'lfu', 'fifo'].includes(strategy || '')) {
        config.modules!.cache!.strategy = strategy as 'lru' | 'lfu' | 'fifo';
      }
    }

    // Rate limit configuration
    if (process.env.RATE_LIMIT_ENABLED || process.env.MORO_RATE_LIMIT_ENABLED) {
      if (!config.modules!.rateLimit) config.modules!.rateLimit = {} as any;
      config.modules!.rateLimit!.enabled =
        (process.env.RATE_LIMIT_ENABLED || process.env.MORO_RATE_LIMIT_ENABLED) === 'true';
    }
    if (process.env.DEFAULT_RATE_LIMIT_REQUESTS || process.env.MORO_RATE_LIMIT_REQUESTS) {
      if (!config.modules!.rateLimit) config.modules!.rateLimit = {} as any;
      config.modules!.rateLimit!.defaultRequests = parseInt(
        process.env.DEFAULT_RATE_LIMIT_REQUESTS || process.env.MORO_RATE_LIMIT_REQUESTS || '100',
        10
      );
    }
    if (process.env.DEFAULT_RATE_LIMIT_WINDOW || process.env.MORO_RATE_LIMIT_WINDOW) {
      if (!config.modules!.rateLimit) config.modules!.rateLimit = {} as any;
      config.modules!.rateLimit!.defaultWindow = parseInt(
        process.env.DEFAULT_RATE_LIMIT_WINDOW || process.env.MORO_RATE_LIMIT_WINDOW || '60000',
        10
      );
    }

    // Validation configuration
    if (process.env.VALIDATION_ENABLED || process.env.MORO_VALIDATION_ENABLED) {
      if (!config.modules!.validation) config.modules!.validation = {} as any;
      config.modules!.validation!.enabled =
        (process.env.VALIDATION_ENABLED || process.env.MORO_VALIDATION_ENABLED) === 'true';
    }

    // Auto-Discovery configuration
    if (process.env.AUTO_DISCOVERY_ENABLED || process.env.MORO_AUTO_DISCOVERY_ENABLED) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      config.modules!.autoDiscovery!.enabled =
        (process.env.AUTO_DISCOVERY_ENABLED || process.env.MORO_AUTO_DISCOVERY_ENABLED) === 'true';
    }
    if (process.env.AUTO_DISCOVERY_PATHS || process.env.MORO_AUTO_DISCOVERY_PATHS) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      const paths = (
        process.env.AUTO_DISCOVERY_PATHS ||
        process.env.MORO_AUTO_DISCOVERY_PATHS ||
        ''
      )
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
      if (paths.length > 0) {
        config.modules!.autoDiscovery!.paths = paths;
      }
    }
    if (process.env.AUTO_DISCOVERY_PATTERNS || process.env.MORO_AUTO_DISCOVERY_PATTERNS) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      const patterns = (
        process.env.AUTO_DISCOVERY_PATTERNS ||
        process.env.MORO_AUTO_DISCOVERY_PATTERNS ||
        ''
      )
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
      if (patterns.length > 0) {
        config.modules!.autoDiscovery!.patterns = patterns;
      }
    }
    if (
      process.env.AUTO_DISCOVERY_LOADING_STRATEGY ||
      process.env.MORO_AUTO_DISCOVERY_LOADING_STRATEGY
    ) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      const strategy =
        process.env.AUTO_DISCOVERY_LOADING_STRATEGY ||
        process.env.MORO_AUTO_DISCOVERY_LOADING_STRATEGY;
      if (['eager', 'lazy', 'conditional'].includes(strategy || '')) {
        config.modules!.autoDiscovery!.loadingStrategy = strategy as
          'eager' | 'lazy' | 'conditional';
      }
    }
    if (
      process.env.AUTO_DISCOVERY_WATCH_FOR_CHANGES ||
      process.env.MORO_AUTO_DISCOVERY_WATCH_FOR_CHANGES
    ) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      config.modules!.autoDiscovery!.watchForChanges =
        (process.env.AUTO_DISCOVERY_WATCH_FOR_CHANGES ||
          process.env.MORO_AUTO_DISCOVERY_WATCH_FOR_CHANGES) === 'true';
    }
    if (process.env.AUTO_DISCOVERY_LOAD_ORDER || process.env.MORO_AUTO_DISCOVERY_LOAD_ORDER) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      const loadOrder =
        process.env.AUTO_DISCOVERY_LOAD_ORDER || process.env.MORO_AUTO_DISCOVERY_LOAD_ORDER;
      if (['alphabetical', 'dependency', 'custom'].includes(loadOrder || '')) {
        config.modules!.autoDiscovery!.loadOrder = loadOrder as
          'alphabetical' | 'dependency' | 'custom';
      }
    }
    if (process.env.AUTO_DISCOVERY_FAIL_ON_ERROR || process.env.MORO_AUTO_DISCOVERY_FAIL_ON_ERROR) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      config.modules!.autoDiscovery!.failOnError =
        (process.env.AUTO_DISCOVERY_FAIL_ON_ERROR ||
          process.env.MORO_AUTO_DISCOVERY_FAIL_ON_ERROR) === 'true';
    }
    if (process.env.AUTO_DISCOVERY_MAX_DEPTH || process.env.MORO_AUTO_DISCOVERY_MAX_DEPTH) {
      if (!config.modules!.autoDiscovery) config.modules!.autoDiscovery = {} as any;
      config.modules!.autoDiscovery!.maxDepth = parseInt(
        process.env.AUTO_DISCOVERY_MAX_DEPTH || process.env.MORO_AUTO_DISCOVERY_MAX_DEPTH || '5',
        10
      );
    }
  }

  // File-based auto routing (config.routing). MORO_ROUTING=false disables it;
  // MORO_ROUTING_PATHS is a comma-separated list of directories to scan.
  const routingEnabled = parseBoolEnv(process.env.MORO_ROUTING ?? process.env.MORO_AUTO_ROUTING);
  const routingPaths = (process.env.MORO_ROUTING_PATHS || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (routingEnabled !== undefined || routingPaths.length > 0) {
    config.routing = {
      enabled: routingEnabled ?? true,
      ...(routingPaths.length > 0 ? { paths: routingPaths } : {}),
    };
  }
  // MORO_ROUTING_STRICT_MIDDLEWARE sets routing.strictMiddleware
  const routingStrict = parseBoolEnv(process.env.MORO_ROUTING_STRICT_MIDDLEWARE);
  if (routingStrict !== undefined) {
    const routing = typeof config.routing === 'object' ? config.routing : {};
    config.routing = { ...routing, strictMiddleware: routingStrict };
  }

  return config;
}

/**
 * What a createApp() shorthand contributes to its section: `{ enabled }` for
 * the boolean form, the object's own keys for the object form.
 */
function shorthandKeys(value: boolean | object): Record<string, unknown> {
  return typeof value === 'boolean' ? { enabled: value } : { ...value };
}

/**
 * Normalize createApp options to match AppConfig structure
 * This handles the flexible createApp API while converting to structured config
 */
function normalizeCreateAppOptions(options: MoroOptions): DeepPartial<AppConfig> {
  const config: DeepPartial<AppConfig> = {};

  // Direct config section overrides - merge with existing config
  if (options.server) {
    config.server = { ...config.server, ...options.server } as any;
  }

  // options.https is the node-style alias for server.ssl; options.http2 the
  // top-level HTTP/2 switch. Fold both into server config (only when the
  // canonical server field isn't already set) so a config file / env can also
  // drive them and everything flows through one validated shape. framework.ts
  // still reads options.https/options.http2 directly at highest precedence for
  // back-compat — they arrive identical after this.
  if ((options as any).https && !(options.server as any)?.ssl) {
    config.server = { ...(config.server as any), ssl: (options as any).https } as any;
  }
  if ((options as any).http2 !== undefined && (options.server as any)?.http2 === undefined) {
    config.server = { ...(config.server as any), http2: (options as any).http2 } as any;
  }
  if (options.database) {
    config.database = { ...config.database, ...options.database } as any;
  }
  if (options.modules) {
    config.modules = { ...config.modules, ...options.modules } as any;
  }

  // Shorthands (autoDiscover, validation, modulesPath here; cors, compression
  // and helmet below). A shorthand sets only what it names: `true` / `false`
  // is `{ enabled }`, an object is its own keys. Everything else in the
  // section keeps the value the config file, the environment or the schema
  // default gave it, because this object is merged over those key by key.
  // Within createApp() itself a shorthand is applied over the long form
  // (`cors` over `security.cors`), key by key as well.

  // autoDiscover maps to modules.autoDiscovery
  if (options.autoDiscover !== undefined) {
    config.modules = {
      ...config.modules,
      autoDiscovery: {
        ...(config.modules as any)?.autoDiscovery,
        ...shorthandKeys(options.autoDiscover),
      },
    } as any;
  }

  // validation maps to modules.validation
  if (options.validation !== undefined) {
    config.modules = {
      ...config.modules,
      validation: {
        ...(config.modules as any)?.validation,
        ...options.validation,
      },
    } as any;
  }

  // Legacy modulesPath maps to modules.autoDiscovery.paths and switches
  // discovery on
  if (options.modulesPath) {
    config.modules = {
      ...config.modules,
      autoDiscovery: {
        ...(config.modules as any)?.autoDiscovery,
        enabled: true,
        paths: [options.modulesPath],
      },
    } as any;
  }
  // Handle both 'logger' and 'logging' options (logger is an alias)
  if (options.logging) {
    config.logging = { ...config.logging, ...options.logging } as any;
  }
  if ((options as any).logger) {
    config.logging = { ...config.logging, ...(options as any).logger } as any;
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
  if (options.jobs) {
    config.jobs = deepMerge(config.jobs || {}, options.jobs) as any;
  }
  // routing: true / false, or { enabled, paths, strictMiddleware }
  if (options.routing !== undefined) {
    config.routing = options.routing as any;
  }

  // cors, compression, helmet: see the shorthand rule above
  if (options.cors !== undefined) {
    config.security = {
      ...config.security,
      cors: { ...(config.security as any)?.cors, ...shorthandKeys(options.cors) },
    } as any;
  }

  if (options.compression !== undefined) {
    config.performance = {
      ...config.performance,
      compression: {
        ...(config.performance as any)?.compression,
        ...shorthandKeys(options.compression),
      },
    } as any;
  }

  if (options.helmet !== undefined) {
    config.security = {
      ...config.security,
      helmet: { ...(config.security as any)?.helmet, ...shorthandKeys(options.helmet) },
    } as any;
  }

  return config;
}

/**
 * Check if a config field contains sensitive information
 */
// Cache sensitive patterns as a Set for O(1) lookups
const SENSITIVE_PATTERNS = new Set([
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
  'passphrase',
  'dsn',
  'connectionstring',
  'credential',
  'pfx',
]);

function isSensitiveField(path: string): boolean {
  const lowerPath = path.toLowerCase();

  // Fast path: direct lookup for exact matches
  if (SENSITIVE_PATTERNS.has(lowerPath)) {
    return true;
  }

  // Check if any pattern is included in the path
  for (const pattern of SENSITIVE_PATTERNS) {
    if (lowerPath.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Mask the userinfo part (`user:password@`) of a URL-shaped string, keeping the
 * scheme and host visible: `postgres://app:pw@db.internal/prod` becomes
 * `postgres://***@db.internal/prod`. Other strings are returned unchanged.
 *
 * Everything between `scheme://` and the last `@` before the query string is
 * replaced, so a password containing unencoded `@`, `/` or `#` is still fully
 * covered.
 */
function maskUrlUserinfo(value: string): string {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (!scheme) return value;

  const start = scheme[0].length;
  const queryAt = value.indexOf('?', start);
  const head = queryAt === -1 ? value : value.slice(0, queryAt);

  let at = head.lastIndexOf('@');
  if (at < start) {
    // No '@' before the query string. A plain host[:port] has no credentials;
    // anything else may be credentials with an unencoded '?', so fall back to
    // the last '@' anywhere in the value.
    const authority = head.slice(start).split(/[/#]/, 1)[0] ?? '';
    if (/^(\[[0-9a-f:.]*\]|[^:@]*)(:\d*)?$/i.test(authority)) return value;
    at = value.lastIndexOf('@');
    if (at < start) return value;
  }

  return `${value.slice(0, start)}***@${value.slice(at + 1)}`;
}

/**
 * Mask secrets inside a structured config value (arrays are logged as one
 * leaf): sensitive keys are replaced and URL credentials are masked.
 */
function maskConfigValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskUrlUserinfo(value);
  if (value === null || typeof value !== 'object') return value;
  // A Buffer, a client, any class instance: named, never walked or printed.
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return `[${(value as object).constructor?.name || 'Object'}]`;
  }
  if (depth >= 8) return '[Object]';

  if (Array.isArray(value)) {
    return value.map(item => maskConfigValue(item, depth + 1));
  }

  const masked: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    masked[key] = isSensitiveField(key) ? '***' : maskConfigValue(item, depth + 1);
  }
  return masked;
}

/**
 * Render one configuration value for the debug dump. Values at sensitive
 * paths are never printed, in any environment.
 */
function formatConfigValueForLog(path: string, value: unknown): string {
  if (isSensitiveField(path)) return '***';

  const masked = maskConfigValue(value);
  return typeof masked === 'object' ? JSON.stringify(masked) : String(masked);
}

/**
 * A configuration tree is made of plain objects. Anything else found in it (a
 * Buffer, a Redis client, a class instance of any kind) is a value: it is
 * neither merged key by key nor walked.
 */
function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Far deeper than any configuration section; ends a walk over self-referring data. */
const MAX_CONFIG_DEPTH = 16;

/**
 * Deep merge two configuration objects
 * Later object properties override earlier ones
 */
function deepMerge<T extends Record<string, any>>(target: T, source: DeepPartial<T>, depth = 0): T {
  const result = { ...target };

  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const sourceValue = source[key];
    const targetValue = result[key];

    if (isPlainObject(sourceValue) && isPlainObject(targetValue) && depth < MAX_CONFIG_DEPTH) {
      result[key] = deepMerge(targetValue, sourceValue as any, depth + 1);
    } else if (
      depth === 0 &&
      key === 'routing' &&
      typeof targetValue === 'boolean' &&
      isPlainObject(sourceValue) &&
      (sourceValue as { enabled?: unknown }).enabled === undefined
    ) {
      // routing is a boolean or an object. A later source that sets one of the
      // object's keys without saying `enabled` (MORO_ROUTING_STRICT_MIDDLEWARE
      // alone, for one) must not switch back on what `routing: false` in an
      // earlier source switched off.
      result[key] = { enabled: targetValue, ...(sourceValue as object) } as any;
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as any;
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
  const ancestors = new Set<object>();

  function traverse(obj: any, currentPath: string, depth: number): void {
    ancestors.add(obj);
    for (const key in obj) {
      const value = obj[key];
      const fullPath = currentPath ? `${currentPath}.${key}` : key;

      if (isPlainObject(value) && depth < MAX_CONFIG_DEPTH && !ancestors.has(value)) {
        traverse(value, fullPath, depth + 1);
      } else {
        sourceMap.set(fullPath, { source, path, value });
      }
    }
    ancestors.delete(obj);
  }

  traverse(config, '', 0);
}

/**
 * Parts of the configuration whose keys are not fixed, or that are reported
 * elsewhere. Nothing below one of these paths is called unknown.
 */
const OPEN_CONFIG_PATHS = new Set([
  'server.ssl', // has its own report of keys that are not applied
  'modules.session.storeOptions',
  'modules.session.cookie',
  'security.helmet.contentSecurityPolicy',
  'security.helmet.strictTransportSecurity',
  'security.csp.directives',
  'performance.compression.gzip',
  'performance.compression.brotli',
  'logging.outputs.webhook.headers',
  'websocket.options',
  'queue',
]);

/**
 * createApp() options whose own value is also read directly by the framework
 * (not only through the validated configuration), with the section each one
 * is copied into. A key written there is in use even when the validator does
 * not carry it.
 */
const DIRECTLY_READ_OPTIONS: ReadonlyArray<readonly [option: string, section: string]> = [
  ['logger', 'logging'],
  ['cors', 'security.cors'],
  ['helmet', 'security.helmet'],
  ['compression', 'performance.compression'],
  ['autoDiscover', 'modules.autoDiscovery'],
  ['validation', 'modules.validation'],
  ['http2', 'server.http2'],
  ['https', 'server.ssl'],
];

/**
 * Keys that were given inside a known configuration section and are missing
 * from the validated result: the validator does not know them, so nothing
 * that reads the configuration ever sees them (`server.prot`,
 * `security.cors.orgin`).
 */
function findUnknownKeys(given: any, validated: any, open: ReadonlySet<string>): string[] {
  const unknown: string[] = [];

  const compare = (input: any, output: any, path: string, depth: number): void => {
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (value === undefined) continue;
      const fullPath = `${path}.${key}`;
      if (open.has(fullPath)) continue;
      // Directly under `modules`, an unknown key is a module's own config.
      if (path === 'modules' && !(key in output)) continue;

      const kept = output[key];
      if (kept === undefined) {
        unknown.push(fullPath);
      } else if (
        kept !== value &&
        isPlainObject(value) &&
        isPlainObject(kept) &&
        depth < MAX_CONFIG_DEPTH
      ) {
        // The same object on both sides was passed through whole: free-form.
        compare(value, kept, fullPath, depth + 1);
      }
    }
  };

  for (const section of Object.keys(validated)) {
    if (open.has(section)) continue;
    if (isPlainObject(given?.[section]) && isPlainObject(validated[section])) {
      compare(given[section], validated[section], section, 1);
    }
  }

  return unknown;
}

function warnUnknownKeys(given: AppConfig, validated: AppConfig, options?: MoroOptions): void {
  const open = new Set(OPEN_CONFIG_PATHS);
  for (const [option, section] of DIRECTLY_READ_OPTIONS) {
    const value = (options as any)?.[option];
    if (value !== null && typeof value === 'object') open.add(section);
  }

  const unknown = findUnknownKeys(given, validated, open);
  if (unknown.length === 0) return;

  logger.warn(
    `Unknown configuration ${unknown.length === 1 ? 'key is' : 'keys are'} ignored: ` +
      `${unknown.join(', ')}. Nothing reads ${unknown.length === 1 ? 'it' : 'them'}; ` +
      'check the spelling against the configuration reference.'
  );
}

/**
 * Log configuration sources for debugging
 */
function logConfigurationSources(sourceMap: Map<string, ConfigSourceInfo>): void {
  const allSources = Array.from(sourceMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const nonDefaultSources = allSources.filter(([_, info]) => info.source !== 'default');

  // Sensitive values are masked in every environment: debug logging is common
  // in staging and test, and those logs are shipped and shared like any other.
  if (process.env.NODE_ENV === 'production') {
    // In production, only show non-default values
    if (nonDefaultSources.length > 0) {
      logger.debug(`Configuration overrides loaded (${nonDefaultSources.length} total)`);

      nonDefaultSources.forEach(([path, info]) => {
        const valueStr = formatConfigValueForLog(path, info.value);
        logger.debug(`  ${path}: ${valueStr} (from ${info.source})`);
      });
    } else {
      logger.debug('Using default configuration (no overrides)');
    }
  } else {
    // In development, show all sources for debugging
    logger.debug(`Configuration sources loaded (${allSources.length} total)`);

    allSources.forEach(([path, info]) => {
      const valueStr = formatConfigValueForLog(path, info.value);
      logger.debug(`  ${path}: ${valueStr} (from ${info.source})`);
    });
  }
}
