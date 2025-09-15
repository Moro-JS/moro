// Core Configuration Schema for Moro Framework
import { z } from 'zod';

// Server Configuration Schema
const ServerConfigSchema = z.object({
  port: z.coerce
    .number()
    .min(1, 'Port must be at least 1')
    .max(65535, 'Port must be at most 65535')
    .default(3001)
    .describe('Server port to listen on'),

  host: z.string().default('localhost').describe('Server host to bind to'),

  environment: z
    .enum(['development', 'staging', 'production'])
    .default('development')
    .describe('Application environment'),

  maxConnections: z.coerce.number().min(1).default(1000).describe('Maximum concurrent connections'),

  timeout: z.coerce.number().min(1000).default(30000).describe('Request timeout in milliseconds'),
});

// Service Discovery Configuration Schema
const ServiceDiscoveryConfigSchema = z.object({
  enabled: z.coerce.boolean().default(false).describe('Enable service discovery'),

  type: z
    .enum(['memory', 'consul', 'kubernetes'])
    .default('memory')
    .describe('Service discovery backend type'),

  consulUrl: z
    .string()
    .url('Must be a valid URL')
    .default('http://localhost:8500')
    .describe('Consul server URL'),

  kubernetesNamespace: z
    .string()
    .default('default')
    .describe('Kubernetes namespace for service discovery'),

  healthCheckInterval: z.coerce
    .number()
    .min(1000)
    .default(30000)
    .describe('Health check interval in milliseconds'),

  retryAttempts: z.coerce
    .number()
    .min(0)
    .default(3)
    .describe('Number of retry attempts for failed health checks'),
});

// Database Configuration Schema
const DatabaseConfigSchema = z.object({
  url: z.string().optional().describe('Primary database connection URL'),

  redis: z.object({
    url: z.string().default('redis://localhost:6379').describe('Redis connection URL'),

    maxRetries: z.coerce
      .number()
      .min(0)
      .default(3)
      .describe('Maximum Redis connection retry attempts'),

    retryDelay: z.coerce
      .number()
      .min(100)
      .default(1000)
      .describe('Redis retry delay in milliseconds'),

    keyPrefix: z.string().default('moro:').describe('Redis key prefix'),
  }),

  mysql: z
    .object({
      host: z.string().default('localhost'),
      port: z.coerce.number().min(1).max(65535).default(3306),
      database: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      connectionLimit: z.coerce.number().min(1).default(10),
      acquireTimeout: z.coerce.number().min(1000).default(60000),
      timeout: z.coerce.number().min(1000).default(60000),
    })
    .optional(),
});

// Module Defaults Configuration Schema
const ModuleDefaultsConfigSchema = z.object({
  cache: z.object({
    enabled: z.coerce.boolean().default(true).describe('Enable caching by default'),

    defaultTtl: z.coerce.number().min(0).default(300).describe('Default cache TTL in seconds'),

    maxSize: z.coerce.number().min(1).default(1000).describe('Maximum cache entries'),

    strategy: z.enum(['lru', 'lfu', 'fifo']).default('lru').describe('Cache eviction strategy'),
  }),

  rateLimit: z.object({
    enabled: z.coerce.boolean().default(true).describe('Enable rate limiting by default'),

    defaultRequests: z.coerce.number().min(1).default(100).describe('Default requests per window'),

    defaultWindow: z.coerce
      .number()
      .min(1000)
      .default(60000)
      .describe('Default rate limit window in milliseconds'),

    skipSuccessfulRequests: z.coerce
      .boolean()
      .default(false)
      .describe('Skip successful requests in rate limit counting'),

    skipFailedRequests: z.coerce
      .boolean()
      .default(false)
      .describe('Skip failed requests in rate limit counting'),
  }),

  validation: z.object({
    enabled: z.coerce.boolean().default(true).describe('Enable validation by default'),

    stripUnknown: z.coerce
      .boolean()
      .default(true)
      .describe('Strip unknown properties from validated data'),

    abortEarly: z.coerce.boolean().default(false).describe('Stop validation on first error'),
  }),
});

