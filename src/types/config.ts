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

/** Unified SSL/TLS config (superset of both historical shapes). */
export interface SSLConfig {
  /** File-path shape (uWS-style; keyFile/certFile also accepted) */
  key_file_name?: string;
  cert_file_name?: string;
  ca_file_name?: string | string[];
  keyFile?: string;
  certFile?: string;
  caFile?: string | string[];
  /** Inline-PEM shape (node-style) */
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer | Array<string | Buffer>;
  passphrase?: string;
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
}

/** Per-phase receive timeouts. 0 = use the per-server default / disabled. */
export interface ServerTimeoutsConfig {
  /** Full-request receive budget (ms); does NOT reset on activity. */
  request?: number;
  /** Socket inactivity timeout (ms). */
  idle?: number;
  /** Node keep-alive socket timeout (ms). Default 5000. */
  keepAlive?: number;
  /** Node headers-received timeout (ms). Default 6000. */
  headers?: number;
}

export interface MultipartLimitsConfig {
  maxParts?: number;
  maxPartHeaderBytes?: number | string;
  maxFiles?: number;
  maxFileSize?: number | string;
}

/** Fine-grained limits; every value is a documented default, not a hard cap. */
export interface ServerLimitsConfig {
  /** Max request head (request line + headers) size. Node maxHeaderSize / engine maxHeadSize. */
  maxHeaderSize?: number | string;
  /** Max header count. Node maxHeadersCount / engine maxHeaders. */
  maxHeaders?: number;
  multipart?: MultipartLimitsConfig;
  /** Reassembled WebSocket message cap (engine wsMaxMessageSize). */
  wsMaxMessageSize?: number | string;
  /** WebSocket send backpressure cap (engine wsBackpressureLimit). 0 = unlimited. */
  wsBackpressureLimit?: number | string;
  /** Write-queue high-water mark (engine writeHighWaterMark). */
  writeHighWaterMark?: number | string;
  /** Per-connection not-yet-parsed backlog cap (engine maxPendingBytes). */
  maxPendingBytes?: number | string;
}

export interface Http2SettingsConfig {
  maxConcurrentStreams?: number;
  initialWindowSize?: number;
  maxFrameSize?: number;
  maxHeaderListSize?: number;
  headerTableSize?: number;
  enablePush?: boolean;
  enableConnectProtocol?: boolean;
  maxHeaderSize?: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  maxConnections: number;
  /** @deprecated Use timeouts.request. Kept as an alias; still honored. */
  timeout: number;
  bodySizeLimit: string;
  maxUploadSize: string; // Maximum size for file uploads (multipart/form-data)
  /** Per-phase receive timeouts (finally applied to every runtime). */
  timeouts?: ServerTimeoutsConfig;
  /** Fine-grained size/count limits, passed through to whichever runtime serves. */
  limits?: ServerLimitsConfig;
  /** TCP listen backlog. */
  backlog?: number;
  /** HTTP/2: true, or an options object. Served natively by the engine when
   *  it supports h2 (feature-detected), else by the Node http2 server. */
  http2?:
    | boolean
    | { allowHTTP1?: boolean; maxSessionMemory?: number; settings?: Http2SettingsConfig };
  requestTracking: {
    enabled: boolean;
  };
  requestLogging: {
    enabled: boolean;
  };
  errorBoundary: {
    enabled: boolean;
  };
  /**
   * HTTP engine selection. Default: 'moro'.
   * - 'moro' (default): Moro's own native engine (@morojs/engine), falling back
   *   to the Node.js http server if it cannot load on this platform/Node ABI
   * - 'node': the Node.js http server (no native engine)
   * - 'uws': opt in to uWebSockets.js, falling back to Node.js if it cannot load
   * Any chosen engine that cannot load degrades to Node.js and logs why; the app
   * never fails to boot. Inspect what actually booted via app.engine.
   */
  engine?: 'moro' | 'node' | 'uws';
  /** @deprecated Use engine: 'uws' instead. Enable uWebSockets for both HTTP and WebSocket */
  useUWebSockets?: boolean;
  /** Unified SSL/TLS config; flows to whichever runtime serves. */
  ssl?: SSLConfig;
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
  // Opt-in: appends a JSON metadata object (e.g. {"framework":"moro",...}) to pretty log lines.
  // Has no effect on 'json' format - structured output always includes metadata.
  enableMetadata: boolean;
  // Opt-in: collects and renders per-log performance data such as memory usage (e.g. "(210MB)").
  // Disabling skips the process.memoryUsage() call on every log line.
  enablePerformance: boolean;
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
    secretKey?: string | undefined;
    publishableKey?: string | undefined;
    webhookSecret?: string | undefined;
    apiVersion: string;
  };
  paypal?: {
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    webhookId?: string | undefined;
    environment: 'sandbox' | 'production';
  };
  smtp?: {
    host?: string | undefined;
    port: number;
    secure: boolean;
    username?: string | undefined;
    password?: string | undefined;
  };
}

export interface PerformanceConfig {
  compression: {
    enabled: boolean;
    level: number;
    threshold: number;
    /** Encoding preference order (default ['br','gzip','deflate']). */
    encodings?: Array<'br' | 'gzip' | 'deflate'>;
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
    memoryPerWorkerGB?: number | undefined;
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

// File-based routing configuration. When enabled, route files under the
// configured directories are imported during startup (after module discovery)
// so their `getApp().get(...)` registrations execute automatically.
export interface RoutingConfig {
  enabled: boolean;
  // Directories scanned via loadRoutes(). Defaults to ./src/routes in
  // development and ./dist/(src/)routes in production when omitted.
  paths?: string[];
}

// Main configuration interface
export interface AppConfig {
  server: ServerConfig;
  serviceDiscovery: ServiceDiscoveryConfig;
  database: DatabaseConfig;
  modules: ModuleDefaultsConfig;
  // Enable file-based auto routing (./src/routes). Defaults to true.
  routing: boolean | RoutingConfig;
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
