// TypeScript-based Configuration Types for Moro Framework

/**
 * CORS origin function type for dynamic origin validation
 */
export type OriginFunction = (
  origin: string | undefined,
  req: any
) =>
  | string
  | string[]
  | boolean
  | null
  | undefined
  | Promise<string | string[] | boolean | null | undefined>;

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
  /** File-path shape (keyFile/certFile also accepted) */
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
  /** Ask the client for a certificate (mutual TLS). */
  requestCert?: boolean;
  /** Refuse a client whose certificate does not verify against `ca`. */
  rejectUnauthorized?: boolean;
  /**
   * Handshake policy. Each key means what it means to Node's
   * `tls.createSecureContext()` and is applied by the Node.js HTTPS server
   * and the HTTP/2 server as written. The native engine applies `ciphers`
   * and `ecdhCurve`; `maxVersion`, `honorCipherOrder`, `sigalgs` and `crl`
   * have no engine equivalent and are named in a start-up warning when set
   * on it.
   */
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Cipher list; names starting with `TLS_` select the TLS 1.3 suites. */
  ciphers?: string;
  /** Prefer the server's cipher order over the client's. */
  honorCipherOrder?: boolean;
  /** Key-exchange groups, e.g. `'X25519:P-256'`. */
  ecdhCurve?: string;
  /** Signature algorithms, colon-separated. */
  sigalgs?: string;
  /** Certificate revocation list(s), PEM. */
  crl?: string | Buffer | Array<string | Buffer>;
  /**
   * Which TLS library the native engine terminates TLS with. Default: 'auto'.
   *
   * - 'boringssl': BoringSSL, bundled with @morojs/engine and updated with it.
   * - 'openssl': the OpenSSL of the running Node.js - for FIPS mode, OpenSSL
   *   providers or engines, or a system crypto policy.
   * - 'auto': BoringSSL, unless Node's OpenSSL is specially configured
   *   (--enable-fips, --openssl-config and its relatives, OPENSSL_CONF, FIPS
   *   mode on), in which case OpenSSL.
   *
   * The choice is per process: the first app to start decides. The environment
   * variable MORO_ENGINE_TLS sets it without a code change. `app.engine.tls`
   * reports what is in use. Needs @morojs/engine 1.1.20 or later; older
   * engines and the Node.js server have one TLS library and ignore this.
   */
  library?: 'boringssl' | 'openssl' | 'auto';
  /**
   * Reload the certificate when the key/cert files change on disk (file-path
   * shape only; `true` = 1000 ms debounce). Equivalent to calling
   * `app.reloadTLS()` after each change.
   */
  watch?: boolean | { debounceMs?: number };
}

