// TypeScript-based Configuration Types for Moro Framework

/**
 * CORS origin function type for dynamic origin validation
 */
export type OriginFunction = (
  origin: string | undefined,
  req: any
) => string | string[] | boolean | Promise<string | string[] | boolean>;

/**
 * Deep partial type that makes all properties and nested properties optional
 * Used for user-provided configuration where only partial overrides are needed
 */
export type DeepPartial<T> = T extends object
  ? T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends (...args: any[]) => any
      ? T
      : { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export interface ServerConfig {
  port: number;
  host: string;
  maxConnections: number;
  timeout: number;
  bodySizeLimit: string;
  maxUploadSize: string; // Maximum size for file uploads (multipart/form-data)
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

// Validation error context passed to error handlers
export interface ValidationErrorContext {
  request: {
    method: string;
    path: string;
    url: string;
    headers: Record<string, any>;
  };
  route?: {
    path: string;
    method: string;
  };
  field: 'body' | 'query' | 'params' | 'headers';
}

// Validation error detail structure
export interface ValidationErrorDetail {
  field: string;
  message: string;
  code?: string;
  value?: any;
  path?: (string | number)[];
}

// Validation error response structure
export interface ValidationErrorResponse {
  status: number;
  body: any;
  headers?: Record<string, string>;
}

// Validation error handler function type
export type ValidationErrorHandler = (
  errors: ValidationErrorDetail[],
  context: ValidationErrorContext
) => ValidationErrorResponse;

export interface ModuleDefaultsConfig {
  apiPrefix?: string; // Prefix for module routes, defaults to '/api/' - set to empty string '' to disable
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
    allowUnknown?: boolean;
    onError?: ValidationErrorHandler;
  };
  session?: {
    enabled: boolean;
    store: 'memory' | 'redis' | 'file';
    storeOptions?: {
      host?: string;
      port?: number;
      password?: string;
      keyPrefix?: string;
      path?: string;
      max?: number;
    };
    secret?: string;
    name?: string;
    rolling?: boolean;
    resave?: boolean;
    saveUninitialized?: boolean;
    cookie?: {
      maxAge?: number;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: 'strict' | 'lax' | 'none';
      domain?: string;
      path?: string;
    };
    proxy?: boolean;
    unset?: 'destroy' | 'keep';
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
    origin: string | string[] | boolean | OriginFunction;
    methods: string[];
    allowedHeaders: string[];
    exposedHeaders?: string[];
    credentials: boolean;
    maxAge?: number;
    preflightContinue?: boolean;
  };
  helmet: {
    enabled: boolean;
    // Simplified options (backward compatible)
    contentSecurityPolicy?: boolean;
    hsts?: boolean;
    noSniff?: boolean;
    frameguard?: boolean;
    // Detailed options (for advanced configuration)
    xFrameOptions?: 'DENY' | 'SAMEORIGIN';
    xContentTypeOptions?: boolean;
    xXssProtection?: boolean;
    referrerPolicy?: string;
    strictTransportSecurity?: { maxAge?: number; includeSubDomains?: boolean };
    xDownloadOptions?: boolean;
    xPermittedCrossDomainPolicies?: boolean;
  };
  csrf?: {
    enabled: boolean;
    secret?: string;
    tokenLength?: number;
    cookieName?: string;
    headerName?: string;
    ignoreMethods?: string[];
    sameSite?: boolean;
  };
  csp?: {
    enabled: boolean;
    directives?: {
      defaultSrc?: string[];
      scriptSrc?: string[];
      styleSrc?: string[];
      imgSrc?: string[];
      connectSrc?: string[];
      fontSrc?: string[];
      objectSrc?: string[];
      mediaSrc?: string[];
      frameSrc?: string[];
      childSrc?: string[];
      workerSrc?: string[];
      formAction?: string[];
      upgradeInsecureRequests?: boolean;
      blockAllMixedContent?: boolean;
    };
    reportOnly?: boolean;
    reportUri?: string;
    nonce?: boolean;
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

export interface JobsConfig {
  enabled?: boolean;
  maxConcurrentJobs?: number;
  gracefulShutdownTimeout?: number;
  leaderElection?: {
    enabled?: boolean;
    strategy?: 'file' | 'redis' | 'none';
    lockPath?: string;
    lockTimeout?: number;
    heartbeatInterval?: number;
  };
  executor?: {
    maxRetries?: number;
    retryDelay?: number;
    retryBackoff?: 'linear' | 'exponential';
    retryBackoffMultiplier?: number;
    maxRetryDelay?: number;
    timeout?: number;
    enableCircuitBreaker?: boolean;
    circuitBreakerThreshold?: number;
    circuitBreakerResetTimeout?: number;
    enableMemoryMonitoring?: boolean;
    memoryThreshold?: number;
  };
  stateManager?: {
    persistPath?: string;
    historySize?: number;
    persistInterval?: number;
    enableAutoPersist?: boolean;
    enableRecovery?: boolean;
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
  jobs?: JobsConfig;
  queue?: QueueConfig;
}

// Queue Configuration
export interface QueueConfig {
  adapter?: 'bull' | 'rabbitmq' | 'sqs' | 'kafka' | 'memory';
  connection?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    database?: number;
    brokers?: string[];
    groupId?: string;
    region?: string;
    queueUrl?: string;
    [key: string]: any;
  };
  concurrency?: number;
  retry?: {
    maxAttempts: number;
    backoff: 'fixed' | 'exponential' | 'linear';
    initialDelay: number;
    maxDelay?: number;
  };
  deadLetterQueue?: {
    enabled: boolean;
    maxRetries: number;
    queueName?: string;
  };
  defaultJobOptions?: {
    removeOnComplete?: boolean | number;
    removeOnFail?: boolean | number;
    attempts?: number;
    backoff?: {
      type: 'fixed' | 'exponential' | 'linear';
      delay: number;
    };
  };
  prefix?: string;
  limiter?: {
    max: number;
    duration: number;
  };
}
