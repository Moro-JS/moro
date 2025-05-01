// Configuration Loader - Environment Variable Mapping and Validation
import { ZodError } from "zod";
import { ConfigSchema, AppConfig } from "./schema";
import { createFrameworkLogger } from "../logger";

const logger = createFrameworkLogger("Config");

/**
 * Load and validate configuration from environment variables
 * @returns Validated and typed application configuration
 */
export function loadConfig(): AppConfig {
  logger.debug("Loading configuration from environment variables");

  // Map environment variables to configuration structure
  const envConfig = {
    server: {
      port: process.env.PORT || process.env.MORO_PORT,
      host: process.env.HOST || process.env.MORO_HOST,
      environment: process.env.NODE_ENV || process.env.MORO_ENV,
      maxConnections:
        process.env.MAX_CONNECTIONS || process.env.MORO_MAX_CONNECTIONS,
      timeout: process.env.REQUEST_TIMEOUT || process.env.MORO_TIMEOUT,
    },

    serviceDiscovery: {
      enabled:
        process.env.SERVICE_DISCOVERY_ENABLED ||
        process.env.MORO_SERVICE_DISCOVERY,
      type: process.env.DISCOVERY_TYPE || process.env.MORO_DISCOVERY_TYPE,
      consulUrl: process.env.CONSUL_URL || process.env.MORO_CONSUL_URL,
      kubernetesNamespace:
        process.env.K8S_NAMESPACE || process.env.MORO_K8S_NAMESPACE,
      healthCheckInterval:
        process.env.HEALTH_CHECK_INTERVAL || process.env.MORO_HEALTH_INTERVAL,
      retryAttempts:
        process.env.DISCOVERY_RETRY_ATTEMPTS ||
        process.env.MORO_DISCOVERY_RETRIES,
    },

    database: {
      url: process.env.DATABASE_URL || process.env.MORO_DATABASE_URL,
      redis: {
        url: process.env.REDIS_URL || process.env.MORO_REDIS_URL,
        maxRetries:
          process.env.REDIS_MAX_RETRIES || process.env.MORO_REDIS_RETRIES,
        retryDelay:
          process.env.REDIS_RETRY_DELAY || process.env.MORO_REDIS_DELAY,
        keyPrefix:
          process.env.REDIS_KEY_PREFIX || process.env.MORO_REDIS_PREFIX,
      },
      mysql: process.env.MYSQL_HOST
        ? {
            host: process.env.MYSQL_HOST || process.env.MORO_MYSQL_HOST,
            port: process.env.MYSQL_PORT || process.env.MORO_MYSQL_PORT,
            database: process.env.MYSQL_DATABASE || process.env.MORO_MYSQL_DB,
            username: process.env.MYSQL_USERNAME || process.env.MORO_MYSQL_USER,
            password: process.env.MYSQL_PASSWORD || process.env.MORO_MYSQL_PASS,
            connectionLimit:
              process.env.MYSQL_CONNECTION_LIMIT ||
              process.env.MORO_MYSQL_CONNECTIONS,
            acquireTimeout:
              process.env.MYSQL_ACQUIRE_TIMEOUT ||
              process.env.MORO_MYSQL_ACQUIRE_TIMEOUT,
            timeout:
              process.env.MYSQL_TIMEOUT || process.env.MORO_MYSQL_TIMEOUT,
          }
        : undefined,
    },

    modules: {
      cache: {
        enabled: process.env.CACHE_ENABLED || process.env.MORO_CACHE_ENABLED,
        defaultTtl: process.env.DEFAULT_CACHE_TTL || process.env.MORO_CACHE_TTL,
        maxSize: process.env.CACHE_MAX_SIZE || process.env.MORO_CACHE_SIZE,
        strategy: process.env.CACHE_STRATEGY || process.env.MORO_CACHE_STRATEGY,
      },
      rateLimit: {
        enabled:
          process.env.RATE_LIMIT_ENABLED || process.env.MORO_RATE_LIMIT_ENABLED,
        defaultRequests:
          process.env.DEFAULT_RATE_LIMIT_REQUESTS ||
          process.env.MORO_RATE_LIMIT_REQUESTS,
        defaultWindow:
          process.env.DEFAULT_RATE_LIMIT_WINDOW ||
          process.env.MORO_RATE_LIMIT_WINDOW,
        skipSuccessfulRequests:
          process.env.RATE_LIMIT_SKIP_SUCCESS ||
          process.env.MORO_RATE_LIMIT_SKIP_SUCCESS,
        skipFailedRequests:
          process.env.RATE_LIMIT_SKIP_FAILED ||
          process.env.MORO_RATE_LIMIT_SKIP_FAILED,
      },
      validation: {
        enabled:
          process.env.VALIDATION_ENABLED || process.env.MORO_VALIDATION_ENABLED,
        stripUnknown:
          process.env.VALIDATION_STRIP_UNKNOWN ||
          process.env.MORO_VALIDATION_STRIP,
        abortEarly:
          process.env.VALIDATION_ABORT_EARLY ||
          process.env.MORO_VALIDATION_ABORT,
      },
    },

    logging: {
      level: process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL,
      format: process.env.LOG_FORMAT || process.env.MORO_LOG_FORMAT,
      enableColors: process.env.NO_COLOR
        ? false
        : process.env.LOG_COLORS !== "false",
      enableTimestamp: process.env.LOG_TIMESTAMP !== "false",
      enableContext: process.env.LOG_CONTEXT !== "false",
      outputs: {
        console: process.env.LOG_CONSOLE !== "false",
        file: {
          enabled:
            process.env.LOG_FILE_ENABLED === "true" ||
            process.env.MORO_LOG_FILE === "true",
          path: process.env.LOG_FILE_PATH || process.env.MORO_LOG_PATH,
          maxSize:
            process.env.LOG_FILE_MAX_SIZE || process.env.MORO_LOG_MAX_SIZE,
          maxFiles:
            process.env.LOG_FILE_MAX_FILES || process.env.MORO_LOG_MAX_FILES,
        },
        webhook: {
          enabled:
            process.env.LOG_WEBHOOK_ENABLED === "true" ||
            process.env.MORO_LOG_WEBHOOK === "true",
          url: process.env.LOG_WEBHOOK_URL || process.env.MORO_LOG_WEBHOOK_URL,
          headers: parseJsonEnv(
            process.env.LOG_WEBHOOK_HEADERS ||
              process.env.MORO_LOG_WEBHOOK_HEADERS,
            {},
          ),
        },
      },
    },

    security: {
      cors: {
        enabled: process.env.CORS_ENABLED !== "false",
        origin: parseArrayOrString(
          process.env.CORS_ORIGIN || process.env.MORO_CORS_ORIGIN,
        ),
        methods: parseArrayEnv(
          process.env.CORS_METHODS || process.env.MORO_CORS_METHODS,
        ),
        allowedHeaders: parseArrayEnv(
          process.env.CORS_HEADERS || process.env.MORO_CORS_HEADERS,
        ),
        credentials: process.env.CORS_CREDENTIALS === "true",
      },
      helmet: {
        enabled: process.env.HELMET_ENABLED !== "false",
        contentSecurityPolicy: process.env.HELMET_CSP !== "false",
        hsts: process.env.HELMET_HSTS !== "false",
        noSniff: process.env.HELMET_NO_SNIFF !== "false",
        frameguard: process.env.HELMET_FRAMEGUARD !== "false",
      },
      rateLimit: {
        global: {
          enabled: process.env.GLOBAL_RATE_LIMIT_ENABLED === "true",
          requests:
            process.env.GLOBAL_RATE_LIMIT_REQUESTS ||
            process.env.MORO_GLOBAL_RATE_REQUESTS,
          window:
            process.env.GLOBAL_RATE_LIMIT_WINDOW ||
            process.env.MORO_GLOBAL_RATE_WINDOW,
        },
      },
    },

    external: {
      stripe:
        process.env.STRIPE_SECRET_KEY || process.env.MORO_STRIPE_SECRET
          ? {
              secretKey:
                process.env.STRIPE_SECRET_KEY || process.env.MORO_STRIPE_SECRET,
              publishableKey:
                process.env.STRIPE_PUBLISHABLE_KEY ||
                process.env.MORO_STRIPE_PUBLIC,
              webhookSecret:
                process.env.STRIPE_WEBHOOK_SECRET ||
                process.env.MORO_STRIPE_WEBHOOK,
              apiVersion:
                process.env.STRIPE_API_VERSION ||
                process.env.MORO_STRIPE_VERSION,
            }
          : undefined,

      paypal:
        process.env.PAYPAL_CLIENT_ID || process.env.MORO_PAYPAL_CLIENT
          ? {
              clientId:
                process.env.PAYPAL_CLIENT_ID || process.env.MORO_PAYPAL_CLIENT,
              clientSecret:
                process.env.PAYPAL_CLIENT_SECRET ||
                process.env.MORO_PAYPAL_SECRET,
              webhookId:
                process.env.PAYPAL_WEBHOOK_ID ||
                process.env.MORO_PAYPAL_WEBHOOK,
              environment:
                process.env.PAYPAL_ENVIRONMENT || process.env.MORO_PAYPAL_ENV,
            }
          : undefined,

      smtp:
        process.env.SMTP_HOST || process.env.MORO_SMTP_HOST
          ? {
              host: process.env.SMTP_HOST || process.env.MORO_SMTP_HOST,
              port: process.env.SMTP_PORT || process.env.MORO_SMTP_PORT,
              secure: process.env.SMTP_SECURE === "true",
              username: process.env.SMTP_USERNAME || process.env.MORO_SMTP_USER,
              password: process.env.SMTP_PASSWORD || process.env.MORO_SMTP_PASS,
            }
          : undefined,
    },

    performance: {
      compression: {
        enabled: process.env.COMPRESSION_ENABLED !== "false",
        level:
          process.env.COMPRESSION_LEVEL || process.env.MORO_COMPRESSION_LEVEL,
        threshold:
          process.env.COMPRESSION_THRESHOLD ||
          process.env.MORO_COMPRESSION_THRESHOLD,
      },
      circuitBreaker: {
        enabled: process.env.CIRCUIT_BREAKER_ENABLED !== "false",
        failureThreshold:
          process.env.CIRCUIT_BREAKER_THRESHOLD ||
          process.env.MORO_CB_THRESHOLD,
        resetTimeout:
          process.env.CIRCUIT_BREAKER_RESET || process.env.MORO_CB_RESET,
        monitoringPeriod:
          process.env.CIRCUIT_BREAKER_MONITOR || process.env.MORO_CB_MONITOR,
      },
      clustering: {
        enabled: process.env.CLUSTERING_ENABLED === "true",
        workers: process.env.CLUSTER_WORKERS || process.env.MORO_WORKERS,
      },
    },
  };

  // Validate and transform configuration using Zod
  try {
    const validatedConfig = ConfigSchema.parse(envConfig);

    logger.info("Configuration loaded and validated successfully");
    logger.debug(
      "Configuration details:",
      JSON.stringify({
        server: {
          port: validatedConfig.server.port,
          environment: validatedConfig.server.environment,
        },
        serviceDiscovery: {
          enabled: validatedConfig.serviceDiscovery.enabled,
          type: validatedConfig.serviceDiscovery.type,
        },
        modules: {
          cacheEnabled: validatedConfig.modules.cache.enabled,
          rateLimitEnabled: validatedConfig.modules.rateLimit.enabled,
        },
      }),
    );

    return validatedConfig;
  } catch (error) {
    logger.error("❌ Configuration validation failed");

    if (error instanceof ZodError) {
      logger.error("Configuration errors:");
      error.issues.forEach((err: any) => {
        const path = err.path.join(".");
        logger.error(`  - ${path}: ${err.message}`);

        // Provide helpful hints for common errors
        if (path.includes("port") && err.code === "invalid_type") {
          logger.error(`    Hint: PORT must be a number between 1 and 65535`);
        }
        if (path.includes("url") && err.code === "invalid_string") {
          logger.error(
            `    Hint: URLs must include protocol (http:// or https://)`,
          );
        }
        if (path.includes("environment") && err.code === "invalid_enum_value") {
          logger.error(
            `    Hint: NODE_ENV must be one of: development, staging, production`,
          );
        }
      });

      logger.error("\nConfiguration Help:");
      logger.error(
        "  - Use MORO_* prefixed environment variables for framework-specific config",
      );
      logger.error(
        "  - Check .env.example for available configuration options",
      );
      logger.error("  - See documentation for detailed configuration guide");
    } else {
      logger.error("Unexpected configuration error:", String(error));
    }

    process.exit(1);
  }
}

/**
 * Parse JSON environment variable safely
 */
function parseJsonEnv(value: string | undefined, defaultValue: any): any {
  if (!value) return defaultValue;

  try {
    return JSON.parse(value);
  } catch {
    logger.warn(`Invalid JSON in environment variable, using default:`, value);
    return defaultValue;
  }
}

/**
 * Parse comma-separated array environment variable
 */
function parseArrayEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse array or string environment variable
 */
function parseArrayOrString(
  value: string | undefined,
): string | string[] | boolean | undefined {
  if (!value) return undefined;

  // If it contains commas, treat as array
  if (value.includes(",")) {
    return parseArrayEnv(value);
  }

  // Special boolean values
  if (value === "true") return true;
  if (value === "false") return false;

  return value;
}

/**
 * Get environment variable with multiple possible names
 */
function getEnvVar(...names: (string | undefined)[]): string | undefined {
  for (const name of names) {
    if (name && process.env[name]) {
      return process.env[name];
    }
  }
  return undefined;
}