// Logging Configuration Schema
const LoggingConfigSchema = z.object({
  level: z
    .enum(['debug', 'info', 'warn', 'error', 'fatal'])
    .default('info')
    .describe('Minimum log level'),

  format: z.enum(['pretty', 'json', 'compact']).default('pretty').describe('Log output format'),

  enableColors: z.coerce.boolean().default(true).describe('Enable colored log output'),

  enableTimestamp: z.coerce.boolean().default(true).describe('Include timestamp in logs'),

  enableContext: z.coerce.boolean().default(true).describe('Include context information in logs'),

  outputs: z.object({
    console: z.coerce.boolean().default(true),
    file: z.object({
      enabled: z.coerce.boolean().default(false),
      path: z.string().default('./logs/moro.log'),
      maxSize: z.string().default('10MB'),
      maxFiles: z.coerce.number().default(5),
    }),
    webhook: z.object({
      enabled: z.coerce.boolean().default(false),
      url: z.string().url().optional(),
      headers: z.record(z.string(), z.string()).default({}),
    }),
  }),
});

// Security Configuration Schema
const SecurityConfigSchema = z.object({
  cors: z.object({
    enabled: z.coerce.boolean().default(true),
    origin: z.union([z.string(), z.array(z.string()), z.boolean()]).default('*'),
    methods: z.array(z.string()).default(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']),
    allowedHeaders: z.array(z.string()).default(['Content-Type', 'Authorization']),
    credentials: z.coerce.boolean().default(false),
  }),

  helmet: z.object({
    enabled: z.coerce.boolean().default(true),
    contentSecurityPolicy: z.coerce.boolean().default(true),
    hsts: z.coerce.boolean().default(true),
    noSniff: z.coerce.boolean().default(true),
    frameguard: z.coerce.boolean().default(true),
  }),

  rateLimit: z.object({
    global: z.object({
      enabled: z.coerce.boolean().default(false),
      requests: z.coerce.number().min(1).default(1000),
      window: z.coerce.number().min(1000).default(60000),
    }),
  }),
});

// External Services Configuration Schema
const ExternalServicesConfigSchema = z.object({
  stripe: z
    .object({
      secretKey: z.string().optional(),
      publishableKey: z.string().optional(),
      webhookSecret: z.string().optional(),
      apiVersion: z.string().default('2023-10-16'),
    })
    .optional(),

  paypal: z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      webhookId: z.string().optional(),
      environment: z.enum(['sandbox', 'production']).default('sandbox'),
    })
    .optional(),

  smtp: z
    .object({
      host: z.string().optional(),
      port: z.coerce.number().min(1).max(65535).default(587),
      secure: z.coerce.boolean().default(false),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
});

// Performance Configuration Schema
const PerformanceConfigSchema = z.object({
  compression: z.object({
    enabled: z.coerce.boolean().default(true),
    level: z.coerce.number().min(1).max(9).default(6),
    threshold: z.coerce.number().min(0).default(1024),
  }),

  circuitBreaker: z.object({
    enabled: z.coerce.boolean().default(true),
    failureThreshold: z.coerce.number().min(1).default(5),
    resetTimeout: z.coerce.number().min(1000).default(60000),
    monitoringPeriod: z.coerce.number().min(1000).default(10000),
  }),

  clustering: z.object({
    enabled: z.coerce.boolean().default(false),
    workers: z.union([z.coerce.number().min(1), z.literal('auto')]).default(1),
  }),
});

// Main Configuration Schema
export const ConfigSchema = z.object({
  server: ServerConfigSchema,
  serviceDiscovery: ServiceDiscoveryConfigSchema,
  database: DatabaseConfigSchema,
  modules: ModuleDefaultsConfigSchema,
  logging: LoggingConfigSchema,
  security: SecurityConfigSchema,
  external: ExternalServicesConfigSchema,
  performance: PerformanceConfigSchema,
});

// Inferred TypeScript types
export type AppConfig = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServiceDiscoveryConfig = z.infer<typeof ServiceDiscoveryConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type ModuleDefaultsConfig = z.infer<typeof ModuleDefaultsConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type ExternalServicesConfig = z.infer<typeof ExternalServicesConfigSchema>;
export type PerformanceConfig = z.infer<typeof PerformanceConfigSchema>;

// Export individual schemas for module-specific configuration
export {
  ServerConfigSchema,
  ServiceDiscoveryConfigSchema,
  DatabaseConfigSchema,
  ModuleDefaultsConfigSchema,
  LoggingConfigSchema,
  SecurityConfigSchema,
  ExternalServicesConfigSchema,
  PerformanceConfigSchema,
};
