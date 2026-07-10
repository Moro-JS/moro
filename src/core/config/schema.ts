// Core Configuration Schema for Moro Framework

import type { AppConfig } from '../../types/config.js';

// Minimal default configuration - performance-focused, most things opt-in
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3001,
    host: 'localhost',
    // 0 = unlimited. Historically defaulted to 1000/30000 but those values
    // were VALIDATED-BUT-NEVER-APPLIED to any server, so the observed behavior
    // has always been "unlimited connections, no request timeout". Now that
    // both are actually wired through, keeping 0 preserves that behavior;
    // enforcing the old numbers would silently break existing deployments.
    // A user who sets either explicitly finally gets it applied.
    maxConnections: 0,
    timeout: 0, // deprecated alias for timeouts.request; 0 = disabled
    bodySizeLimit: '10mb',
    maxUploadSize: '100mb', // Separate limit for file uploads (multipart/form-data)
    // Per-phase timeouts. keepAlive/headers were previously hardcoded in the
    // Node server (5000/6000); they become documented, overridable defaults.
    // idle/request default to 0 = the per-server default (engine: 120s idle /
    // 300s request; Node: its built-in 5min requestTimeout).
    timeouts: {
      keepAlive: 5000,
      headers: 6000,
      idle: 0,
      request: 0,
    },
    // Fine-grained limits. Only multipart carries defaults here (matching the
    // parser's previous hardcodes); header/ws/high-water limits are left unset
    // so each runtime uses its own documented default unless overridden.
    limits: {
      multipart: {
        maxParts: 1000,
        maxPartHeaderBytes: '16kb',
      },
    },
    // engine: left unset so resolution can tell "user chose it" from "default".
    // Unset resolves to 'moro' (Moro's native engine, Node.js fallback if it
    // can't load); set 'node' to disable it or 'uws' to opt into uWebSockets.js.
    useUWebSockets: false, // Deprecated alias for engine: 'uws'
    requestTracking: {
      enabled: true, // Enable by default for debugging
    },
    requestLogging: {
      // Enabled in development; disabled in production where a per-request
      // stdout write is a real throughput cost. Set explicitly to override.
      enabled: process.env.NODE_ENV !== 'production',
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
    apiPrefix: '/api/', // Default prefix for module routes - set to '' to disable
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
      allowUnknown: false,
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
      paths:
        process.env.NODE_ENV === 'production'
          ? ['./dist/modules', './dist/src/modules', './modules']
          : ['./modules', './src/modules'],
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
  // File-based auto routing: import route files under ./src/routes on startup.
  // Enabled by default; a no-op when the directory doesn't exist.
  routing: true,
  logging: {
    level: 'info',
    format: 'pretty',
    enableColors: true,
    enableTimestamp: true,
    enableContext: true,
    // Opt-in: appends JSON metadata tail in pretty logs. Off by default to avoid noise.
    enableMetadata: false,
    // Opt-in: includes (memory) perf info per log. Off by default to avoid the
    // process.memoryUsage() call and the "(210MB)" suffix.
    enablePerformance: false,
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
      secret: '',
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
  DeepPartial,
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
