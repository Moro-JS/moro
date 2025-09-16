// Core Configuration Schema for Moro Framework

import { AppConfig } from '../../types/config';

// Default configuration values
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3001,
    host: 'localhost',
    environment: 'development',
    maxConnections: 1000,
    timeout: 30000,
  },
  serviceDiscovery: {
    enabled: false,
    type: 'memory',
    consulUrl: 'http://localhost:8500',
    kubernetesNamespace: 'default',
    healthCheckInterval: 30000,
    retryAttempts: 3,
  },
  database: {
    redis: {
      url: 'redis://localhost:6379',
      maxRetries: 3,
      retryDelay: 1000,
      keyPrefix: 'moro:',
    },
  },
  modules: {
    cache: {
      enabled: true,
      defaultTtl: 300,
      maxSize: 1000,
      strategy: 'lru',
    },
    rateLimit: {
      enabled: true,
      defaultRequests: 100,
      defaultWindow: 60000,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
    },
    validation: {
      enabled: true,
      stripUnknown: true,
      abortEarly: false,
    },
  },
  logging: {
    level: 'info',
    format: 'pretty',
    enableColors: true,
    enableTimestamp: true,
    enableContext: true,
    outputs: {
      console: true,
      file: {
        enabled: false,
        path: './logs/moro.log',
        maxSize: '10MB',
        maxFiles: 5,
      },
      webhook: {
        enabled: false,
        headers: {},
      },
    },
  },
  security: {
    cors: {
      enabled: true,
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    },
    helmet: {
      enabled: true,
      contentSecurityPolicy: true,
      hsts: true,
      noSniff: true,
      frameguard: true,
    },
    rateLimit: {
      global: {
        enabled: false,
        requests: 1000,
        window: 60000,
      },
    },
  },
  external: {
    stripe: {
      apiVersion: '2023-10-16',
    },
    paypal: {
      environment: 'sandbox',
    },
    smtp: {
      port: 587,
      secure: false,
    },
  },
  performance: {
    compression: {
      enabled: true,
      level: 6,
      threshold: 1024,
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      resetTimeout: 60000,
      monitoringPeriod: 10000,
    },
    clustering: {
      enabled: false,
      workers: 1,
    },
  },
};

// Simple compatibility export - just return the config as-is
export const ConfigSchema = {
  parse: (data: any): AppConfig => data as AppConfig,
};

// Re-export types for backward compatibility
export type {
  AppConfig,
  ServerConfig,
  ServiceDiscoveryConfig,
  DatabaseConfig,
  ModuleDefaultsConfig,
  LoggingConfig,
  SecurityConfig,
  ExternalServicesConfig,
  PerformanceConfig,
} from '../../types/config';

// For backward compatibility with modules that expect schema objects
export const ServerConfigSchema = { parse: (data: any) => data };
export const ServiceDiscoveryConfigSchema = { parse: (data: any) => data };
export const DatabaseConfigSchema = { parse: (data: any) => data };
export const ModuleDefaultsConfigSchema = { parse: (data: any) => data };
export const LoggingConfigSchema = { parse: (data: any) => data };
export const SecurityConfigSchema = { parse: (data: any) => data };
export const ExternalServicesConfigSchema = { parse: (data: any) => data };
export const PerformanceConfigSchema = { parse: (data: any) => data };
