"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerformanceConfigSchema = exports.ExternalServicesConfigSchema = exports.SecurityConfigSchema = exports.LoggingConfigSchema = exports.ModuleDefaultsConfigSchema = exports.DatabaseConfigSchema = exports.ServiceDiscoveryConfigSchema = exports.ServerConfigSchema = exports.ConfigSchema = void 0;
// Core Configuration Schema for Moro Framework
const zod_1 = require("zod");
// Server Configuration Schema
const ServerConfigSchema = zod_1.z.object({
    port: zod_1.z.coerce
        .number()
        .min(1, "Port must be at least 1")
        .max(65535, "Port must be at most 65535")
        .default(3001)
        .describe("Server port to listen on"),
    host: zod_1.z.string().default("localhost").describe("Server host to bind to"),
    environment: zod_1.z
        .enum(["development", "staging", "production"])
        .default("development")
        .describe("Application environment"),
    maxConnections: zod_1.z.coerce
        .number()
        .min(1)
        .default(1000)
        .describe("Maximum concurrent connections"),
    timeout: zod_1.z.coerce
        .number()
        .min(1000)
        .default(30000)
        .describe("Request timeout in milliseconds"),
});
exports.ServerConfigSchema = ServerConfigSchema;
// Service Discovery Configuration Schema
const ServiceDiscoveryConfigSchema = zod_1.z.object({
    enabled: zod_1.z.coerce
        .boolean()
        .default(false)
        .describe("Enable service discovery"),
    type: zod_1.z
        .enum(["memory", "consul", "kubernetes"])
        .default("memory")
        .describe("Service discovery backend type"),
    consulUrl: zod_1.z
        .string()
        .url("Must be a valid URL")
        .default("http://localhost:8500")
        .describe("Consul server URL"),
    kubernetesNamespace: zod_1.z
        .string()
        .default("default")
        .describe("Kubernetes namespace for service discovery"),
    healthCheckInterval: zod_1.z.coerce
        .number()
        .min(1000)
        .default(30000)
        .describe("Health check interval in milliseconds"),
    retryAttempts: zod_1.z.coerce
        .number()
        .min(0)
        .default(3)
        .describe("Number of retry attempts for failed health checks"),
});
exports.ServiceDiscoveryConfigSchema = ServiceDiscoveryConfigSchema;
// Database Configuration Schema
const DatabaseConfigSchema = zod_1.z.object({
    url: zod_1.z.string().optional().describe("Primary database connection URL"),
    redis: zod_1.z.object({
        url: zod_1.z
            .string()
            .default("redis://localhost:6379")
            .describe("Redis connection URL"),
        maxRetries: zod_1.z.coerce
            .number()
            .min(0)
            .default(3)
            .describe("Maximum Redis connection retry attempts"),
        retryDelay: zod_1.z.coerce
            .number()
            .min(100)
            .default(1000)
            .describe("Redis retry delay in milliseconds"),
        keyPrefix: zod_1.z.string().default("moro:").describe("Redis key prefix"),
    }),
    mysql: zod_1.z
        .object({
        host: zod_1.z.string().default("localhost"),
        port: zod_1.z.coerce.number().min(1).max(65535).default(3306),
        database: zod_1.z.string().optional(),
        username: zod_1.z.string().optional(),
        password: zod_1.z.string().optional(),
        connectionLimit: zod_1.z.coerce.number().min(1).default(10),
        acquireTimeout: zod_1.z.coerce.number().min(1000).default(60000),
        timeout: zod_1.z.coerce.number().min(1000).default(60000),
    })
        .optional(),
});
exports.DatabaseConfigSchema = DatabaseConfigSchema;
// Module Defaults Configuration Schema
const ModuleDefaultsConfigSchema = zod_1.z.object({
    cache: zod_1.z.object({
        enabled: zod_1.z.coerce
            .boolean()
            .default(true)
            .describe("Enable caching by default"),
        defaultTtl: zod_1.z.coerce
            .number()
            .min(0)
            .default(300)
            .describe("Default cache TTL in seconds"),
        maxSize: zod_1.z.coerce
            .number()
            .min(1)
            .default(1000)
            .describe("Maximum cache entries"),
        strategy: zod_1.z
            .enum(["lru", "lfu", "fifo"])
            .default("lru")
            .describe("Cache eviction strategy"),
    }),
    rateLimit: zod_1.z.object({
        enabled: zod_1.z.coerce
            .boolean()
            .default(true)
            .describe("Enable rate limiting by default"),
        defaultRequests: zod_1.z.coerce
            .number()
            .min(1)
            .default(100)
            .describe("Default requests per window"),
        defaultWindow: zod_1.z.coerce
            .number()
            .min(1000)
            .default(60000)
            .describe("Default rate limit window in milliseconds"),
        skipSuccessfulRequests: zod_1.z.coerce
            .boolean()
            .default(false)
            .describe("Skip successful requests in rate limit counting"),
        skipFailedRequests: zod_1.z.coerce
            .boolean()
            .default(false)
            .describe("Skip failed requests in rate limit counting"),
    }),
    validation: zod_1.z.object({
        enabled: zod_1.z.coerce
            .boolean()
            .default(true)
            .describe("Enable validation by default"),
        stripUnknown: zod_1.z.coerce
            .boolean()
            .default(true)
            .describe("Strip unknown properties from validated data"),
        abortEarly: zod_1.z.coerce
            .boolean()
            .default(false)
            .describe("Stop validation on first error"),
    }),
});
exports.ModuleDefaultsConfigSchema = ModuleDefaultsConfigSchema;
// Logging Configuration Schema
const LoggingConfigSchema = zod_1.z.object({
    level: zod_1.z
        .enum(["debug", "info", "warn", "error", "fatal"])
        .default("info")
        .describe("Minimum log level"),
    format: zod_1.z
        .enum(["pretty", "json", "compact"])
        .default("pretty")
        .describe("Log output format"),
    enableColors: zod_1.z.coerce
        .boolean()
        .default(true)
        .describe("Enable colored log output"),
    enableTimestamp: zod_1.z.coerce
        .boolean()
        .default(true)
        .describe("Include timestamp in logs"),
    enableContext: zod_1.z.coerce
        .boolean()
        .default(true)
        .describe("Include context information in logs"),
    outputs: zod_1.z.object({
        console: zod_1.z.coerce.boolean().default(true),
        file: zod_1.z.object({
            enabled: zod_1.z.coerce.boolean().default(false),
            path: zod_1.z.string().default("./logs/moro.log"),
            maxSize: zod_1.z.string().default("10MB"),
            maxFiles: zod_1.z.coerce.number().default(5),
        }),
        webhook: zod_1.z.object({
            enabled: zod_1.z.coerce.boolean().default(false),
            url: zod_1.z.string().url().optional(),
            headers: zod_1.z.record(zod_1.z.string(), zod_1.z.string()).default({}),
        }),
    }),
});
exports.LoggingConfigSchema = LoggingConfigSchema;
// Security Configuration Schema
const SecurityConfigSchema = zod_1.z.object({
    cors: zod_1.z.object({
        enabled: zod_1.z.coerce.boolean().default(true),
        origin: zod_1.z
            .union([zod_1.z.string(), zod_1.z.array(zod_1.z.string()), zod_1.z.boolean()])
            .default("*"),
        methods: zod_1.z
            .array(zod_1.z.string())
            .default(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]),
        allowedHeaders: zod_1.z
            .array(zod_1.z.string())
            .default(["Content-Type", "Authorization"]),
        credentials: zod_1.z.coerce.boolean().default(false),
    }),
    helmet: zod_1.z.object({
        enabled: zod_1.z.coerce.boolean().default(true),
        contentSecurityPolicy: zod_1.z.coerce.boolean().default(true),
        hsts: zod_1.z.coerce.boolean().default(true),
        noSniff: zod_1.z.coerce.boolean().default(true),
        frameguard: zod_1.z.coerce.boolean().default(true),
    }),
    rateLimit: zod_1.z.object({
        global: zod_1.z.object({
            enabled: zod_1.z.coerce.boolean().default(false),
            requests: zod_1.z.coerce.number().min(1).default(1000),
            window: zod_1.z.coerce.number().min(1000).default(60000),
        }),
    }),
});
exports.SecurityConfigSchema = SecurityConfigSchema;
// External Services Configuration Schema
const ExternalServicesConfigSchema = zod_1.z.object({
    stripe: zod_1.z
        .object({
        secretKey: zod_1.z.string().optional(),
        publishableKey: zod_1.z.string().optional(),
        webhookSecret: zod_1.z.string().optional(),
        apiVersion: zod_1.z.string().default("2023-10-16"),
    })
        .optional(),
    paypal: zod_1.z
        .object({
        clientId: zod_1.z.string().optional(),
        clientSecret: zod_1.z.string().optional(),
        webhookId: zod_1.z.string().optional(),
        environment: zod_1.z.enum(["sandbox", "production"]).default("sandbox"),
    })
        .optional(),
    smtp: zod_1.z
        .object({
        host: zod_1.z.string().optional(),
        port: zod_1.z.coerce.number().min(1).max(65535).default(587),
        secure: zod_1.z.coerce.boolean().default(false),
        username: zod_1.z.string().optional(),
        password: zod_1.z.string().optional(),
    })
        .optional(),
});
exports.ExternalServicesConfigSchema = ExternalServicesConfigSchema;
// Performance Configuration Schema
const PerformanceConfigSchema = zod_1.z.object({
    compression: zod_1.z.object({
        enabled: zod_1.z.coerce.boolean().default(true),
        level: zod_1.z.coerce.number().min(1).max(9).default(6),
        threshold: zod_1.z.coerce.number().min(0).default(1024),
    }),
    circuitBreaker: zod_1.z.object({
        enabled: zod_1.z.coerce.boolean().default(true),
        failureThreshold: zod_1.z.coerce.number().min(1).default(5),
        resetTimeout: zod_1.z.coerce.number().min(1000).default(60000),
        monitoringPeriod: zod_1.z.coerce.number().min(1000).default(10000),
    }),
    clustering: zod_1.z.object({
        enabled: zod_1.z.coerce.boolean().default(false),
        workers: zod_1.z.coerce.number().min(1).default(1),
    }),
});
exports.PerformanceConfigSchema = PerformanceConfigSchema;
// Main Configuration Schema
exports.ConfigSchema = zod_1.z.object({
    server: ServerConfigSchema,
    serviceDiscovery: ServiceDiscoveryConfigSchema,
    database: DatabaseConfigSchema,
    modules: ModuleDefaultsConfigSchema,
    logging: LoggingConfigSchema,
    security: SecurityConfigSchema,
    external: ExternalServicesConfigSchema,
    performance: PerformanceConfigSchema,
});
