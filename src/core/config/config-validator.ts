/**
 * Configuration Validator - Type-Safe Schema Validation
 *
 * This module provides runtime validation for configuration objects using
 * simple TypeScript functions that match the type definitions exactly.
 */

import { AppConfig } from '../../types/config.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('ConfigValidator');

/**
 * Configuration validation error with detailed context
 */
export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly expectedType: string,
    message: string
  ) {
    super(`Configuration validation failed for '${field}': ${message}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate and normalize a complete configuration object
 * This ensures type safety and provides helpful error messages
 */
export function validateConfig(config: any): AppConfig {
  logger.debug('Validating configuration');

  try {
    const validatedConfig: AppConfig = {
      server: validateServerConfig(config.server, 'server'),
      serviceDiscovery: validateServiceDiscoveryConfig(config.serviceDiscovery, 'serviceDiscovery'),
      database: validateDatabaseConfig(config.database, 'database'),
      modules: validateModuleDefaultsConfig(config.modules, 'modules'),
      logging: validateLoggingConfig(config.logging, 'logging'),
      security: validateSecurityConfig(config.security, 'security'),
      external: validateExternalServicesConfig(config.external, 'external'),
      performance: validatePerformanceConfig(config.performance, 'performance'),
      websocket: validateWebSocketConfig(config.websocket, 'websocket'),
      queue: validateQueueConfig(config.queue, 'queue'),
    };

    logger.debug('Configuration validation successful');
    return validatedConfig;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      logger.error(`❌ Configuration validation failed for '${error.field}':`, error.message);

      // Provide helpful hints
      provideValidationHints(error);

      throw error;
    }

    logger.error('❌ Unexpected configuration validation error:', String(error));
    throw new Error(`Configuration validation failed: ${String(error)}`);
  }
}

/**
 * Validate server configuration
 */
function validateServerConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Server configuration must be an object'
    );
  }

  const result: any = {
    port: validatePort(config.port, `${path}.port`),
    host: validateString(config.host, `${path}.host`),
    maxConnections: validateNumber(config.maxConnections, `${path}.maxConnections`, { min: 1 }),
    timeout: validateNumber(config.timeout, `${path}.timeout`, { min: 1000 }),
    bodySizeLimit: validateString(config.bodySizeLimit, `${path}.bodySizeLimit`),
    maxUploadSize: validateString(config.maxUploadSize, `${path}.maxUploadSize`),
    requestTracking: {
      enabled: validateBoolean(config.requestTracking?.enabled, `${path}.requestTracking.enabled`),
    },
    requestLogging: {
      enabled: validateBoolean(config.requestLogging?.enabled, `${path}.requestLogging.enabled`),
    },
    errorBoundary: {
      enabled: validateBoolean(config.errorBoundary?.enabled, `${path}.errorBoundary.enabled`),
    },
  };

  // Optional uWebSockets configuration
  if (config.useUWebSockets !== undefined) {
    result.useUWebSockets = validateBoolean(config.useUWebSockets, `${path}.useUWebSockets`);
  }

  // Optional SSL configuration
  if (config.ssl !== undefined) {
    result.ssl = validateSSLConfig(config.ssl, `${path}.ssl`);
  }

  return result;
}

/**
 * Validate SSL configuration
 */
function validateSSLConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(path, config, 'object', 'SSL configuration must be an object');
  }

  const result: any = {};

  if (config.key_file_name !== undefined) {
    result.key_file_name = validateString(config.key_file_name, `${path}.key_file_name`);
  }
  if (config.cert_file_name !== undefined) {
    result.cert_file_name = validateString(config.cert_file_name, `${path}.cert_file_name`);
  }
  if (config.passphrase !== undefined) {
    result.passphrase = validateString(config.passphrase, `${path}.passphrase`);
  }

  return result;
}

/**
 * Validate service discovery configuration
 */
function validateServiceDiscoveryConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Service discovery configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    type: validateEnum(config.type, ['memory', 'consul', 'kubernetes'], `${path}.type`),
    consulUrl: validateString(config.consulUrl, `${path}.consulUrl`),
    kubernetesNamespace: validateString(config.kubernetesNamespace, `${path}.kubernetesNamespace`),
    healthCheckInterval: validateNumber(config.healthCheckInterval, `${path}.healthCheckInterval`, {
      min: 1000,
    }),
    retryAttempts: validateNumber(config.retryAttempts, `${path}.retryAttempts`, { min: 0 }),
  };
}

/**
 * Validate database configuration
 */
function validateDatabaseConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Database configuration must be an object'
    );
  }

  const result: any = {};

  // Optional URL
  if (config.url !== undefined) {
    result.url = validateString(config.url, `${path}.url`);
  }

  // Optional Redis - only validate if present
  if (config.redis !== undefined) {
    result.redis = validateRedisConfig(config.redis, `${path}.redis`);
  }

  // Optional MySQL - only validate if present
  if (config.mysql !== undefined) {
    result.mysql = validateMySQLConfig(config.mysql, `${path}.mysql`);
  }

  // Optional PostgreSQL - only validate if present
  if (config.postgresql !== undefined) {
    result.postgresql = validatePostgreSQLConfig(config.postgresql, `${path}.postgresql`);
  }

  // Optional SQLite - only validate if present
  if (config.sqlite !== undefined) {
    result.sqlite = validateSQLiteConfig(config.sqlite, `${path}.sqlite`);
  }

  // Optional MongoDB - only validate if present
  if (config.mongodb !== undefined) {
    result.mongodb = validateMongoDBConfig(config.mongodb, `${path}.mongodb`);
  }

  return result;
}

/**
 * Validate Redis configuration
 */
function validateRedisConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Redis configuration must be an object'
    );
  }

  return {
    url: validateString(config.url, `${path}.url`),
    maxRetries: validateNumber(config.maxRetries, `${path}.maxRetries`, { min: 0 }),
    retryDelay: validateNumber(config.retryDelay, `${path}.retryDelay`, { min: 0 }),
    keyPrefix: validateString(config.keyPrefix, `${path}.keyPrefix`),
  };
}

/**
 * Validate MySQL configuration
 */
function validateMySQLConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'MySQL configuration must be an object'
    );
  }

  const result: any = {
    host: validateString(config.host, `${path}.host`),
    port: validatePort(config.port, `${path}.port`),
    connectionLimit: validateNumber(config.connectionLimit, `${path}.connectionLimit`, { min: 1 }),
    acquireTimeout: validateNumber(config.acquireTimeout, `${path}.acquireTimeout`, { min: 1000 }),
    timeout: validateNumber(config.timeout, `${path}.timeout`, { min: 1000 }),
  };

  // Optional fields
  if (config.database !== undefined) {
    result.database = validateString(config.database, `${path}.database`);
  }
  if (config.username !== undefined) {
    result.username = validateString(config.username, `${path}.username`);
  }
  if (config.password !== undefined) {
    result.password = validateString(config.password, `${path}.password`);
  }

  return result;
}

/**
 * Validate PostgreSQL configuration
 */
function validatePostgreSQLConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'PostgreSQL configuration must be an object'
    );
  }

  const result: any = {
    host: validateString(config.host, `${path}.host`),
    port: validatePort(config.port, `${path}.port`),
    connectionLimit: validateNumber(config.connectionLimit, `${path}.connectionLimit`, { min: 1 }),
  };

  // Optional fields
  if (config.database !== undefined) {
    result.database = validateString(config.database, `${path}.database`);
  }
  if (config.user !== undefined) {
    result.user = validateString(config.user, `${path}.user`);
  }
  if (config.password !== undefined) {
    result.password = validateString(config.password, `${path}.password`);
  }
  if (config.ssl !== undefined) {
    result.ssl = validateBoolean(config.ssl, `${path}.ssl`);
  }

  return result;
}

/**
 * Validate SQLite configuration
 */
function validateSQLiteConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'SQLite configuration must be an object'
    );
  }

  const result: any = {
    filename: validateString(config.filename, `${path}.filename`),
  };

  // Optional fields
  if (config.memory !== undefined) {
    result.memory = validateBoolean(config.memory, `${path}.memory`);
  }
  if (config.verbose !== undefined) {
    result.verbose = validateBoolean(config.verbose, `${path}.verbose`);
  }

  return result;
}

/**
 * Validate MongoDB configuration
 */
function validateMongoDBConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'MongoDB configuration must be an object'
    );
  }

  const result: any = {};

  // Either url or host+port
  if (config.url !== undefined) {
    result.url = validateString(config.url, `${path}.url`);
  }
  if (config.host !== undefined) {
    result.host = validateString(config.host, `${path}.host`);
  }
  if (config.port !== undefined) {
    result.port = validatePort(config.port, `${path}.port`);
  }
  if (config.database !== undefined) {
    result.database = validateString(config.database, `${path}.database`);
  }
  if (config.username !== undefined) {
    result.username = validateString(config.username, `${path}.username`);
  }
  if (config.password !== undefined) {
    result.password = validateString(config.password, `${path}.password`);
  }

  return result;
}

/**
 * Validate module defaults configuration
 */
function validateModuleDefaultsConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Module defaults configuration must be an object'
    );
  }

  const validated: any = {
    cache: validateCacheConfig(config.cache, `${path}.cache`),
    rateLimit: validateRateLimitConfig(config.rateLimit, `${path}.rateLimit`),
    validation: validateValidationConfig(config.validation, `${path}.validation`),
    autoDiscovery: validateAutoDiscoveryConfig(config.autoDiscovery, `${path}.autoDiscovery`),
  };

  // Optional session config
  if (config.session !== undefined) {
    validated.session = validateSessionConfig(config.session, `${path}.session`);
  }

  return validated;
}

/**
 * Validate auto-discovery configuration
 */
function validateAutoDiscoveryConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Auto-discovery configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    paths: validateStringArray(config.paths, `${path}.paths`),
    patterns: validateStringArray(config.patterns, `${path}.patterns`),
    recursive: validateBoolean(config.recursive, `${path}.recursive`),
    loadingStrategy: validateEnum(
      config.loadingStrategy,
      ['eager', 'lazy', 'conditional'],
      `${path}.loadingStrategy`
    ),
    watchForChanges: validateBoolean(config.watchForChanges, `${path}.watchForChanges`),
    ignorePatterns: validateStringArray(config.ignorePatterns, `${path}.ignorePatterns`),
    loadOrder: validateEnum(
      config.loadOrder,
      ['alphabetical', 'dependency', 'custom'],
      `${path}.loadOrder`
    ),
    failOnError: validateBoolean(config.failOnError, `${path}.failOnError`),
    maxDepth: validateNumber(config.maxDepth, `${path}.maxDepth`),
  };
}

/**
 * Validate cache configuration
 */
function validateCacheConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Cache configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    defaultTtl: validateNumber(config.defaultTtl, `${path}.defaultTtl`, { min: 0 }),
    maxSize: validateNumber(config.maxSize, `${path}.maxSize`, { min: 1 }),
    strategy: validateEnum(config.strategy, ['lru', 'lfu', 'fifo'], `${path}.strategy`),
  };
}

/**
 * Validate rate limit configuration
 */
function validateRateLimitConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Rate limit configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    defaultRequests: validateNumber(config.defaultRequests, `${path}.defaultRequests`, { min: 1 }),
    defaultWindow: validateNumber(config.defaultWindow, `${path}.defaultWindow`, { min: 1000 }),
    skipSuccessfulRequests: validateBoolean(
      config.skipSuccessfulRequests,
      `${path}.skipSuccessfulRequests`
    ),
    skipFailedRequests: validateBoolean(config.skipFailedRequests, `${path}.skipFailedRequests`),
  };
}

/**
 * Validate validation configuration
 */
function validateValidationConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Validation configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    stripUnknown: validateBoolean(config.stripUnknown, `${path}.stripUnknown`),
    abortEarly: validateBoolean(config.abortEarly, `${path}.abortEarly`),
  };
}

/**
 * Validate session configuration
 */
function validateSessionConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Session configuration must be an object'
    );
  }

  const validated: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    store: validateEnum(config.store, ['memory', 'redis', 'file'], `${path}.store`),
  };

  // Optional fields
  if (config.storeOptions !== undefined) {
    validated.storeOptions = config.storeOptions; // Complex object, allow through
  }
  if (config.secret !== undefined) {
    validated.secret = validateString(config.secret, `${path}.secret`);
  }
  if (config.name !== undefined) {
    validated.name = validateString(config.name, `${path}.name`);
  }
  if (config.rolling !== undefined) {
    validated.rolling = validateBoolean(config.rolling, `${path}.rolling`);
  }
  if (config.resave !== undefined) {
    validated.resave = validateBoolean(config.resave, `${path}.resave`);
  }
  if (config.saveUninitialized !== undefined) {
    validated.saveUninitialized = validateBoolean(
      config.saveUninitialized,
      `${path}.saveUninitialized`
    );
  }
  if (config.cookie !== undefined) {
    validated.cookie = config.cookie; // Complex object, allow through
  }
  if (config.proxy !== undefined) {
    validated.proxy = validateBoolean(config.proxy, `${path}.proxy`);
  }
  if (config.unset !== undefined) {
    validated.unset = validateEnum(config.unset, ['destroy', 'keep'], `${path}.unset`);
  }

  return validated;
}

/**
 * Validate logging configuration
 */
function validateLoggingConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Logging configuration must be an object'
    );
  }

  return {
    level: validateEnum(config.level, ['debug', 'info', 'warn', 'error', 'fatal'], `${path}.level`),
    format: validateEnum(config.format, ['pretty', 'json', 'compact'], `${path}.format`),
    enableColors: validateBoolean(config.enableColors, `${path}.enableColors`),
    enableTimestamp: validateBoolean(config.enableTimestamp, `${path}.enableTimestamp`),
    enableContext: validateBoolean(config.enableContext, `${path}.enableContext`),
    outputs: validateLoggingOutputsConfig(config.outputs, `${path}.outputs`),
  };
}

/**
 * Validate logging outputs configuration
 */
function validateLoggingOutputsConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Logging outputs configuration must be an object'
    );
  }

  return {
    console: validateBoolean(config.console, `${path}.console`),
    file: validateLoggingFileConfig(config.file, `${path}.file`),
    webhook: validateLoggingWebhookConfig(config.webhook, `${path}.webhook`),
  };
}

/**
 * Validate logging file configuration
 */
function validateLoggingFileConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Logging file configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    path: validateString(config.path, `${path}.path`),
    maxSize: validateString(config.maxSize, `${path}.maxSize`),
    maxFiles: validateNumber(config.maxFiles, `${path}.maxFiles`, { min: 1 }),
  };
}

/**
 * Validate logging webhook configuration
 */
function validateLoggingWebhookConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Logging webhook configuration must be an object'
    );
  }

  const result: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    headers: validateObject(config.headers, `${path}.headers`),
  };

  // Optional URL
  if (config.url !== undefined) {
    result.url = validateString(config.url, `${path}.url`);
  }

  return result;
}

/**
 * Validate security configuration
 */
function validateSecurityConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Security configuration must be an object'
    );
  }

  const validated: any = {
    cors: validateCorsConfig(config.cors, `${path}.cors`),
    helmet: validateHelmetConfig(config.helmet, `${path}.helmet`),
    rateLimit: validateSecurityRateLimitConfig(config.rateLimit, `${path}.rateLimit`),
  };

  // Optional CSRF config
  if (config.csrf !== undefined) {
    validated.csrf = validateCsrfConfig(config.csrf, `${path}.csrf`);
  }

  // Optional CSP config
  if (config.csp !== undefined) {
    validated.csp = validateCspConfig(config.csp, `${path}.csp`);
  }

  return validated;
}

/**
 * Validate CORS configuration
 */
function validateCorsConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(path, config, 'object', 'CORS configuration must be an object');
  }

  const validated: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    origin: validateCorsOrigin(config.origin, `${path}.origin`),
    methods: validateStringArray(config.methods, `${path}.methods`),
    allowedHeaders: validateStringArray(config.allowedHeaders, `${path}.allowedHeaders`),
    credentials: validateBoolean(config.credentials, `${path}.credentials`),
  };

  // Optional fields
  if (config.exposedHeaders !== undefined) {
    validated.exposedHeaders = validateStringArray(config.exposedHeaders, `${path}.exposedHeaders`);
  }
  if (config.maxAge !== undefined) {
    validated.maxAge = validateNumber(config.maxAge, `${path}.maxAge`);
  }
  if (config.preflightContinue !== undefined) {
    validated.preflightContinue = validateBoolean(
      config.preflightContinue,
      `${path}.preflightContinue`
    );
  }

  return validated;
}

/**
 * Validate CORS origin (can be string, array, or boolean)
 */
function validateCorsOrigin(value: any, path: string): string | string[] | boolean {
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return validateStringArray(value, path);
  }
  throw new ConfigValidationError(
    path,
    value,
    'string | string[] | boolean',
    'Must be a string, array of strings, or boolean'
  );
}

/**
 * Validate helmet configuration
 */
function validateHelmetConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Helmet configuration must be an object'
    );
  }

  const validated: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
  };

  // Simplified options (backward compatible)
  if (config.contentSecurityPolicy !== undefined) {
    if (typeof config.contentSecurityPolicy === 'boolean') {
      validated.contentSecurityPolicy = config.contentSecurityPolicy;
    } else if (typeof config.contentSecurityPolicy === 'object') {
      validated.contentSecurityPolicy = config.contentSecurityPolicy;
    }
  }
  if (config.hsts !== undefined) {
    validated.hsts = validateBoolean(config.hsts, `${path}.hsts`);
  }
  if (config.noSniff !== undefined) {
    validated.noSniff = validateBoolean(config.noSniff, `${path}.noSniff`);
  }
  if (config.frameguard !== undefined) {
    validated.frameguard = validateBoolean(config.frameguard, `${path}.frameguard`);
  }

  // Detailed options (for advanced configuration)
  if (config.xFrameOptions !== undefined) {
    validated.xFrameOptions = config.xFrameOptions;
  }
  if (config.xContentTypeOptions !== undefined) {
    validated.xContentTypeOptions = validateBoolean(
      config.xContentTypeOptions,
      `${path}.xContentTypeOptions`
    );
  }
  if (config.xXssProtection !== undefined) {
    validated.xXssProtection = validateBoolean(config.xXssProtection, `${path}.xXssProtection`);
  }
  if (config.referrerPolicy !== undefined) {
    validated.referrerPolicy = config.referrerPolicy;
  }
  if (config.strictTransportSecurity !== undefined) {
    validated.strictTransportSecurity = config.strictTransportSecurity;
  }
  if (config.xDownloadOptions !== undefined) {
    validated.xDownloadOptions = validateBoolean(
      config.xDownloadOptions,
      `${path}.xDownloadOptions`
    );
  }
  if (config.xPermittedCrossDomainPolicies !== undefined) {
    validated.xPermittedCrossDomainPolicies = validateBoolean(
      config.xPermittedCrossDomainPolicies,
      `${path}.xPermittedCrossDomainPolicies`
    );
  }

  return validated;
}

/**
 * Validate CSRF configuration
 */
function validateCsrfConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(path, config, 'object', 'CSRF configuration must be an object');
  }

  const validated: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
  };

  if (config.secret !== undefined) {
    validated.secret = validateString(config.secret, `${path}.secret`);
  }
  if (config.tokenLength !== undefined) {
    validated.tokenLength = validateNumber(config.tokenLength, `${path}.tokenLength`);
  }
  if (config.cookieName !== undefined) {
    validated.cookieName = validateString(config.cookieName, `${path}.cookieName`);
  }
  if (config.headerName !== undefined) {
    validated.headerName = validateString(config.headerName, `${path}.headerName`);
  }
  if (config.ignoreMethods !== undefined) {
    validated.ignoreMethods = validateStringArray(config.ignoreMethods, `${path}.ignoreMethods`);
  }
  if (config.sameSite !== undefined) {
    validated.sameSite = validateBoolean(config.sameSite, `${path}.sameSite`);
  }

  return validated;
}

/**
 * Validate CSP configuration
 */
function validateCspConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(path, config, 'object', 'CSP configuration must be an object');
  }

  const validated: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
  };

  if (config.directives !== undefined) {
    validated.directives = config.directives; // Complex object, allow through
  }
  if (config.reportOnly !== undefined) {
    validated.reportOnly = validateBoolean(config.reportOnly, `${path}.reportOnly`);
  }
  if (config.reportUri !== undefined) {
    validated.reportUri = validateString(config.reportUri, `${path}.reportUri`);
  }
  if (config.nonce !== undefined) {
    validated.nonce = validateBoolean(config.nonce, `${path}.nonce`);
  }

  return validated;
}

/**
 * Validate security rate limit configuration
 */
function validateSecurityRateLimitConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Security rate limit configuration must be an object'
    );
  }

  return {
    global: validateGlobalRateLimitConfig(config.global, `${path}.global`),
  };
}

/**
 * Validate global rate limit configuration
 */
function validateGlobalRateLimitConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Global rate limit configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    requests: validateNumber(config.requests, `${path}.requests`, { min: 1 }),
    window: validateNumber(config.window, `${path}.window`, { min: 1000 }),
  };
}

/**
 * Validate external services configuration
 */
function validateExternalServicesConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'External services configuration must be an object'
    );
  }

  const result: any = {};

  // Optional services - only validate if present
  if (config.stripe !== undefined) {
    result.stripe = validateStripeConfig(config.stripe, `${path}.stripe`);
  }
  if (config.paypal !== undefined) {
    result.paypal = validatePayPalConfig(config.paypal, `${path}.paypal`);
  }
  if (config.smtp !== undefined) {
    result.smtp = validateSMTPConfig(config.smtp, `${path}.smtp`);
  }

  return result;
}

/**
 * Validate Stripe configuration
 */
function validateStripeConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Stripe configuration must be an object'
    );
  }

  const result: any = {};

  // Optional fields
  if (config.secretKey !== undefined) {
    result.secretKey = validateString(config.secretKey, `${path}.secretKey`);
  }
  if (config.publishableKey !== undefined) {
    result.publishableKey = validateString(config.publishableKey, `${path}.publishableKey`);
  }
  if (config.webhookSecret !== undefined) {
    result.webhookSecret = validateString(config.webhookSecret, `${path}.webhookSecret`);
  }
  if (config.apiVersion !== undefined) {
    result.apiVersion = validateString(config.apiVersion, `${path}.apiVersion`);
  } else {
    result.apiVersion = '2023-10-16'; // Default API version
  }

  return result;
}

/**
 * Validate PayPal configuration
 */
function validatePayPalConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'PayPal configuration must be an object'
    );
  }

  const result: any = {
    environment: validateEnum(config.environment, ['sandbox', 'production'], `${path}.environment`),
  };

  // Optional fields
  if (config.clientId !== undefined) {
    result.clientId = validateString(config.clientId, `${path}.clientId`);
  }
  if (config.clientSecret !== undefined) {
    result.clientSecret = validateString(config.clientSecret, `${path}.clientSecret`);
  }
  if (config.webhookId !== undefined) {
    result.webhookId = validateString(config.webhookId, `${path}.webhookId`);
  }

  return result;
}

/**
 * Validate SMTP configuration
 */
function validateSMTPConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(path, config, 'object', 'SMTP configuration must be an object');
  }

  const result: any = {
    port: validatePort(config.port, `${path}.port`),
    secure: validateBoolean(config.secure, `${path}.secure`),
  };

  // Optional fields
  if (config.host !== undefined) {
    result.host = validateString(config.host, `${path}.host`);
  }
  if (config.username !== undefined) {
    result.username = validateString(config.username, `${path}.username`);
  }
  if (config.password !== undefined) {
    result.password = validateString(config.password, `${path}.password`);
  }

  return result;
}

/**
 * Validate performance configuration
 */
function validatePerformanceConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Performance configuration must be an object'
    );
  }

  return {
    compression: validateCompressionConfig(config.compression, `${path}.compression`),
    circuitBreaker: validateCircuitBreakerConfig(config.circuitBreaker, `${path}.circuitBreaker`),
    clustering: validateClusteringConfig(config.clustering, `${path}.clustering`),
  };
}

/**
 * Validate compression configuration
 */
function validateCompressionConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Compression configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    level: validateNumber(config.level, `${path}.level`, { min: 1, max: 9 }),
    threshold: validateNumber(config.threshold, `${path}.threshold`, { min: 0 }),
  };
}

/**
 * Validate circuit breaker configuration
 */
function validateCircuitBreakerConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Circuit breaker configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    failureThreshold: validateNumber(config.failureThreshold, `${path}.failureThreshold`, {
      min: 1,
    }),
    resetTimeout: validateNumber(config.resetTimeout, `${path}.resetTimeout`, { min: 1000 }),
    monitoringPeriod: validateNumber(config.monitoringPeriod, `${path}.monitoringPeriod`, {
      min: 1000,
    }),
  };
}

/**
 * Validate clustering configuration
 */
function validateClusteringConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Clustering configuration must be an object'
    );
  }

  const result: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
  };

  // Workers can be number or 'auto'
  if (typeof config.workers === 'string' && config.workers === 'auto') {
    result.workers = 'auto';
  } else {
    result.workers = validateNumber(config.workers, `${path}.workers`, { min: 1 });
  }

  // Optional memoryPerWorkerGB
  if (config.memoryPerWorkerGB !== undefined) {
    result.memoryPerWorkerGB = validateNumber(
      config.memoryPerWorkerGB,
      `${path}.memoryPerWorkerGB`,
      { min: 0.1 }
    );
  }

  // Optional mode (reuseport or proxy)
  if (config.mode !== undefined) {
    if (config.mode !== 'reuseport' && config.mode !== 'proxy') {
      throw new ConfigValidationError(
        `${path}.mode`,
        config.mode,
        "'reuseport' or 'proxy'",
        "Clustering mode must be 'reuseport' (fast, connection hashing) or 'proxy' (slower, strict round-robin)"
      );
    }
    result.mode = config.mode;
  } else {
    result.mode = 'reuseport'; // Default to reuseport for performance
  }

  return result;
}

/**
 * Validate WebSocket configuration
 */
function validateWebSocketConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'WebSocket configuration must be an object'
    );
  }

  const result: any = {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
  };

  // Optional fields
  if (config.adapter !== undefined) {
    result.adapter = validateString(config.adapter, `${path}.adapter`);
  }
  if (config.compression !== undefined) {
    result.compression = validateBoolean(config.compression, `${path}.compression`);
  }
  if (config.customIdGenerator !== undefined) {
    result.customIdGenerator = config.customIdGenerator; // Function - no validation needed
  }
  if (config.options !== undefined) {
    result.options = validateWebSocketOptions(config.options, `${path}.options`);
  }

  return result;
}

/**
 * Validate WebSocket options
 */
function validateWebSocketOptions(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(path, config, 'object', 'WebSocket options must be an object');
  }

  const result: any = {};

  if (config.cors !== undefined) {
    result.cors = validateWebSocketCorsOptions(config.cors, `${path}.cors`);
  }
  if (config.path !== undefined) {
    result.path = validateString(config.path, `${path}.path`);
  }
  if (config.maxPayloadLength !== undefined) {
    result.maxPayloadLength = validateNumber(config.maxPayloadLength, `${path}.maxPayloadLength`, {
      min: 1024,
    });
  }

  return result;
}

/**
 * Validate WebSocket CORS options
 */
function validateWebSocketCorsOptions(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'WebSocket CORS options must be an object'
    );
  }

  const result: any = {};

  if (config.origin !== undefined) {
    result.origin = validateCorsOrigin(config.origin, `${path}.origin`);
  }
  if (config.credentials !== undefined) {
    result.credentials = validateBoolean(config.credentials, `${path}.credentials`);
  }

  return result;
}

// Basic validation functions

function validatePort(value: any, path: string): number {
  const num = Number(value);
  if (isNaN(num) || num < 1 || num > 65535) {
    throw new ConfigValidationError(
      path,
      value,
      'number (1-65535)',
      'Must be a number between 1 and 65535'
    );
  }
  return num;
}

function validateBoolean(value: any, path: string): boolean {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  if (value === '1' || value === 1) return true;
  if (value === '0' || value === 0) return false;
  throw new ConfigValidationError(
    path,
    value,
    'boolean',
    'Must be a boolean (true/false) or numeric (1/0)'
  );
}

function validateNumber(
  value: any,
  path: string,
  options: { min?: number; max?: number } = {}
): number {
  const num = Number(value);
  if (isNaN(num)) {
    throw new ConfigValidationError(path, value, 'number', 'Must be a valid number');
  }
  if (options.min !== undefined && num < options.min) {
    throw new ConfigValidationError(
      path,
      value,
      `number >= ${options.min}`,
      `Must be at least ${options.min}`
    );
  }
  if (options.max !== undefined && num > options.max) {
    throw new ConfigValidationError(
      path,
      value,
      `number <= ${options.max}`,
      `Must be at most ${options.max}`
    );
  }
  return num;
}

function validateString(value: any, path: string): string {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(path, value, 'string', 'Must be a string');
  }
  return value;
}

function validateEnum<T extends string>(value: any, validValues: readonly T[], path: string): T {
  const str = validateString(value, path);

  // For small arrays (< 10 items), linear search is faster than Set
  // For larger arrays, we could use Set, but most enums in config are small
  let found = false;
  const len = validValues.length;
  for (let i = 0; i < len; i++) {
    if (validValues[i] === str) {
      found = true;
      break;
    }
  }

  if (!found) {
    throw new ConfigValidationError(
      path,
      value,
      `one of: ${validValues.join(', ')}`,
      `Must be one of: ${validValues.join(', ')}`
    );
  }
  return str as T;
}

function validateStringArray(value: any, path: string): string[] {
  if (!Array.isArray(value)) {
    // Try to parse comma-separated string
    if (typeof value === 'string') {
      // Avoid chained map().filter() - use single pass
      const parts = value.split(',');
      const result: string[] = [];
      const len = parts.length;
      for (let i = 0; i < len; i++) {
        const trimmed = parts[i].trim();
        if (trimmed.length > 0) {
          result.push(trimmed);
        }
      }
      return result;
    }
    throw new ConfigValidationError(
      path,
      value,
      'string[]',
      'Must be an array or comma-separated string'
    );
  }

  // Avoid creating intermediate arrays with map
  const len = value.length;
  const result: string[] = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = validateString(value[i], `${path}[${i}]`);
  }
  return result;
}

function validateObject(value: any, path: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigValidationError(path, value, 'object', 'Must be an object');
  }
  return value;
}

/**
 * Validate queue configuration
 */
function validateQueueConfig(config: any, path: string) {
  if (config === undefined || config === null) {
    return undefined;
  }

  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Queue configuration must be an object'
    );
  }

  const result: any = {};

  if (config.adapter !== undefined) {
    const validAdapters = ['bull', 'rabbitmq', 'sqs', 'kafka', 'memory'];
    if (!validAdapters.includes(config.adapter)) {
      throw new ConfigValidationError(
        `${path}.adapter`,
        config.adapter,
        'string',
        `Must be one of: ${validAdapters.join(', ')}`
      );
    }
    result.adapter = config.adapter;
  }

  if (config.connection !== undefined) {
    result.connection = validateQueueConnectionConfig(config.connection, `${path}.connection`);
  }

  if (config.concurrency !== undefined) {
    result.concurrency = validateNumber(config.concurrency, `${path}.concurrency`, { min: 1 });
  }

  if (config.retry !== undefined) {
    result.retry = validateQueueRetryConfig(config.retry, `${path}.retry`);
  }

  if (config.deadLetterQueue !== undefined) {
    result.deadLetterQueue = validateQueueDeadLetterConfig(
      config.deadLetterQueue,
      `${path}.deadLetterQueue`
    );
  }

  if (config.defaultJobOptions !== undefined) {
    result.defaultJobOptions = validateQueueDefaultJobOptions(
      config.defaultJobOptions,
      `${path}.defaultJobOptions`
    );
  }

  if (config.prefix !== undefined) {
    result.prefix = validateString(config.prefix, `${path}.prefix`);
  }

  if (config.limiter !== undefined) {
    result.limiter = validateQueueLimiterConfig(config.limiter, `${path}.limiter`);
  }

  return result;
}

/**
 * Validate queue connection configuration
 */
function validateQueueConnectionConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Queue connection configuration must be an object'
    );
  }

  const result: any = {};

  if (config.host !== undefined) {
    result.host = validateString(config.host, `${path}.host`);
  }

  if (config.port !== undefined) {
    result.port = validatePort(config.port, `${path}.port`);
  }

  if (config.username !== undefined) {
    result.username = validateString(config.username, `${path}.username`);
  }

  if (config.password !== undefined) {
    result.password = validateString(config.password, `${path}.password`);
  }

  if (config.database !== undefined) {
    result.database = validateNumber(config.database, `${path}.database`, { min: 0 });
  }

  if (config.brokers !== undefined) {
    result.brokers = validateStringArray(config.brokers, `${path}.brokers`);
  }

  if (config.groupId !== undefined) {
    result.groupId = validateString(config.groupId, `${path}.groupId`);
  }

  if (config.region !== undefined) {
    result.region = validateString(config.region, `${path}.region`);
  }

  if (config.queueUrl !== undefined) {
    result.queueUrl = validateString(config.queueUrl, `${path}.queueUrl`);
  }

  return result;
}

/**
 * Validate queue retry configuration
 */
function validateQueueRetryConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Queue retry configuration must be an object'
    );
  }

  const validBackoffStrategies = ['fixed', 'exponential', 'linear'];

  return {
    maxAttempts: validateNumber(config.maxAttempts, `${path}.maxAttempts`, { min: 1 }),
    backoff:
      config.backoff && validBackoffStrategies.includes(config.backoff)
        ? config.backoff
        : (() => {
            throw new ConfigValidationError(
              `${path}.backoff`,
              config.backoff,
              'string',
              `Must be one of: ${validBackoffStrategies.join(', ')}`
            );
          })(),
    initialDelay: validateNumber(config.initialDelay, `${path}.initialDelay`, { min: 0 }),
    maxDelay:
      config.maxDelay !== undefined
        ? validateNumber(config.maxDelay, `${path}.maxDelay`, { min: 0 })
        : undefined,
  };
}

/**
 * Validate queue dead letter queue configuration
 */
function validateQueueDeadLetterConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Queue dead letter configuration must be an object'
    );
  }

  return {
    enabled: validateBoolean(config.enabled, `${path}.enabled`),
    maxRetries: validateNumber(config.maxRetries, `${path}.maxRetries`, { min: 1 }),
    queueName:
      config.queueName !== undefined
        ? validateString(config.queueName, `${path}.queueName`)
        : undefined,
  };
}

/**
 * Validate queue default job options
 */
function validateQueueDefaultJobOptions(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Queue default job options must be an object'
    );
  }

  const result: any = {};

  if (config.removeOnComplete !== undefined) {
    result.removeOnComplete =
      typeof config.removeOnComplete === 'boolean'
        ? config.removeOnComplete
        : validateNumber(config.removeOnComplete, `${path}.removeOnComplete`, { min: 0 });
  }

  if (config.removeOnFail !== undefined) {
    result.removeOnFail =
      typeof config.removeOnFail === 'boolean'
        ? config.removeOnFail
        : validateNumber(config.removeOnFail, `${path}.removeOnFail`, { min: 0 });
  }

  if (config.attempts !== undefined) {
    result.attempts = validateNumber(config.attempts, `${path}.attempts`, { min: 1 });
  }

  if (config.backoff !== undefined) {
    const validBackoffTypes = ['fixed', 'exponential', 'linear'];
    if (!config.backoff.type || !validBackoffTypes.includes(config.backoff.type)) {
      throw new ConfigValidationError(
        `${path}.backoff.type`,
        config.backoff.type,
        'string',
        `Must be one of: ${validBackoffTypes.join(', ')}`
      );
    }
    result.backoff = {
      type: config.backoff.type,
      delay: validateNumber(config.backoff.delay, `${path}.backoff.delay`, { min: 0 }),
    };
  }

  return result;
}

/**
 * Validate queue limiter configuration
 */
function validateQueueLimiterConfig(config: any, path: string) {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError(
      path,
      config,
      'object',
      'Queue limiter configuration must be an object'
    );
  }

  return {
    max: validateNumber(config.max, `${path}.max`, { min: 1 }),
    duration: validateNumber(config.duration, `${path}.duration`, { min: 1 }),
  };
}

/**
 * Provide helpful validation hints based on the error
 */
function provideValidationHints(error: ConfigValidationError): void {
  if (error.field.includes('port')) {
    logger.error('  💡 Hint: Ports must be numbers between 1 and 65535');
  }
  if (error.field.includes('url')) {
    logger.error('  💡 Hint: URLs must include protocol (http:// or https://)');
  }
  if (error.field.includes('environment')) {
    logger.error('  💡 Hint: NODE_ENV must be one of: development, staging, production');
  }
  if (error.field.includes('level')) {
    logger.error('  💡 Hint: Log level must be one of: debug, info, warn, error, fatal');
  }
}