/** Per-phase receive timeouts (ms). An explicit 0 disables that timeout. */
export interface ServerTimeoutsConfig {
  /**
   * How long a client may take to deliver one complete request, headers and
   * body, from its first byte (ms); does NOT reset on activity. It bounds
   * receiving the request, not the handler that answers it. Default 300000
   * (5 minutes). On the Node.js server 0 leaves Node's own 300 s in place.
   */
  request?: number;
  /**
   * How long a connection may stay open with nothing arriving (ms). Unset:
   * 75000 on the HTTP/2 server and on a native engine that leaves a
   * connection alone while a response is still being delivered to it
   * (`@morojs/engine` after 1.1.21), where a connection with a request in
   * progress is not idle; no idle timeout on an older engine, which would
   * also close a slow client in the middle of a response written in one
   * piece; no socket idle timeout on the Node.js HTTP/1 server, where
   * `keepAlive` closes an idle connection and a value here also cuts a
   * handler or stream that is silent for that long. A value set here is
   * applied as given on every server.
   */
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

export interface FormLimitsConfig {
  /**
   * How many fields one `application/x-www-form-urlencoded` body may have.
   * Default 1000. A body with more is answered 413 before any of it is
   * decoded: the body size limit alone lets a body of 100,000 one-byte
   * fields through, and decoding it costs tens of milliseconds of CPU. The
   * fields are counted by their `&` separators, so an empty one (`a=1&&b=2`,
   * a trailing `&`) counts. Applied by the native engine, the Node.js server
   * and the HTTP/2 server alike; multipart forms have `multipart.maxParts`.
   */
  maxFields?: number;
}

/** Fine-grained limits; every value is a documented default, not a hard cap. */
export interface ServerLimitsConfig {
  /** Max request head (request line + headers) size. Node maxHeaderSize / engine maxHeadSize. */
  maxHeaderSize?: number | string;
  /** Max header count. Node maxHeadersCount / engine maxHeaders. */
  maxHeaders?: number;
  multipart?: MultipartLimitsConfig;
  /** `application/x-www-form-urlencoded` bodies: the cap on their fields. */
  form?: FormLimitsConfig;
  /** Reassembled WebSocket message cap (engine wsMaxMessageSize). */
  wsMaxMessageSize?: number | string;
  /** WebSocket send backpressure cap (engine wsBackpressureLimit). 0 = unlimited. */
  wsBackpressureLimit?: number | string;
  /** Write-queue high-water mark (engine writeHighWaterMark). */
  writeHighWaterMark?: number | string;
  /** Per-connection not-yet-parsed backlog cap (engine maxPendingBytes). */
  maxPendingBytes?: number | string;
  /**
   * How many bytes of responses one connection may have queued and not yet
   * sent before the native engine closes it (engine
   * responseBackpressureLimit). A response written in one piece is queued
   * whole while the client reads it, so this must be larger than the largest
   * such response. Unset or 0: no limit; a queue that makes no progress for
   * 300 s is closed by the engine either way. Native engine only.
   */
  responseBackpressureLimit?: number | string;
  /**
   * Take a request whose path or query holds bytes of 0x80 and above (UTF-8
   * sent without percent-encoding) and hand them to the application
   * undecoded, as every release before 1.9.1 did. By default such a request
   * is answered 400 by the native engine: a request-target is ASCII (RFC
   * 3986), browsers and HTTP libraries percent-encode what is not, and raw
   * high bytes are where an overlong UTF-8 form of `/` or `.` gets past a
   * path check that runs before decoding. Native engine only (engine 1.2.2
   * or later); the Node server takes such bytes either way.
   */
  allowNonAsciiTarget?: boolean;
  /**
   * How many bytes the process may hold in buffers for its peers, across all
   * connections together (engine memoryBudget): request bodies still
   * arriving, WebSocket messages being reassembled, and response bytes
   * clients have not read yet. A size string ('2gb') or a number of bytes;
   * `false` for no budget. Unset or 0: the engine sets its own, an eighth of
   * the memory the process may use (its cgroup limit where there is one).
   *
   * Every other limit bounds one connection, so many connections that each
   * stay within theirs can still hold more memory than the machine has. Over
   * the budget, the connection that needs more room is closed: an HTTP/1
   * request still arriving is answered 503, a WebSocket message being
   * reassembled closes its socket with code 1013, an HTTP/2 connection gets
   * GOAWAY. A request of up to 16 KiB is never refused for the budget, so
   * small requests and health checks are served while it is full.
   *
   * The budget is shared out among the threads that serve, and the engine
   * never sets a thread's share below the largest single message it
   * accepts (the larger of maxUploadSize and bodySizeLimit, or
   * wsMaxMessageSize when that is larger still), so a budget smaller than
   * that is raised to it. Native engine only, on a
   * `@morojs/engine` that reports `capabilities.bufferBudget`; an older
   * engine and the Node.js server keep no such budget and ignore this.
   */
  memoryBudget?: number | string | false;
}

export interface Http2SettingsConfig {
  maxConcurrentStreams?: number;
  initialWindowSize?: number;
  maxFrameSize?: number;
  maxHeaderListSize?: number;
  headerTableSize?: number;
  /** Accepted for compatibility but never sent: RFC 9113 forbids a server from advertising ENABLE_PUSH=1 (clients drop the connection), and whether push is possible is the client's setting, read per stream. */
  enablePush?: boolean;
  enableConnectProtocol?: boolean;
  maxHeaderSize?: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  maxConnections: number;
  /**
   * @deprecated Use timeouts.request. A value above 0 is applied as the
   * request timeout when timeouts.request is not given, with a start-up
   * warning that names the new key.
   */
  timeout: number;
  /** Largest request body: a size string ('10mb', '512kb') or a number of bytes. */
  bodySizeLimit: string | number;
  /** Largest multipart/form-data upload: a size string or a number of bytes. */
  maxUploadSize: string | number;
  /**
   * Drain in-flight work and close on SIGINT/SIGTERM. Default: true. Set false
   * when the host application owns the process signals.
   */
  gracefulShutdown?: boolean;
  /**
   * Also drain and exit(1) on an uncaught exception or unhandled rejection.
   * Default: false.
   */
  handleUncaught?: boolean;
  /** Per-phase receive timeouts (finally applied to every runtime). */
  timeouts?: ServerTimeoutsConfig;
  /** Fine-grained size/count limits, passed through to whichever runtime serves. */
  limits?: ServerLimitsConfig;
  /** TCP listen backlog. */
  backlog?: number;
  /** HTTP/2: true, or an options object. Served natively by the engine when
   *  it supports h2 (feature-detected), else by the Node http2 server. */
  http2?:
    boolean | { allowHTTP1?: boolean; maxSessionMemory?: number; settings?: Http2SettingsConfig };
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
   * An engine that cannot load degrades to Node.js and logs why; the app never
   * fails to boot. Inspect what actually booted via app.engine.
   *
   * 'uws' selected uWebSockets.js, which was removed in 1.8.24. The value is
   * still accepted so existing configurations keep working: such an app runs
   * on the Moro engine and logs a warning. Remove it.
   */
  engine?: 'moro' | 'node' | 'uws';
  /** @deprecated uWebSockets.js was removed in 1.8.24. Still accepted; `true`
   *  runs the app on the Moro engine (the default) with a warning. Remove it. */
  useUWebSockets?: boolean;
  /** Unified SSL/TLS config; flows to whichever runtime serves. */
  ssl?: SSLConfig;
  /**
   * Which proxies in front of the app are trusted to say who the client is
   * (`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`). Same
   * meaning as Express's `trust proxy`:
   *
   * - `false`: none. `req.ip` is the connected peer, `req.ips` is empty,
   *   `req.protocol` / `req.secure` describe the connection itself and
   *   `req.hostname` comes from `Host`.
   * - `true`: every hop. `req.ip` is the left-most `X-Forwarded-For` entry.
   *   Only safe when the proxy replaces that header instead of appending.
   * - a number: that many hops, counted from this server (`1` = the proxy
   *   connected to the app).
   * - an address, a CIDR range, `'loopback'`, `'linklocal'`,
   *   `'uniquelocal'`, or a list of them (an array or one comma-separated
   *   string): a hop is trusted when its address is in the list.
   *
   * Not set (the default): as before this setting existed. `req.ip` is the
   * connected peer, while `req.ips`, `req.protocol` and `req.secure` read
   * `X-Forwarded-For` / `X-Forwarded-Proto` from any client.
   */
  trustProxy?: boolean | number | string | string[];
  /**
   * Lend binary request bodies instead of handing them over. Default: false.
   *
   * A body the framework does not parse (anything that is not JSON, a form,
   * text or multipart) arrives as a Buffer in `req.body`. With this on, that
   * Buffer is a view over the native engine's own copy of the bytes: nothing
   * is allocated or copied for it, and it is valid until the response has
   * been sent. After that it is empty (length 0). Meant for services that
   * relay, hash, store or echo a body while answering and keep none of it;
   * a handler that keeps the body for later must copy it
   * (`Buffer.from(req.body)`) before responding. The same applies to an
   * asynchronous write of the body that may still be running when the
   * response is sent (`fs.write`, a socket or stream write): Node reads the
   * bytes when the write happens, and by then they can be the next
   * request's body. Wait for such a write before responding, or copy first.
   *
   * Parsed bodies (JSON, forms, text, multipart) and `req.rawBody` for them
   * are not affected. Honoured by the native engine (@morojs/engine 1.1.19+);
   * every other server ignores it and keeps handing the body over.
   */
  lendBodies?: boolean;
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
      url?: string;
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
  // Mask values under sensitive keys in logged metadata. Unset: on wherever the
  // console prints metadata ('json', and 'pretty' with enableMetadata). true /
  // false force it; an array turns it on and adds key names.
  redact?: boolean | string[];
  // Print control characters in logged values as visible escapes in the
  // 'pretty' and 'compact' formats. Default: true.
  escapeControlChars?: boolean;
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
    /**
     * Bodies at or below this size are compressed on the calling thread and
     * sent with a Content-Length; larger ones are compressed on the
     * threadpool and streamed. 0 sends every body through the pool.
     * Default 16384.
     */
    maxInlineBytes?: number;
    /** zlib options for gzip/deflate; a `level` here wins over the shared level. */
    gzip?: import('zlib').ZlibOptions;
    /** brotli options; a quality under `params` wins over the one the shared level maps to. */
    brotli?: import('zlib').BrotliOptions;
    /** Keep one gzip encoder per setting and reset it between bodies (default true). */
    reuseEncoders?: boolean;
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
  /** 'socket.io' or 'ws' (both serve from the Node.js server). Unset, the
   *  native engine serves WebSockets itself. 'uws' (uWebSockets.js, removed in
   *  1.8.24) is still accepted and means the same as unset. */
  adapter?: string | 'socket.io' | 'ws';
  /** `true`: permessage-deflate with every client that offers it, on every
   *  adapter. What such a client sends is inflated, a message of 1024 bytes
   *  or more sent to it is compressed, and the adapter's message limit also
   *  bounds a message once inflated. Unset or `false`: messages are sent
   *  uncompressed. Read when the app is created. */
  compression?: boolean;
  customIdGenerator?: () => string;
  options?: {
    cors?: {
      origin?: string | string[];
      credentials?: boolean;
    };
    path?: string;
    maxPayloadLength?: number;
    /**
     * Socket.IO and native engine adapters: whether a handshake whose Origin
     * is not allowed by `cors.origin`, or that `verifyClient` rejects, is
     * refused. On by default whenever one of the two is configured. `false`
     * turns the refusal into a logged warning: the handshake is reported and
     * let through.
     */
    enforceHandshakeChecks?: boolean;
    /**
     * Decides whether a handshake may proceed: a falsy verdict, a throw or a
     * rejection refuses it. Returns its verdict or a promise of it.
     */
    verifyClient?: (...args: any[]) => any;
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
    /**
     * The connected Redis client the 'redis' strategy takes its lock with
     * (ioredis, or a node-redis client). Required for that strategy: without
     * it no instance can become leader and no scheduled job runs. Only
     * createApp() can carry it; a config file should not open connections.
     */
    redisClient?: any;
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
  /**
   * The strict contract for route and module middleware. Off by default: a
   * route's middleware is done when it returns (or the promise it returns
   * settles), and the request goes on to the handler whether or not it
   * called next(). When true, a middleware declared with three parameters,
   * (req, res, next), passes the request on only by calling next(); one that
   * finishes without calling it and without answering gets the request a 500
   * and a line in the error log. Two-parameter middleware and app.use()
   * middleware are not affected.
   */
  strictMiddleware?: boolean;
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
