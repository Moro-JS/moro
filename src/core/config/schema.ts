// Core Configuration Schema for Moro Framework

import { AppConfig } from '../../types/config';

// Minimal default configuration - performance-focused, most things opt-in
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3001,
    host: 'localhost',
    maxConnections: 1000,
    timeout: 30000,
    bodySizeLimit: '10mb',
    requestTracking: {
      enabled: true, // Enable by default for debugging
    },
    errorBoundary: {
      enabled: true, // Always enabled for safety
    },
  },
  serviceDiscovery: {
    enabled: false,
    type: 'memory',
    consulUrl: 'http://localhost:8500',
    kubernetesNamespace: 'default',
    healthCheckInterval: 30000,
    retryAttempts: 3,
  },
  database: {},
  modules: {
    cache: {
      enabled: false, // Opt-in for better performance
      defaultTtl: 300,
      maxSize: 1000,
      strategy: 'lru',
    },
    rateLimit: {
      enabled: false, // Opt-in to avoid unnecessary overhead
      defaultRequests: 100,
      defaultWindow: 60000,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
    },
    validation: {
      enabled: false,
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
      enabled: false, // Opt-in for better performance
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: false,
    },
    helmet: {
      enabled: false, // Opt-in for better performance
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
  external: {},
  performance: {
    compression: {
      enabled: false, // Opt-in to avoid overhead
      level: 6,
      threshold: 1024,
    },
    circuitBreaker: {
      enabled: false, // Opt-in to avoid overhead
      failureThreshold: 5,
      resetTimeout: 60000,
      monitoringPeriod: 10000,
    },
    clustering: {
      enabled: false,
      workers: 1,
      memoryPerWorkerGB: undefined,
    },
  },
  websocket: {
    enabled: false, // Opt-in - user must explicitly enable WebSockets
  },
};

// Schema validation is now handled by config-validator.ts
// This export is kept for backward compatibility only
// Note: For actual validation, use validateConfig() from config-validator.ts directly
export const ConfigSchema = {
  parse: (data: any): AppConfig => {
    // Simple pass-through for backward compatibility
    // Real validation happens in the config loading pipeline
    return data as AppConfig;
  },
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
