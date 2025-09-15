// TypeScript-based Configuration Loader
// Replaces Zod-based configuration system with pure TypeScript + validation

import { AppConfig, DEFAULT_CONFIG } from './types';
import {
  validatePort,
  validateBoolean,
  validateNumber,
  validateString,
  validateUrl,
  validateEnum,
  validateStringArray,
  validateOptional,
  coerceEnvValue,
  ConfigValidationError,
} from './validation';
import { createFrameworkLogger } from '../logger';
import { loadConfigFileSync, applyConfigAsEnvironmentVariables } from './file-loader';

const logger = createFrameworkLogger('TypeScriptConfig');

/**
 * Load and validate configuration using TypeScript + simple validation
 * No Zod dependency required!
 */
export function loadConfigWithTypeScript(): AppConfig {
  logger.debug('Loading configuration with TypeScript validation');

  // Load config file and apply as environment variables
  try {
    const fileConfig = loadConfigFileSync();
    if (fileConfig) {
      logger.debug('Applying config file values as environment variables');
      applyConfigAsEnvironmentVariables(fileConfig);
    }
  } catch (error) {
    logger.warn(
      'Config file loading failed, continuing with environment variables only:',
      String(error)
    );
  }

  try {
    // Build configuration from environment variables with type-safe validation
    const config: AppConfig = {
      server: {
        port: validatePort(
          coerceEnvValue(process.env.MORO_SERVER_PORT || '') || DEFAULT_CONFIG.server.port,
          'server.port'
        ),
        host: validateString(
          process.env.MORO_SERVER_HOST || DEFAULT_CONFIG.server.host,
          'server.host'
        ),
        environment: validateEnum(
          process.env.NODE_ENV || DEFAULT_CONFIG.server.environment,
          ['development', 'staging', 'production'] as const,
          'server.environment'
        ),
        maxConnections: validateNumber(
          coerceEnvValue(process.env.MORO_SERVER_MAX_CONNECTIONS || '') ||
            DEFAULT_CONFIG.server.maxConnections,
          'server.maxConnections',
          { min: 1 }
        ),
        timeout: validateNumber(
          coerceEnvValue(process.env.MORO_SERVER_TIMEOUT || '') || DEFAULT_CONFIG.server.timeout,
          'server.timeout',
          { min: 1000 }
        ),
      },

      serviceDiscovery: {
        enabled: validateBoolean(
          coerceEnvValue(process.env.MORO_SERVICE_DISCOVERY_ENABLED || '') ??
            DEFAULT_CONFIG.serviceDiscovery.enabled,
          'serviceDiscovery.enabled'
        ),
        type: validateEnum(
          process.env.MORO_SERVICE_DISCOVERY_TYPE || DEFAULT_CONFIG.serviceDiscovery.type,
          ['memory', 'consul', 'kubernetes'] as const,
          'serviceDiscovery.type'
        ),
        consulUrl: validateUrl(
          process.env.MORO_SERVICE_DISCOVERY_CONSUL_URL ||
            DEFAULT_CONFIG.serviceDiscovery.consulUrl,
          'serviceDiscovery.consulUrl'
        ),
        kubernetesNamespace: validateString(
          process.env.MORO_SERVICE_DISCOVERY_KUBERNETES_NAMESPACE ||
            DEFAULT_CONFIG.serviceDiscovery.kubernetesNamespace,
          'serviceDiscovery.kubernetesNamespace'
        ),
        healthCheckInterval: validateNumber(
          coerceEnvValue(process.env.MORO_SERVICE_DISCOVERY_HEALTH_CHECK_INTERVAL || '') ||
            DEFAULT_CONFIG.serviceDiscovery.healthCheckInterval,
          'serviceDiscovery.healthCheckInterval',
          { min: 1000 }
        ),
        retryAttempts: validateNumber(
          coerceEnvValue(process.env.MORO_SERVICE_DISCOVERY_RETRY_ATTEMPTS || '') ||
            DEFAULT_CONFIG.serviceDiscovery.retryAttempts,
          'serviceDiscovery.retryAttempts',
          { min: 0 }
        ),
      },

      database: {
        url: validateOptional(process.env.DATABASE_URL, validateString, 'database.url'),
        redis: {
          url: validateString(
            process.env.REDIS_URL || DEFAULT_CONFIG.database.redis.url,
            'database.redis.url'
          ),
          maxRetries: validateNumber(
            coerceEnvValue(process.env.REDIS_MAX_RETRIES || '') ||
              DEFAULT_CONFIG.database.redis.maxRetries,
            'database.redis.maxRetries',
            { min: 0 }
          ),
          retryDelay: validateNumber(
            coerceEnvValue(process.env.REDIS_RETRY_DELAY || '') ||
              DEFAULT_CONFIG.database.redis.retryDelay,
            'database.redis.retryDelay',
            { min: 100 }
          ),
          keyPrefix: validateString(
            process.env.REDIS_KEY_PREFIX || DEFAULT_CONFIG.database.redis.keyPrefix,
            'database.redis.keyPrefix'
          ),
        },
        mysql: process.env.MYSQL_HOST
          ? {
              host: validateString(process.env.MYSQL_HOST, 'database.mysql.host'),
              port: validatePort(process.env.MYSQL_PORT || '3306', 'database.mysql.port'),
              database: validateOptional(
                process.env.MYSQL_DATABASE,
                validateString,
                'database.mysql.database'
              ),
              username: validateOptional(
                process.env.MYSQL_USERNAME,
                validateString,
                'database.mysql.username'
              ),
              password: validateOptional(
                process.env.MYSQL_PASSWORD,
                validateString,
                'database.mysql.password'
              ),
              connectionLimit: validateNumber(
                coerceEnvValue(process.env.MYSQL_CONNECTION_LIMIT || '') || 10,
                'database.mysql.connectionLimit',
                { min: 1 }
              ),
              acquireTimeout: validateNumber(
                coerceEnvValue(process.env.MYSQL_ACQUIRE_TIMEOUT || '') || 60000,
                'database.mysql.acquireTimeout',
                { min: 1000 }
              ),
              timeout: validateNumber(
                coerceEnvValue(process.env.MYSQL_TIMEOUT || '') || 60000,
                'database.mysql.timeout',
                { min: 1000 }
              ),
            }
          : undefined,
      },

      modules: {
        cache: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_CACHE_ENABLED || '') ??
              DEFAULT_CONFIG.modules.cache.enabled,
            'modules.cache.enabled'
          ),
          defaultTtl: validateNumber(
            coerceEnvValue(process.env.MORO_MODULES_CACHE_DEFAULT_TTL || '') ||
              DEFAULT_CONFIG.modules.cache.defaultTtl,
            'modules.cache.defaultTtl',
            { min: 0 }
          ),
          maxSize: validateNumber(
            coerceEnvValue(process.env.MORO_MODULES_CACHE_MAX_SIZE || '') ||
              DEFAULT_CONFIG.modules.cache.maxSize,
            'modules.cache.maxSize',
            { min: 1 }
          ),
          strategy: validateEnum(
            process.env.MORO_MODULES_CACHE_STRATEGY || DEFAULT_CONFIG.modules.cache.strategy,
            ['lru', 'lfu', 'fifo'] as const,
            'modules.cache.strategy'
          ),
        },
        rateLimit: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_RATE_LIMIT_ENABLED || '') ??
              DEFAULT_CONFIG.modules.rateLimit.enabled,
            'modules.rateLimit.enabled'
          ),
          defaultRequests: validateNumber(
            coerceEnvValue(process.env.MORO_MODULES_RATE_LIMIT_DEFAULT_REQUESTS || '') ||
              DEFAULT_CONFIG.modules.rateLimit.defaultRequests,
            'modules.rateLimit.defaultRequests',
            { min: 1 }
          ),
          defaultWindow: validateNumber(
            coerceEnvValue(process.env.MORO_MODULES_RATE_LIMIT_DEFAULT_WINDOW || '') ||
              DEFAULT_CONFIG.modules.rateLimit.defaultWindow,
            'modules.rateLimit.defaultWindow',
            { min: 1000 }
          ),
          skipSuccessfulRequests: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_RATE_LIMIT_SKIP_SUCCESSFUL_REQUESTS || '') ??
              DEFAULT_CONFIG.modules.rateLimit.skipSuccessfulRequests,
            'modules.rateLimit.skipSuccessfulRequests'
          ),
          skipFailedRequests: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_RATE_LIMIT_SKIP_FAILED_REQUESTS || '') ??
              DEFAULT_CONFIG.modules.rateLimit.skipFailedRequests,
            'modules.rateLimit.skipFailedRequests'
          ),
        },
        validation: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_VALIDATION_ENABLED || '') ??
              DEFAULT_CONFIG.modules.validation.enabled,
            'modules.validation.enabled'
          ),
          stripUnknown: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_VALIDATION_STRIP_UNKNOWN || '') ??
              DEFAULT_CONFIG.modules.validation.stripUnknown,
            'modules.validation.stripUnknown'
          ),
          abortEarly: validateBoolean(
            coerceEnvValue(process.env.MORO_MODULES_VALIDATION_ABORT_EARLY || '') ??
              DEFAULT_CONFIG.modules.validation.abortEarly,
            'modules.validation.abortEarly'
          ),
        },
      },

      logging: {
        level: validateEnum(
          process.env.MORO_LOGGING_LEVEL || DEFAULT_CONFIG.logging.level,
          ['debug', 'info', 'warn', 'error', 'fatal'] as const,
          'logging.level'
        ),
        format: validateEnum(
          process.env.MORO_LOGGING_FORMAT || DEFAULT_CONFIG.logging.format,
          ['pretty', 'json', 'compact'] as const,
          'logging.format'
        ),
        enableColors: validateBoolean(
          coerceEnvValue(process.env.MORO_LOGGING_ENABLE_COLORS || '') ??
            DEFAULT_CONFIG.logging.enableColors,
          'logging.enableColors'
        ),
        enableTimestamp: validateBoolean(
          coerceEnvValue(process.env.MORO_LOGGING_ENABLE_TIMESTAMP || '') ??
            DEFAULT_CONFIG.logging.enableTimestamp,
          'logging.enableTimestamp'
        ),
        enableContext: validateBoolean(
          coerceEnvValue(process.env.MORO_LOGGING_ENABLE_CONTEXT || '') ??
            DEFAULT_CONFIG.logging.enableContext,
          'logging.enableContext'
        ),
        outputs: {
          console: validateBoolean(
            coerceEnvValue(process.env.MORO_LOGGING_OUTPUTS_CONSOLE || '') ??
              DEFAULT_CONFIG.logging.outputs.console,
            'logging.outputs.console'
          ),
          file: {
            enabled: validateBoolean(
              coerceEnvValue(process.env.MORO_LOGGING_OUTPUTS_FILE_ENABLED || '') ??
                DEFAULT_CONFIG.logging.outputs.file.enabled,
              'logging.outputs.file.enabled'
            ),
            path: validateString(
              process.env.MORO_LOGGING_OUTPUTS_FILE_PATH ||
                DEFAULT_CONFIG.logging.outputs.file.path,
              'logging.outputs.file.path'
            ),
            maxSize: validateString(
              process.env.MORO_LOGGING_OUTPUTS_FILE_MAX_SIZE ||
                DEFAULT_CONFIG.logging.outputs.file.maxSize,
              'logging.outputs.file.maxSize'
            ),
            maxFiles: validateNumber(
              coerceEnvValue(process.env.MORO_LOGGING_OUTPUTS_FILE_MAX_FILES || '') ||
                DEFAULT_CONFIG.logging.outputs.file.maxFiles,
              'logging.outputs.file.maxFiles',
              { min: 1 }
            ),
          },
          webhook: {
            enabled: validateBoolean(
              coerceEnvValue(process.env.MORO_LOGGING_OUTPUTS_WEBHOOK_ENABLED || '') ??
                DEFAULT_CONFIG.logging.outputs.webhook.enabled,
              'logging.outputs.webhook.enabled'
            ),
            url: validateOptional(
              process.env.MORO_LOGGING_OUTPUTS_WEBHOOK_URL,
              validateUrl,
              'logging.outputs.webhook.url'
            ),
            headers: DEFAULT_CONFIG.logging.outputs.webhook.headers,
          },
        },
      },

      security: {
        cors: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_CORS_ENABLED || '') ??
              DEFAULT_CONFIG.security.cors.enabled,
            'security.cors.enabled'
          ),
          origin: process.env.MORO_SECURITY_CORS_ORIGIN || DEFAULT_CONFIG.security.cors.origin,
          methods: validateStringArray(
            process.env.MORO_SECURITY_CORS_METHODS || DEFAULT_CONFIG.security.cors.methods,
            'security.cors.methods'
          ),
          allowedHeaders: validateStringArray(
            process.env.MORO_SECURITY_CORS_ALLOWED_HEADERS ||
              DEFAULT_CONFIG.security.cors.allowedHeaders,
            'security.cors.allowedHeaders'
          ),
          credentials: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_CORS_CREDENTIALS || '') ??
              DEFAULT_CONFIG.security.cors.credentials,
            'security.cors.credentials'
          ),
        },
        helmet: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_HELMET_ENABLED || '') ??
              DEFAULT_CONFIG.security.helmet.enabled,
            'security.helmet.enabled'
          ),
          contentSecurityPolicy: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_HELMET_CSP || '') ??
              DEFAULT_CONFIG.security.helmet.contentSecurityPolicy,
            'security.helmet.contentSecurityPolicy'
          ),
          hsts: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_HELMET_HSTS || '') ??
              DEFAULT_CONFIG.security.helmet.hsts,
            'security.helmet.hsts'
          ),
          noSniff: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_HELMET_NO_SNIFF || '') ??
              DEFAULT_CONFIG.security.helmet.noSniff,
            'security.helmet.noSniff'
          ),
          frameguard: validateBoolean(
            coerceEnvValue(process.env.MORO_SECURITY_HELMET_FRAMEGUARD || '') ??
              DEFAULT_CONFIG.security.helmet.frameguard,
            'security.helmet.frameguard'
          ),
        },
        rateLimit: {
          global: {
            enabled: validateBoolean(
              coerceEnvValue(process.env.MORO_SECURITY_RATE_LIMIT_GLOBAL_ENABLED || '') ??
                DEFAULT_CONFIG.security.rateLimit.global.enabled,
              'security.rateLimit.global.enabled'
            ),
            requests: validateNumber(
              coerceEnvValue(process.env.MORO_SECURITY_RATE_LIMIT_GLOBAL_REQUESTS || '') ||
                DEFAULT_CONFIG.security.rateLimit.global.requests,
              'security.rateLimit.global.requests',
              { min: 1 }
            ),
            window: validateNumber(
              coerceEnvValue(process.env.MORO_SECURITY_RATE_LIMIT_GLOBAL_WINDOW || '') ||
                DEFAULT_CONFIG.security.rateLimit.global.window,
              'security.rateLimit.global.window',
              { min: 1000 }
            ),
          },
        },
      },

      external: {
        stripe: process.env.STRIPE_SECRET_KEY
          ? {
              secretKey: validateOptional(
                process.env.STRIPE_SECRET_KEY,
                validateString,
                'external.stripe.secretKey'
              ),
              publishableKey: validateOptional(
                process.env.STRIPE_PUBLISHABLE_KEY,
                validateString,
                'external.stripe.publishableKey'
              ),
              webhookSecret: validateOptional(
                process.env.STRIPE_WEBHOOK_SECRET,
                validateString,
                'external.stripe.webhookSecret'
              ),
              apiVersion: validateString(
                process.env.STRIPE_API_VERSION || DEFAULT_CONFIG.external.stripe!.apiVersion,
                'external.stripe.apiVersion'
              ),
            }
          : undefined,
        paypal: process.env.PAYPAL_CLIENT_ID
          ? {
              clientId: validateOptional(
                process.env.PAYPAL_CLIENT_ID,
                validateString,
                'external.paypal.clientId'
              ),
              clientSecret: validateOptional(
                process.env.PAYPAL_CLIENT_SECRET,
                validateString,
                'external.paypal.clientSecret'
              ),
              webhookId: validateOptional(
                process.env.PAYPAL_WEBHOOK_ID,
                validateString,
                'external.paypal.webhookId'
              ),
              environment: validateEnum(
                process.env.PAYPAL_ENVIRONMENT || DEFAULT_CONFIG.external.paypal!.environment,
                ['sandbox', 'production'] as const,
                'external.paypal.environment'
              ),
            }
          : undefined,
        smtp: process.env.SMTP_HOST
          ? {
              host: validateOptional(process.env.SMTP_HOST, validateString, 'external.smtp.host'),
              port: validatePort(
                process.env.SMTP_PORT || DEFAULT_CONFIG.external.smtp!.port.toString(),
                'external.smtp.port'
              ),
              secure: validateBoolean(
                coerceEnvValue(process.env.SMTP_SECURE || '') ??
                  DEFAULT_CONFIG.external.smtp!.secure,
                'external.smtp.secure'
              ),
              username: validateOptional(
                process.env.SMTP_USERNAME,
                validateString,
                'external.smtp.username'
              ),
              password: validateOptional(
                process.env.SMTP_PASSWORD,
                validateString,
                'external.smtp.password'
              ),
            }
          : undefined,
      },

      performance: {
        compression: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_PERFORMANCE_COMPRESSION_ENABLED || '') ??
              DEFAULT_CONFIG.performance.compression.enabled,
            'performance.compression.enabled'
          ),
          level: validateNumber(
            coerceEnvValue(process.env.MORO_PERFORMANCE_COMPRESSION_LEVEL || '') ||
              DEFAULT_CONFIG.performance.compression.level,
            'performance.compression.level',
            { min: 1, max: 9 }
          ),
          threshold: validateNumber(
            coerceEnvValue(process.env.MORO_PERFORMANCE_COMPRESSION_THRESHOLD || '') ||
              DEFAULT_CONFIG.performance.compression.threshold,
            'performance.compression.threshold',
            { min: 0 }
          ),
        },
        circuitBreaker: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_PERFORMANCE_CIRCUIT_BREAKER_ENABLED || '') ??
              DEFAULT_CONFIG.performance.circuitBreaker.enabled,
            'performance.circuitBreaker.enabled'
          ),
          failureThreshold: validateNumber(
            coerceEnvValue(process.env.MORO_PERFORMANCE_CIRCUIT_BREAKER_FAILURE_THRESHOLD || '') ||
              DEFAULT_CONFIG.performance.circuitBreaker.failureThreshold,
            'performance.circuitBreaker.failureThreshold',
            { min: 1 }
          ),
          resetTimeout: validateNumber(
            coerceEnvValue(process.env.MORO_PERFORMANCE_CIRCUIT_BREAKER_RESET_TIMEOUT || '') ||
              DEFAULT_CONFIG.performance.circuitBreaker.resetTimeout,
            'performance.circuitBreaker.resetTimeout',
            { min: 1000 }
          ),
          monitoringPeriod: validateNumber(
            coerceEnvValue(process.env.MORO_PERFORMANCE_CIRCUIT_BREAKER_MONITORING_PERIOD || '') ||
              DEFAULT_CONFIG.performance.circuitBreaker.monitoringPeriod,
            'performance.circuitBreaker.monitoringPeriod',
            { min: 1000 }
          ),
        },
        clustering: {
          enabled: validateBoolean(
            coerceEnvValue(process.env.MORO_PERFORMANCE_CLUSTERING_ENABLED || '') ??
              DEFAULT_CONFIG.performance.clustering.enabled,
            'performance.clustering.enabled'
          ),
          workers:
            process.env.MORO_PERFORMANCE_CLUSTERING_WORKERS === 'auto'
              ? 'auto'
              : validateNumber(
                  coerceEnvValue(process.env.MORO_PERFORMANCE_CLUSTERING_WORKERS || '') ||
                    DEFAULT_CONFIG.performance.clustering.workers,
                  'performance.clustering.workers',
                  { min: 1 }
                ),
        },
      },
    };

    logger.info('Configuration loaded and validated successfully with TypeScript');
    logger.debug(
      'Configuration summary:',
      JSON.stringify({
        server: { port: config.server.port, environment: config.server.environment },
        serviceDiscovery: {
          enabled: config.serviceDiscovery.enabled,
          type: config.serviceDiscovery.type,
        },
        modules: {
          cache: config.modules.cache.enabled,
          rateLimit: config.modules.rateLimit.enabled,
          validation: config.modules.validation.enabled,
        },
      })
    );

    return config;
  } catch (error) {
    logger.error('❌ Configuration validation failed');

    if (error instanceof ConfigValidationError) {
      logger.error(`Configuration error in '${error.field}': ${error.message}`);
      logger.error(`  Value: ${JSON.stringify(error.value)}`);

      // Provide helpful hints
      if (error.field.includes('port')) {
        logger.error('  Hint: Ports must be numbers between 1 and 65535');
      }
      if (error.field.includes('url')) {
        logger.error('  Hint: URLs must include protocol (http:// or https://)');
      }
      if (error.field.includes('environment')) {
        logger.error('  Hint: NODE_ENV must be one of: development, staging, production');
      }
    } else {
      logger.error('Unexpected configuration error:', String(error));
    }

    logger.error('\nConfiguration Help:');
    logger.error('  - Use MORO_* prefixed environment variables for framework-specific config');
    logger.error('  - Check .env.example for available configuration options');
    logger.error('  - See documentation for detailed configuration guide');

    process.exit(1);
  }
}
