// TypeScript-based Configuration Types for Moro Framework

export interface ServerConfig {
  port: number;
  host: string;
  maxConnections: number;
  timeout: number;
  bodySizeLimit: string;
  requestTracking: {
    enabled: boolean;
  };
  requestLogging: {
    enabled: boolean;
  };
  errorBoundary: {
    enabled: boolean;
  };
  useUWebSockets?: boolean; // Enable uWebSockets for both HTTP and WebSocket
  ssl?: {
    key_file_name?: string;
    cert_file_name?: string;
    passphrase?: string;
  };
}

export interface ServiceDiscoveryConfig {
  enabled: boolean;
  type: 'memory' | 'consul' | 'kubernetes';
  consulUrl: string;
  kubernetesNamespace: string;
  healthCheckInterval: number;
  retryAttempts: number;
}

export interface DatabaseConfig {
  url?: string;
  redis?: {
    url: string;
    maxRetries: number;
    retryDelay: number;
    keyPrefix: string;
  };
  mysql?: {
    host: string;
    port: number;
    database?: string;
    username?: string;
    password?: string;
    connectionLimit: number;
    acquireTimeout: number;
    timeout: number;
  };
  postgresql?: {
    host: string;
    port: number;
    database?: string;
    user?: string;
    password?: string;
    connectionLimit: number;
    ssl?: boolean;
  };
  sqlite?: {
    filename: string;
    memory?: boolean;
    verbose?: boolean;
  };
  mongodb?: {
    url?: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
  };
}

export interface ModuleDefaultsConfig {
  cache: {
    enabled: boolean;
    defaultTtl: number;
    maxSize: number;
    strategy: 'lru' | 'lfu' | 'fifo';
  };
  rateLimit: {
    enabled: boolean;
    defaultRequests: number;
    defaultWindow: number;
    skipSuccessfulRequests: boolean;
    skipFailedRequests: boolean;
  };
  validation: {
    enabled: boolean;
    stripUnknown: boolean;
    abortEarly: boolean;
  };
  autoDiscovery: {
    enabled: boolean;
    paths: string[];
    patterns: string[];
    recursive: boolean;
    loadingStrategy: 'eager' | 'lazy' | 'conditional';
    watchForChanges: boolean;
    ignorePatterns: string[];
    loadOrder: 'alphabetical' | 'dependency' | 'custom';
    failOnError: boolean;
    maxDepth: number;
  };
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  format: 'pretty' | 'json' | 'compact';
  enableColors: boolean;
  enableTimestamp: boolean;
  enableContext: boolean;
  outputs: {
    console: boolean;
    file: {
      enabled: boolean;
      path: string;
      maxSize: string;
      maxFiles: number;
    };
    webhook: {
      enabled: boolean;
      url?: string;
      headers: Record<string, string>;
    };
  };
}

export interface SecurityConfig {
  cors: {
    enabled: boolean;
    origin: string | string[] | boolean;
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };
  helmet: {
    enabled: boolean;
    contentSecurityPolicy: boolean;
    hsts: boolean;
    noSniff: boolean;
    frameguard: boolean;
  };
  rateLimit: {
    global: {
      enabled: boolean;
      requests: number;
      window: number;
    };
  };
}

export interface ExternalServicesConfig {
  stripe?: {
    secretKey?: string;
    publishableKey?: string;
    webhookSecret?: string;
    apiVersion: string;
  };
  paypal?: {
    clientId?: string;
    clientSecret?: string;
    webhookId?: string;
    environment: 'sandbox' | 'production';
  };
  smtp?: {
    host?: string;
    port: number;
    secure: boolean;
    username?: string;
    password?: string;
  };
}

export interface PerformanceConfig {
  compression: {
    enabled: boolean;
    level: number;
    threshold: number;
  };
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    resetTimeout: number;
    monitoringPeriod: number;
  };
  clustering: {
    enabled: boolean;
    workers: number | 'auto';
    memoryPerWorkerGB?: number;
  };
}

export interface WebSocketConfig {
  enabled: boolean;
  adapter?: string | 'socket.io' | 'ws' | 'uws';
  compression?: boolean;
  customIdGenerator?: () => string;
  options?: {
    cors?: {
      origin?: string | string[];
      credentials?: boolean;
    };
    path?: string;
    maxPayloadLength?: number;
    idleTimeout?: number;
    ssl?: {
      key_file_name?: string;
      cert_file_name?: string;
      passphrase?: string;
    };
  };
}

// Main configuration interface
export interface AppConfig {
  server: ServerConfig;
  serviceDiscovery: ServiceDiscoveryConfig;
  database: DatabaseConfig;
  modules: ModuleDefaultsConfig;
  logging: LoggingConfig;
  security: SecurityConfig;
  external: ExternalServicesConfig;
  performance: PerformanceConfig;
  websocket: WebSocketConfig;
}
