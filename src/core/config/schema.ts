// Core Configuration Schema for Moro Framework

import { AppConfig } from '../../types/config.js';

// Minimal default configuration - performance-focused, most things opt-in
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3001,
    host: 'localhost',
    maxConnections: 1000,
    timeout: 30000,
    bodySizeLimit: '10mb',
    maxUploadSize: '100mb', // Separate limit for file uploads (multipart/form-data)
    useUWebSockets: false, // Opt-in for high performance
    requestTracking: {
      enabled: true, // Enable by default for debugging
    },
    requestLogging: {
      enabled: true, // Enable by default - logs requests independently
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
    session: {
      enabled: false, // Opt-in
      store: 'memory',
      secret: 'moro-session-secret',
      name: 'connect.sid',
      rolling: false,
      resave: false,
      saveUninitialized: false,
      cookie: {
        maxAge: 86400000, // 24 hours in ms
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
      },
      proxy: false,
      unset: 'keep',
    },
    autoDiscovery: {
      enabled: true, // Enable by default for better DX
      paths: ['./modules', './src/modules'],
      patterns: ['**/*.module.{ts,js}', '**/index.{ts,js}', '**/*.config.{ts,js}'],
      recursive: true,
      loadingStrategy: 'eager',
      watchForChanges: false, // Opt-in for development
      ignorePatterns: ['**/*.test.{ts,js}', '**/*.spec.{ts,js}', '**/node_modules/**'],
      loadOrder: 'dependency',
      failOnError: false, // Graceful degradation
      maxDepth: 5,
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
      exposedHeaders: [],
      credentials: false,
      maxAge: 86400, // 24 hours
      preflightContinue: false,
    },
    helmet: {
      enabled: false, // Opt-in for better performance
      // Simplified options (backward compatible)
      contentSecurityPolicy: true,
      hsts: true,
      noSniff: true,
      frameguard: true,
      // Detailed options (use these for advanced configuration)
      xFrameOptions: 'DENY',
      xContentTypeOptions: true,
      xXssProtection: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      strictTransportSecurity: {
        maxAge: 31536000,
        includeSubDomains: true,
      },
      xDownloadOptions: true,
      xPermittedCrossDomainPolicies: true,
    },
    csrf: {
      enabled: false, // Opt-in
      secret: 'moro-csrf-secret',
      tokenLength: 32,
      cookieName: '_csrf',
      headerName: 'x-csrf-token',
      ignoreMethods: ['GET', 'HEAD', 'OPTIONS'],
      sameSite: true,
    },
    csp: {
      enabled: false, // Opt-in
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
      reportOnly: false,
      nonce: false,
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
} from '../../types/config.js';

// For backward compatibility with modules that expect schema objects
export const ServerConfigSchema = { parse: (data: any) => data };
export const ServiceDiscoveryConfigSchema = { parse: (data: any) => data };
export const DatabaseConfigSchema = { parse: (data: any) => data };
export const ModuleDefaultsConfigSchema = { parse: (data: any) => data };
export const LoggingConfigSchema = { parse: (data: any) => data };
export const SecurityConfigSchema = { parse: (data: any) => data };
export const ExternalServicesConfigSchema = { parse: (data: any) => data };
export const PerformanceConfigSchema = { parse: (data: any) => data };
