// Moro Framework - Modern TypeScript API Framework
// Built for developers who demand performance, elegance, and zero compromises
// Event-driven • Modular • Enterprise-ready • Developer-first
import { Moro as MoroCore } from './core/framework.js';
import type { WebSocketNamespaceOptions } from './core/networking/websocket-adapter.js';
import type { SSLConfigInput } from './core/http/utils/ssl-config.js';
import { HttpRequest, HttpResponse } from './core/http/index.js';
import type { Middleware } from './types/http.js';
import { clearRepresentationHeaders } from './core/http/utils/response-headers.js';
import { ModuleConfig, InternalRouteDefinition } from './types/module.js';
import { MoroOptions } from './types/core.js';
import { ModuleDefaultsConfig } from './types/config.js';
import { MoroEventBus } from './core/events/index.js';
import { createFrameworkLogger, applyLoggingConfiguration } from './core/logger/index.js';
import { Logger } from './types/logger.js';
import { MiddlewareManager, MIDDLEWARE_FACTORY } from './core/middleware/index.js';
import { IntelligentRoutingManager } from './core/routing/app-integration.js';
import { RouteSchema, StaticBody, type ParamEcho } from './core/routing/index.js';
import {
  UnifiedRouter,
  RouteBuilder as UnifiedRouteBuilder,
  warnUncalledGuard,
} from './core/routing/unified-router.js';
import { PathMatcher, LITERAL_DOT, hasExtendedSyntax } from './core/routing/path-matcher.js';
import { AppDocumentationManager, DocsConfig } from './core/docs/index.js';
import { EventEmitter } from 'events';
import { requireBuiltin } from './core/utilities/builtin.js';

// node:cluster (it drags in child_process, dgram and net) is loaded only when
// process clustering actually runs; worker_threads only on the clustering
// path. See core/utilities/builtin.ts.
const nodeCluster = () => requireBuiltin<(typeof import('cluster'))['default']>('cluster');
const wt = () => requireBuiltin<typeof import('worker_threads')>('worker_threads');
import {
  ThreadClusterPrimary,
  ThreadClusterWorker,
  computeWorkerCount,
  isUserTunedYoungGen,
  nextRestartDelay,
  resolveClusterTransport,
  threadWorkerInfo,
  YOUNG_GEN_MB_FOR_SEMI_SPACE_4,
  type RestartState,
  type ThreadWorkerInfo,
} from './core/cluster/thread-cluster.js';
import { buildModuleBasePath } from './core/utilities/module-path.js';
import { logErrorLines } from './core/utilities/log-error-lines.js';
import {
  engineBinaryNote,
  filePathToImportURL,
  isPackageAvailable,
  loadNativeEngine,
} from './core/utilities/package-utils.js';
// Configuration System Integration
import { createAppConfig, createAppConfigAsync, type AppConfig } from './core/config/index.js';
// Runtime System Integration
import { RuntimeAdapter, RuntimeType, createRuntimeAdapter } from './core/runtime/index.js';
import { runGlobalMiddleware } from './core/runtime/base-adapter.js';
// Job System Integration
import {
  JobScheduler,
  JobSchedulerOptions,
  JobHealthChecker,
  everyInterval,
  cronSchedule,
} from './core/jobs/index.js';
import type {
  JobSchedule,
  JobOptions,
  SimpleJobOptions,
  JobFunction,
  JobMetrics,
  SchedulerStats,
  JobHealth,
  LeaderElectionOptions,
} from './core/jobs/index.js';
// Worker Threads Integration (optional - lazy loaded when needed)
import {
  WorkerThreadsFacade,
  setConfiguredWorkerPoolOptions,
  type WorkerTask,
} from './core/workers/index.js';
// GraphQL System Integration (lazy loaded)
import type { GraphQLOptions } from './core/graphql/types.js';
// gRPC System Integration (lazy loaded)
import type {
  GrpcOptions,
  ServiceImplementation,
  GrpcClient,
  GrpcClientOptions,
} from './core/grpc/types.js';
// Built-in middleware integration
// Mail System Integration (lazy loaded)
import type { MailConfig, MailOptions, MailResult } from './core/mail/types.js';

// Lazy imports for GraphQL to avoid crashes when not installed
let GraphQLCore: any;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let GraphQLSubscriptionManager: any;
let setupGraphQLSubscriptions: any;

/**
 * Route group — prefixes all registered paths with a common base path.
 *
 * @example
 * app.group('/api/v1', (group) => {
 *   group.get('/users').handler(getUsersHandler);
 *   group.post('/users').handler(createUserHandler);
 *   group.get('/users/:id').handler(getUserHandler);
 * });
 */
export class RouteGroup {
  private prefix: string;
  private app: Moro;

  constructor(prefix: string, app: Moro) {
    this.prefix = prefix;
    this.app = app;
  }

  private prefixPath(path: string): string {
    if (path === '/' || path === '') return this.prefix;
    return this.prefix + (path.startsWith('/') ? path : `/${path}`);
  }

  get(path: string): UnifiedRouteBuilder;
  get(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  get(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('GET', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.get(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  post(path: string): UnifiedRouteBuilder;
  post(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  post(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('POST', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.post(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  put(path: string): UnifiedRouteBuilder;
  put(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  put(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('PUT', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.put(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  delete(path: string): UnifiedRouteBuilder;
  delete(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  delete(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('DELETE', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.delete(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  patch(path: string): UnifiedRouteBuilder;
  patch(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  patch(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('PATCH', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.patch(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  head(path: string): UnifiedRouteBuilder;
  head(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  head(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('HEAD', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.head(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  options(path: string): UnifiedRouteBuilder;
  options(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  options(path: string, ...args: any[]): UnifiedRouteBuilder | this {
    if (args.length > 0) {
      (this.app as any).addRoute('OPTIONS', this.prefixPath(path), args[0], args[1]);
      return this;
    }
    return this.app.options(this.prefixPath(path)) as UnifiedRouteBuilder;
  }

  /** Register a handler for all HTTP methods on the given path (Express-compatible). */
  all(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this {
    this.app.all(this.prefixPath(path), handler, options);
    return this;
  }

  group(prefix: string, callback: (group: RouteGroup) => void): this {
    const nested = new RouteGroup(this.prefixPath(prefix), this.app);
    callback(nested);
    return this;
  }
}

// The options app.METHOD(path, handler, options) takes. Each one is applied
// as the chain builder's method of the same name applies it.
const DIRECT_FORM_OPTIONS = new Set([
  'validation',
  'rateLimit',
  'auth',
  'cache',
  'middleware',
  'description',
  'tags',
]);

// `validation` in the direct form: the { body, query, params, headers }
// object the builder's .validate() takes, or a schema on its own, which
// validates the body.
function directFormValidation(validation: any): any {
  if (validation === undefined || validation === null) return undefined;
  if (
    typeof validation.parseAsync === 'function' ||
    typeof validation.safeParse === 'function' ||
    typeof validation.parse === 'function'
  ) {
    return { body: validation };
  }
  return validation;
}

// What a legacy direct route answers when its handler failed. In production
// (NODE_ENV, the rule the validation and template errors follow) that is the
// generic body the router sends for a failed handler; the error's own text,
// which can carry file paths or an upstream service's message, goes to the
// log only. Outside production the response is what it always was.
function directRouteFailureBody(error: unknown, req: HttpRequest): Record<string, unknown> {
  if (process.env.NODE_ENV !== 'production') {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    };
  }
  return { success: false, error: 'Internal server error', requestId: req.requestId };
}

// The headers of a param(name) reply the native engine sends by itself
const PARAM_ECHO_HEADERS: readonly string[] = ['content-type', 'text/plain; charset=utf-8'];

// What was handed to app.use(), for the error that refuses it.
function describeUseArgument(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'function') {
    return `the function '${value.name || 'anonymous'}', which declares ${value.length} parameter${value.length === 1 ? '' : 's'}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return `an object with ${keys.length > 0 ? `the keys ${keys.slice(0, 5).join(', ')}` : 'no keys'}`;
  }
  return typeof value === 'string' ? `the string '${value}'` : `a ${typeof value}`;
}

/**
 * The error for an app.use() call that matches no shape it can register.
 * Names what was passed and the form that works.
 */
function describeUnregisteredUse(first: unknown, second: unknown): string {
  const refused = 'app.use(): cannot register ';
  if (typeof first === 'string') {
    return (
      refused +
      `${describeUseArgument(second)} at the prefix '${first}'. ` +
      `app.use(prefix, x) takes a (req, res, next) middleware function or a createRouter() instance. ` +
      `A hook-based built-in from the \`middleware\` namespace (rateLimit, cors, cache, ...) ` +
      `installs for every request and cannot be mounted at a prefix: ` +
      `scope it on the routes themselves (for example .rateLimit() on a route).`
    );
  }
  if (typeof first === 'function' && first.length === 2) {
    return (
      refused +
      `${describeUseArgument(first)}. That is neither middleware (req, res, next) nor an ` +
      `app plugin (app). Declare all three middleware parameters, without default values ` +
      `or rest syntax.`
    );
  }
  return (
    refused +
    `${describeUseArgument(first)}. app.use() takes a (req, res, next) function, ` +
    `a middleware object from the \`middleware\` namespace, or a createRouter() instance.`
  );
}

/**
 * `fn` for the requests at or under `prefix` only: '/admin' covers '/admin',
 * '/admin/' and '/admin/users', and not '/administrator'. The match is on
 * req.path as it arrived, case-sensitive like route paths, and the request
 * is passed on unchanged: req.url and req.path keep the prefix. The wrapper
 * declares the parameters `fn` does, because the server tells error
 * middleware (err, req, res, next) from ordinary middleware by that count.
 */
function mountAtPrefix(prefix: string, fn: (...args: any[]) => any): (...args: any[]) => any {
  const rooted = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const base = rooted.endsWith('/') ? rooted.slice(0, -1) : rooted;
  // '/' (and '') cover every path
  if (base === '') return fn;
  const under = base + '/';
  const covers = (path: unknown): boolean =>
    typeof path === 'string' && (path === base || path.startsWith(under));

  if (fn.length >= 4) {
    return function prefixedErrorMiddleware(err: any, req: any, res: any, next: any) {
      if (covers(req.path)) return fn(err, req, res, next);
      next(err);
    };
  }
  return function prefixedMiddleware(req: any, res: any, next: any) {
    if (covers(req.path)) return fn(req, res, next);
    next();
  };
}

// Route files are loaded for one app at a time (see Moro.loadRoutes): the end
// of the load in progress, and the app it is for.
let routeLoadTail: Promise<void> = Promise.resolve();
let routeLoadOwner: Moro | null = null;
// A route file that waits for another app's routes to load would wait for
// itself. Past this long the wait is given up, with a warning, instead of
// leaving listen() pending for ever.
const ROUTE_LOAD_WAIT_MS = 30000;

function waitForRouteLoad(ahead: Promise<void>, logger: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      logger.warn(
        `Waited ${ROUTE_LOAD_WAIT_MS / 1000}s for another app's route files to finish loading; ` +
          "loading this app's routes now. A route file that registers through getApp() or " +
          'createRoute() while both loads run may register on the other app: register on the ' +
          'app itself there.',
        'RouteLoader'
      );
      resolve();
    }, ROUTE_LOAD_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([ahead, giveUp]).finally(() => clearTimeout(timer));
}

// Run `load` (the import of an app's route files) with that app as the
// current app, after any other app's load in progress has finished.
async function loadRoutesAsCurrentApp(
  app: Moro,
  router: UnifiedRouter,
  logger: Logger,
  load: () => Promise<void>
): Promise<void> {
  // A route file of this app that loads more of this app's routes
  if (routeLoadOwner === app) return load();

  // One app's route files at a time: "the current app" is one process-wide
  // answer, so two apps loading side by side would register on each other.
  const ahead = routeLoadTail;
  let done!: () => void;
  routeLoadTail = new Promise<void>(resolve => {
    done = resolve;
  });
  await waitForRouteLoad(ahead, logger);

  const outerOwner = routeLoadOwner;
  routeLoadOwner = app;
  const leave = UnifiedRouter.enterLoading(router);
  try {
    await load();
  } finally {
    leave();
    routeLoadOwner = outerOwner;
    done();
  }
}

export class Moro extends EventEmitter {
  private coreFramework!: MoroCore;
  private routes: InternalRouteDefinition[] = [];
  private moduleCounter = 0;
  private loadedModules = new Set<string>();
  private lazyModules = new Map<string, ModuleConfig>();
  private routeHandlers: Record<string, CallableFunction> = {};
  private moduleDiscovery?: any; // Store for cleanup
  private autoDiscoveryOptions: MoroOptions | null = null;
  private autoDiscoveryInitialized = false;
  private autoDiscoveryPromise: Promise<void> | null = null;
  // File-based auto routing state
  private routesLoaded = false;
  private routesLoadedPromise: Promise<void> | null = null;
  // Enterprise event system integration
  private eventBus!: MoroEventBus;
  // Application logger
  private logger!: Logger;
  // This app's router: its routes, and the rate-limit counters and cached
  // responses of the routes that declare them
  private unifiedRouter!: UnifiedRouter;
  // Legacy intelligent routing (kept for backward compatibility, now a facade)
  private intelligentRouting!: IntelligentRoutingManager;
  // Documentation system
  private documentation = new AppDocumentationManager();
  // Configuration system
  private config!: AppConfig;
  // Track if user explicitly set logger options (for worker log level handling)
  private userSetLogger = false;
  // Runtime system
  private runtimeAdapter!: RuntimeAdapter;
  private runtimeType!: RuntimeType;
  // Middleware system
  private middlewareManager!: MiddlewareManager;
  // Queued WebSocket registrations (for async adapter detection)
  private queuedWebSocketRegistrations: Array<{
    namespace: string;
    handlers: Record<string, CallableFunction>;
    options?: WebSocketNamespaceOptions;
    processed: boolean;
    // The adapter could not take the namespace yet when app.websocket() ran
    heldForAdapter?: boolean;
  }> = [];
  // False until the WebSocket adapter's asynchronous start-up has finished
  private websocketSetupSettled = false;
  // Whether a `websocket` option / config asked for WebSockets at all
  private websocketRequested = false;
  // Job scheduling system
  private jobScheduler?: JobScheduler;
  private jobHealthChecker?: JobHealthChecker;
  private jobsStarted = false;
  // GraphQL system
  private graphqlCore?: any; // Use any to avoid import dependency
  private graphqlSubscriptionManager?: any;
  private graphqlInitPromise?: Promise<void>;
  private graphqlConfig?: any; // Store config for lazy initialization
  // gRPC system (lazy loaded)
  private grpcManager?: any; // Use any to avoid import dependency
  private grpcInitPromise?: Promise<void>;
  private grpcStarted = false;
  private grpcConfig?: any; // Store config for lazy initialization
  // Queue system (lazy loaded)
  private queueManager?: any; // Use any to avoid import dependency
  private queueInitialized = false;
  private queueInitPromise?: Promise<void> | undefined; // Track initialization promise
  private queueConfigs: Map<string, any> = new Map(); // Store queue configs for lazy initialization
  // Registration in progress per queue name (settles either way, never rejects)
  private queueRegistrations: Map<string, Promise<void>> = new Map();
  // Why a queue's registration failed; rethrown when that queue is used
  private queueRegistrationErrors: Map<string, unknown> = new Map();
  // Queues the application attached a processor to through processQueue()
  private queueProcessorNames: Set<string> = new Set();
  // Worker threads system (lazy loaded facade)
  private workerFacade: WorkerThreadsFacade;
  // Mail system (lazy loaded)
  private mailManager?: any; // Use any to avoid import dependency
  private mailInitialized = false;
  private mailInitPromise?: Promise<void> | undefined; // One initialisation for concurrent first uses
  // Emails sent in parallel from the in-memory queue the framework registers for mail
  private static readonly MAIL_QUEUE_CONCURRENCY = 3;
  private mailConfig?: any; // Store config for lazy initialization
  // User-registered shutdown hooks (run during close())
  private closeHooks: Array<() => any | Promise<any>> = [];
  // User-registered global error handler
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;
  // Decorations applied to every request/response/app
  private requestDecorations: Record<string, any> = {};
  private responseDecorations: Record<string, any> = {};

  constructor(options: MoroOptions = {}, preloadedConfig?: Readonly<AppConfig>) {
    super(); // Call EventEmitter constructor

    // Track if user explicitly set logger/logging options
    this.userSetLogger = !!(options.logger || options.logging);

    // Apply logging configuration BEFORE config loading to avoid DEBUG spam
    // 1. Environment variables (base level)
    const envLogLevel = process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL;
    if (envLogLevel) {
      applyLoggingConfiguration({ level: envLogLevel }, undefined);
    }

    // 2. createApp logger options (highest precedence)
    if (options.logger !== undefined) {
      applyLoggingConfiguration(undefined, options.logger);
    }

    // Create logger AFTER initial configuration
    this.logger = createFrameworkLogger('App');

    // Use pre-loaded config (from async createApp factory) when available,
    // otherwise fall back to synchronous loading (env vars + options, no file)
    this.config = preloadedConfig ?? createAppConfig(options);

    // Apply final config logging (this includes normalized logger → logging conversion)
    // Always apply this as it's the authoritative merged config
    if (this.config.logging) {
      applyLoggingConfiguration(this.config.logging, undefined);
      // Recreate logger with updated config
      this.logger = createFrameworkLogger('App');
    }

    // NOW initialize routing systems AFTER logger is configured. The router is
    // this app's own, and from here on the current one: what
    // UnifiedRouter.getInstance() and the standalone route builders use.
    this.unifiedRouter = UnifiedRouter.createForApp(this, this.config);
    this.intelligentRouting = new IntelligentRoutingManager(this.unifiedRouter);

    this.logger.info(
      `Configuration system initialized: ${process.env.NODE_ENV || 'development'}:${this.config.server.port}`
    );

    // Initialize runtime system
    this.runtimeType = options.runtime?.type || 'node';
    this.runtimeAdapter = options.runtime?.adapter || createRuntimeAdapter(this.runtimeType);

    this.logger.info(`Runtime system initialized: ${this.runtimeType}`, 'Runtime');

    // Pass configuration from config to framework
    const frameworkOptions: any = {
      ...options,
      logger: this.config.logging,
      // Enable websockets if either config has it enabled OR user passed websocket options
      websocket:
        this.config.websocket.enabled || options.websocket
          ? options.websocket || this.config.websocket || {}
          : false,
      config: this.config,
    };

    this.coreFramework = new MoroCore(frameworkOptions, this.unifiedRouter);

    // Same condition the core uses to decide whether to set an adapter up
    this.websocketRequested = !!(
      this.config.websocket.enabled ||
      (frameworkOptions.websocket && typeof frameworkOptions.websocket === 'object')
    );
    const markWebSocketSetupSettled = () => {
      this.websocketSetupSettled = true;
    };
    void this.coreFramework
      .ensureWebSocketReady()
      .then(markWebSocketSetupSettled, markWebSocketSetupSettled);

    // Initialize middleware system
    this.middlewareManager = new MiddlewareManager();

    // Expose the manager to the core framework so module routes can resolve
    // user-installed middleware by name (middleware: ['myMiddleware'])
    this.coreFramework.getContainer().register('middlewareManager', () => this.middlewareManager);

    // Integrate hooks system with HTTP server
    const httpServer = (this.coreFramework as any).httpServer;
    if (httpServer && httpServer.setHookManager) {
      httpServer.setHookManager((this.middlewareManager as any).hooks);
      // The router swallows handler errors (it produces the 500), so it needs
      // the hook manager too for 'error' hooks to observe them.
      this.unifiedRouter.setHookManager((this.middlewareManager as any).hooks);
    }

    // Configuration sections that switch on a built-in (global rate limit,
    // CSP, session, CSRF): registered here, ahead of anything the
    // application adds to the hook system.
    this.coreFramework.installConfiguredMiddleware(this.middlewareManager);

    // Configure HTTP server performance based on config
    if (httpServer && httpServer.configurePerformance) {
      const performanceConfig = this.config.performance;
      httpServer.configurePerformance({
        compression: performanceConfig?.compression || { enabled: true },
        minimal: performanceConfig?.compression?.enabled === false, // Enable minimal mode if compression disabled
      });
    }

    // Access enterprise event bus from core framework
    this.eventBus = (this.coreFramework as any).eventBus;

    // Initialize job scheduler if enabled in config
    // Default to enabled (true) unless explicitly disabled
    const jobsEnabled = this.config.jobs?.enabled !== false && options.jobs?.enabled !== false;
    if (jobsEnabled) {
      const le = this.config.jobs?.leaderElection;
      const leaderElectionOptions: LeaderElectionOptions | undefined =
        le?.enabled !== false
          ? {
              strategy: (le?.strategy as 'file' | 'redis' | 'none') ?? 'file',
              ...(le?.lockPath !== undefined ? { lockPath: le.lockPath } : {}),
              ...(le?.lockTimeout !== undefined ? { lockTimeout: le.lockTimeout } : {}),
              ...(le?.heartbeatInterval !== undefined
                ? { heartbeatInterval: le.heartbeatInterval }
                : {}),
              ...(le?.redisClient ? { redisClient: le.redisClient } : {}),
            }
          : undefined;

      // The 'redis' strategy takes its lock through a client the application
      // supplies. Without one no instance can become leader.
      if (leaderElectionOptions?.strategy === 'redis' && !leaderElectionOptions.redisClient) {
        this.logger.warn(
          "jobs.leaderElection.strategy is 'redis' but no Redis client was given: no instance can " +
            'become leader, so no scheduled job will run. Pass a connected client with ' +
            "createApp({ jobs: { leaderElection: { strategy: 'redis', redisClient } } }), " +
            "or use the 'file' strategy.",
          'Jobs'
        );
      }

      const jobs = this.config.jobs;
      const jobSchedulerOptions: JobSchedulerOptions = {
        enableLeaderElection: jobs?.leaderElection?.enabled !== false,
        ...(jobs?.maxConcurrentJobs !== undefined
          ? { maxConcurrentJobs: jobs.maxConcurrentJobs }
          : {}),
        ...(leaderElectionOptions !== undefined ? { leaderElection: leaderElectionOptions } : {}),
        ...(jobs?.executor !== undefined ? { executor: jobs.executor } : {}),
        ...(jobs?.stateManager !== undefined ? { stateManager: jobs.stateManager } : {}),
        ...(jobs?.gracefulShutdownTimeout !== undefined
          ? { gracefulShutdownTimeout: jobs.gracefulShutdownTimeout }
          : {}),
      };

      this.jobScheduler = new JobScheduler(createFrameworkLogger('Jobs'), jobSchedulerOptions);

      this.jobHealthChecker = new JobHealthChecker(
        this.jobScheduler,
        createFrameworkLogger('JobHealth')
      );

      this.logger.info('Job scheduler initialized', 'Jobs', {
        maxConcurrentJobs: jobSchedulerOptions.maxConcurrentJobs,
        leaderElection: jobSchedulerOptions.enableLeaderElection,
      });
    }

    // Initialize worker threads facade (optional - lazy loaded)
    this.workerFacade = new WorkerThreadsFacade();

    // Eagerly initialize the worker pool when configured via createApp options.
    // Without this option the pool is created lazily on first worker usage.
    if (options.workers && options.workers.enabled !== false) {
      const workerOptions = {
        ...(options.workers.count !== undefined ? { workerCount: options.workers.count } : {}),
        ...(options.workers.maxQueueSize !== undefined
          ? { maxQueueSize: options.workers.maxQueueSize }
          : {}),
        ...(options.workers.resourceLimits !== undefined
          ? { resourceLimits: options.workers.resourceLimits }
          : {}),
      };
      // The pool itself is created in the background below; record the options
      // now so that a getWorkerManager() or executeOnWorker() call made before
      // that finishes builds the pool as configured, not with the defaults.
      setConfiguredWorkerPoolOptions(workerOptions);
      void this.workerFacade.ensureInitialized(workerOptions).then(() => {
        this.logger.info('Worker thread pool initialized', 'Workers', workerOptions);
      });
    }

    // Setup default middleware if enabled - use config defaults with options override
    this.setupDefaultMiddleware({
      ...this.getDefaultOptionsFromConfig(),
      ...options,
    });

    // Store auto-discovery options for later initialization
    // IMPORTANT: Auto-discovery is deferred to ensure user middleware (like auth)
    // is registered before module middleware that might bypass it
    this.autoDiscoveryOptions = options.autoDiscover !== false ? options : null;

    // Emit initialization event through enterprise event bus
    void this.eventBus.emit('framework:initialized', {
      options,
      config: this.config,
      runtime: this.runtimeType,
    });
  }

  /**
   * Get configuration object
   */
  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Get runtime adapter
   */
  getRuntime(): RuntimeAdapter {
    return this.runtimeAdapter;
  }

  /**
   * Get runtime type
   */
  getRuntimeType(): RuntimeType {
    return this.runtimeType;
  }

  /**
   * Extract default options from configuration
   */
  private getDefaultOptionsFromConfig(): Partial<MoroOptions> {
    return {
      cors: this.config.security.cors.enabled,
      compression: this.config.performance.compression.enabled,
      helmet: this.config.security.helmet.enabled,
    };
  }

  // Intelligent route methods - chainable with automatic middleware ordering
  // Overloads for better TypeScript inference
  get(path: string): UnifiedRouteBuilder;
  get(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  get(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      // Direct route registration
      return this.addRoute('GET', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.get(path);
  }

  post(path: string): UnifiedRouteBuilder;
  post(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  post(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      // Direct route registration
      return this.addRoute('POST', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.post(path);
  }

  put(path: string): UnifiedRouteBuilder;
  put(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  put(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      // Direct route registration
      return this.addRoute('PUT', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.put(path);
  }

  delete(path: string): UnifiedRouteBuilder;
  delete(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  delete(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      // Direct route registration
      return this.addRoute('DELETE', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.delete(path);
  }

  patch(path: string): UnifiedRouteBuilder;
  patch(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  patch(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      // Direct route registration
      return this.addRoute('PATCH', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.patch(path);
  }

  head(path: string): UnifiedRouteBuilder;
  head(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  head(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      return this.addRoute('HEAD', path, handler, options);
    }
    return this.unifiedRouter.head(path);
  }

  options(path: string): UnifiedRouteBuilder;
  options(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this;
  options(
    path: string,
    handler?: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler !== undefined) {
      return this.addRoute('OPTIONS', path, handler, options);
    }
    return this.unifiedRouter.options(path);
  }

  /**
   * Register a handler for all HTTP methods on the given path (Express-compatible).
   * Handler is required — unlike the single-method registrations, there's no builder
   * form since `all()` fans out across methods.
   */
  all(
    path: string,
    handler: ((req: HttpRequest, res: HttpResponse) => any) | StaticBody | ParamEcho,
    options?: any
  ): this {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    for (const method of methods) {
      this.addRoute(method, path, handler, options);
    }
    return this;
  }

  // Schema-first route method
  route(schema: RouteSchema): void {
    // Use unified router for schema-first registration
    this.unifiedRouter.route(schema);
  }

  // Route grouping with common prefix
  group(prefix: string, callback: (group: RouteGroup) => void): this {
    const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const group = new RouteGroup(normalizedPrefix, this);
    callback(group);
    return this;
  }

  /**
   * Auto-load route files from a directory.
   *
   * Loads top-level .ts/.js files and index.ts from subdirectories.
   * Other files in subdirectories are ignored — they get pulled in
   * when their index.ts imports them.
   *
   * @example
   * await app.loadRoutes('./src/routes');
   *
   * // routes/
   * //   health.ts         → loaded
   * //   auth/
   * //     index.ts        → loaded
   * //     actions.ts      → ignored (imported by index.ts)
   *
   * While the files load, this app is the current app: a route file that
   * registers through `getApp()` or a standalone builder (`createRoute`)
   * registers on the app that loads it, whichever app was created last. A
   * file is evaluated once per process (the module cache), so a directory
   * belongs to the first app that loads it.
   */
  async loadRoutes(dir: string): Promise<void> {
    return loadRoutesAsCurrentApp(this, this.unifiedRouter, this.logger, () =>
      this.loadRouteFiles(dir)
    );
  }

  private async loadRouteFiles(dir: string): Promise<void> {
    const { readdirSync, statSync } = await import('fs');
    const { join, extname, resolve, isAbsolute } = await import('path');
    const { filePathToImportURL } = await import('./core/utilities/package-utils.js');

    const fullPath = resolve(dir);
    const extensions = ['.ts', '.js'];

    let items: string[];
    try {
      // Loaded in the order of the names (by UTF-16 code unit, so upper case
      // first), whatever order the file system lists the directory in
      const { compareNames } = await import('./core/modules/module-files.js');
      items = readdirSync(fullPath).sort(compareNames);
    } catch {
      return;
    }

    this.logger.debug(`Loading route files from ${fullPath}`, 'RouteLoader');
    if (!isAbsolute(dir)) {
      const { foundThroughWorkingDirectory } =
        await import('./core/utilities/working-directory.js');
      foundThroughWorkingDirectory(
        this.logger,
        'route directory',
        fullPath,
        process.cwd(),
        'give routing.paths (or app.loadRoutes()) absolute paths'
      );
    }

    for (const item of items) {
      const itemPath = join(fullPath, item);

      try {
        const stat = statSync(itemPath);

        if (stat.isDirectory()) {
          // Subdirectory — only load index.ts or index.js
          for (const ext of extensions) {
            const indexPath = join(itemPath, `index${ext}`);
            try {
              if (statSync(indexPath).isFile()) {
                const importURL = filePathToImportURL(indexPath);
                await import(importURL);
                this.logger.info(`Auto-loaded route: ${item}/index${ext}`, 'RouteLoader');
                break;
              }
            } catch {
              // No index file with this extension, try next
            }
          }
          continue;
        }

        // Top-level file
        const ext = extname(item);
        if (!extensions.includes(ext)) continue;
        if (item.includes('.test.') || item.includes('.spec.')) continue;

        const importURL = filePathToImportURL(itemPath);
        await import(importURL);
        this.logger.info(`Auto-loaded route: ${item}`, 'RouteLoader');
      } catch (error) {
        this.logger.warn(`Failed to load route file: ${item}`, 'RouteLoader', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Enable automatic API documentation
  enableDocs(config: DocsConfig): void {
    this.documentation.enableDocs(config, this.intelligentRouting);

    this.logger.info(`API Documentation enabled at ${config.basePath || '/docs'}`, 'Documentation');
    void this.eventBus.emit('docs:enabled', { config });
  }

  // Get OpenAPI specification
  getOpenAPISpec() {
    return this.documentation.getOpenAPISpec();
  }

  // Get documentation as JSON
  getDocsJSON(): string {
    return this.documentation.getDocsJSON();
  }

  // Get documentation as YAML
  getDocsYAML(): string {
    return this.documentation.getDocsYAML();
  }

  // Refresh documentation (useful after adding routes dynamically)
  refreshDocs(): void {
    this.documentation.refreshDocs();
  }

  // Universal middleware system - seamlessly handles standard and advanced middleware
  async use(middlewareOrFunction: any, config?: any) {
    // `app.use(pathPrefix, router)` — mount a createRouter() instance at the given prefix
    if (
      typeof middlewareOrFunction === 'string' &&
      config &&
      typeof config === 'object' &&
      config._morojsRouter === true &&
      typeof config.mount === 'function'
    ) {
      config.mount(this, middlewareOrFunction);
      return this;
    }

    // `app.use(router)` — mount a createRouter() instance at the root
    if (
      middlewareOrFunction &&
      typeof middlewareOrFunction === 'object' &&
      middlewareOrFunction._morojsRouter === true &&
      typeof middlewareOrFunction.mount === 'function'
    ) {
      middlewareOrFunction.mount(this, '');
      return this;
    }

    // `app.use(pathPrefix, fn)` — standard (req, res, next) middleware for the
    // requests at or under the prefix. Anything else after a prefix cannot be
    // mounted there, and saying nothing would leave a guard that never runs.
    if (typeof middlewareOrFunction === 'string') {
      warnUncalledGuard(config, `app.use('${middlewareOrFunction}')`);
      if (
        typeof config !== 'function' ||
        config.length < 3 ||
        (config as any)[MIDDLEWARE_FACTORY]
      ) {
        throw new Error(describeUnregisteredUse(middlewareOrFunction, config));
      }
      this.coreFramework.addMiddleware(mountAtPrefix(middlewareOrFunction, config));
      void this.eventBus.emit('middleware:registered', {
        type: 'standard',
        middleware: config,
        prefix: middlewareOrFunction,
      });
      return this;
    }

    // An auth guard factory passed uncalled (app.use(requireAuth) instead of
    // app.use(requireAuth())) protects nothing; say so.
    warnUncalledGuard(middlewareOrFunction, 'app.use()');

    // Built-in factory passed uncalled (app.use(middleware.helmet) instead of
    // app.use(middleware.helmet())). The arity dispatch below would misroute it
    // as an app-plugin and silently discard the result — fail loudly instead.
    if (
      typeof middlewareOrFunction === 'function' &&
      (middlewareOrFunction as any)[MIDDLEWARE_FACTORY]
    ) {
      throw new Error(
        `Built-in middleware factory '${middlewareOrFunction.name || 'unknown'}' was passed uncalled. ` +
          `Call it first: app.use(factory(options)) — e.g. app.use(middleware.helmet()).`
      );
    }

    // Standard middleware integration (req, res, next pattern)
    if (typeof middlewareOrFunction === 'function' && middlewareOrFunction.length >= 3) {
      this.coreFramework.addMiddleware(middlewareOrFunction);
      void this.eventBus.emit('middleware:registered', {
        type: 'standard',
        middleware: middlewareOrFunction,
      });
      return this;
    }

    // Function-style middleware execution
    if (typeof middlewareOrFunction === 'function' && middlewareOrFunction.length <= 1) {
      await middlewareOrFunction(this);
      void this.eventBus.emit('middleware:executed', {
        type: 'function',
        middleware: middlewareOrFunction,
      });
      return this;
    }

    // Advanced middleware pipeline integration - check if it's a MiddlewareInterface
    if (
      middlewareOrFunction &&
      typeof middlewareOrFunction === 'object' &&
      middlewareOrFunction.install &&
      middlewareOrFunction.metadata
    ) {
      // This is a MiddlewareInterface object - install it with the MiddlewareManager
      this.logger.debug(
        `Installing MiddlewareInterface: ${middlewareOrFunction.metadata.name}`,
        'Middleware'
      );
      this.middlewareManager.install(middlewareOrFunction, config);
      // A middleware that also serves routes (auth) is handed the app for it
      middlewareOrFunction[Symbol.for('morojs.middleware.appInstall')]?.(this);
      return this;
    }

    // Fallback: emit event for unknown middleware types
    void this.eventBus.emit('middleware:advanced', {
      middleware: middlewareOrFunction,
      config,
    });
    // Nothing above recognised the argument, so nothing can be registered.
    // Refuse it: when the argument was meant to be a guard, a silent no-op
    // leaves the routes behind it unprotected with no sign that anything is
    // wrong.
    throw new Error(describeUnregisteredUse(middlewareOrFunction, config));
  }

  // Plugin compatibility layer - unified middleware interface
  async plugin(middleware: any, options?: any): Promise<this> {
    return this.use(middleware, options);
  }

  /**
   * Register a shutdown hook. Hooks run (in registration order) during app.close(),
   * before Moro tears down its own subsystems. Use for closing DB pools, external
   * connections, flushing metrics, etc.
   */
  onClose(fn: () => any | Promise<any>): this {
    this.closeHooks.push(fn);
    return this;
  }

  /**
   * Register a global error handler. Invoked when a middleware/handler throws or
   * calls next(err), and no 4-arg error middleware has already handled it. Coexists
   * with Express-style 4-arg error middlewares.
   */
  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): this {
    this.errorHandler = fn;
    const httpServer = (this.coreFramework as any)?.httpServer;
    if (httpServer?.setErrorHandler) {
      httpServer.setErrorHandler(fn);
    }
    this.unifiedRouter.setErrorHandler(fn as any);
    return this;
  }

  /** Internal: retrieve the registered error handler (used by the HTTP server). */
  getErrorHandler():
    ((err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>) | undefined {
    return this.errorHandler;
  }

  /**
   * Decorate every request with a property. The value is assigned by reference to
   * each incoming request (use a per-request middleware to set per-request values).
   */
  decorateRequest(name: string, value: any): this {
    this.requestDecorations[name] = value;
    const httpServer = (this.coreFramework as any)?.httpServer;
    if (httpServer?.setRequestDecorations) {
      httpServer.setRequestDecorations(this.requestDecorations);
    }
    return this;
  }

  /** Decorate every response with a property (see decorateRequest). */
  decorateReply(name: string, value: any): this {
    this.responseDecorations[name] = value;
    const httpServer = (this.coreFramework as any)?.httpServer;
    if (httpServer?.setResponseDecorations) {
      httpServer.setResponseDecorations(this.responseDecorations);
    }
    return this;
  }

  /** Alias for decorateReply (Fastify-compatible name). */
  decorateResponse(name: string, value: any): this {
    return this.decorateReply(name, value);
  }

  /** Decorate the app instance itself. */
  decorate(name: string, value: any): this {
    (this as any)[name] = value;
    return this;
  }

  // Module loading with events
  async loadModule(moduleOrPath: ModuleConfig | string) {
    void this.eventBus.emit('module:loading', {
      moduleId: typeof moduleOrPath === 'string' ? moduleOrPath : moduleOrPath.name,
    });

    if (typeof moduleOrPath === 'string') {
      const module = await this.importModule(moduleOrPath);
      await this.coreFramework.loadModule(module);
      this.loadedModules.add(moduleOrPath);
      void this.eventBus.emit('module:loaded', {
        moduleId: module.name,
        version: module.version || '1.0.0',
      });
    } else {
      await this.coreFramework.loadModule(moduleOrPath);
      this.loadedModules.add(moduleOrPath.name);
      void this.eventBus.emit('module:loaded', {
        moduleId: moduleOrPath.name,
        version: moduleOrPath.version || '1.0.0',
      });
    }

    // IMPORTANT: If modules are loaded manually after auto-discovery,
    // ensure the final module handler is set up to maintain middleware order
    if (this.autoDiscoveryInitialized) {
      this.coreFramework.setupFinalModuleHandler();
    }

    return this;
  }

  // Database helper with events
  database(adapter: any) {
    void this.eventBus.emit('database:connected', {
      adapter: adapter.constructor.name,
      config: 'hidden',
    });
    this.coreFramework.registerDatabase(adapter);
    return this;
  }

  // WebSocket helper with events.
  //
  // Default framing: every frame is a JSON `{ event, data }` envelope and each
  // handler key is an event name. With `{ raw: true }` frames are delivered
  // as-is: `message` gets each text frame as a string, `binary` each binary
  // frame as a Buffer, and a string/Buffer returned from the handler (or
  // `socket.send()`) is the reply frame - what a plain-WebSocket client
  // (browsers, load testers, non-Moro peers) speaks.
  websocket(
    namespace: string,
    handlers: Record<string, CallableFunction>,
    options: WebSocketNamespaceOptions = {}
  ) {
    // Queue the registration to be processed after adapter initialization
    const registration: (typeof this.queuedWebSocketRegistrations)[number] = {
      namespace,
      handlers,
      options,
      processed: false,
    };
    this.queuedWebSocketRegistrations.push(registration);

    // Try to process immediately if adapter is already ready
    const adapter = this.coreFramework.getWebSocketAdapter();
    if (adapter && !registration.processed) {
      if (this.websocketSetupSettled) {
        // Adapter is ready, process immediately
        this.processWebSocketRegistration(namespace, handlers, adapter, options);
        registration.processed = true;
      } else if (this.processWebSocketRegistration(namespace, handlers, adapter, options, true)) {
        // The adapter object exists but its asynchronous start-up is still
        // running. Adapters that take namespaces straight away (ws, the
        // engine) are registered now, as above.
        registration.processed = true;
      } else {
        // The adapter cannot create a namespace until it has started (the
        // Socket.IO server is built during start-up): keep the registration
        // queued; it is applied when the server starts.
        registration.heldForAdapter = true;
      }
    }
    // Otherwise, it will be processed when the server starts

    return this;
  }

  private processWebSocketRegistration(
    namespace: string,
    handlers: Record<string, CallableFunction>,
    adapter: any,
    options: WebSocketNamespaceOptions = {},
    // true while the adapter is still starting: an adapter that cannot create
    // the namespace yet makes this return false instead of throwing
    adapterStillStarting = false
  ): boolean {
    let ns: any;
    try {
      ns = adapter.createNamespace(namespace, options);
    } catch (error) {
      if (adapterStillStarting) return false;
      this.emit('websocket:registering', { namespace, handlers });
      throw error;
    }
    this.emit('websocket:registering', { namespace, handlers });

    const raw = options.raw === true;
    const isFrame = (v: unknown): v is string | Buffer | ArrayBuffer | Uint8Array =>
      typeof v === 'string' ||
      Buffer.isBuffer(v) ||
      v instanceof ArrayBuffer ||
      ArrayBuffer.isView(v);

    Object.entries(handlers).forEach(([event, handler]) => {
      ns.on('connection', (socket: any) => {
        this.emit('websocket:connection', { namespace, event, socket });

        if (event === 'connection') {
          // The documented `connection: socket => ...` hook runs once per
          // socket at open (it is not a client-sendable event name). It is
          // called here, synchronously, so it has run before the first frame
          // is dispatched: a client can send a frame in the same segment as
          // its handshake, and a hook deferred to a later tick would let a
          // message handler answer a socket the hook was about to close.
          const hookFailed = (error: any) =>
            this.emit('websocket:error', { namespace, event, error });
          try {
            const pending = handler(socket);
            if (typeof pending?.then === 'function') {
              (pending as Promise<unknown>).then(undefined, hookFailed);
            }
          } catch (error) {
            hookFailed(error);
          }
          return;
        }

        // The handler's result, delivered: a reply frame or an envelope
        // response, or nothing.
        const settle = (result: any, callback: any) => {
          if (this.listenerCount('websocket:response') > 0)
            this.emit('websocket:response', { namespace, event, result });
          if (raw) {
            // Raw framing: the return value IS the reply frame
            if (isFrame(result)) socket.send?.(result);
            else if (result !== undefined && result !== null) {
              socket.send?.(JSON.stringify(result));
            }
            return;
          }
          if (callback) callback(result);
          else if (result) socket.emit(`${event}:response`, result);
        };
        const fail = (error: any, callback: any) => {
          this.emit('websocket:error', { namespace, event, error });
          // A raw peer has no envelope to carry an error object; the
          // failure is surfaced through the websocket:error event only.
          if (raw) return;
          this.logger.error('WebSocket handler error', 'WebSocket', {
            namespace,
            event,
            error: error instanceof Error ? error.message : String(error),
          });
          // What the handler threw is the application's own text (a driver
          // message, a path, a query). In production the client is told only
          // that the event failed; the error itself is in the log line and
          // the websocket:error event above.
          const errorResponse = {
            success: false,
            error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error?.message,
          };
          if (callback) callback(errorResponse);
          else socket.emit('error', errorResponse);
        };

        // A synchronous handler is settled on the spot: no promise, no
        // microtask, and its reply frame leaves in the same batch as the
        // frame that provoked it. Only a thenable result waits. The
        // framework events fire only when something listens, so an idle
        // listener list costs no allocation per frame. A synchronous throw
        // takes the same error path as a rejection, which the `.catch` of
        // the promise form was always meant to give it.
        socket.on(event, (data: any, callback: any) => {
          if (this.listenerCount('websocket:event') > 0)
            this.emit('websocket:event', { namespace, event, data });
          let result: any;
          try {
            result = handler(socket, data);
          } catch (error) {
            fail(error, callback);
            return;
          }
          if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
            (result as Promise<any>)
              .then((r: any) => settle(r, callback))
              .catch((error: any) => fail(error, callback));
            return;
          }
          try {
            settle(result, callback);
          } catch (error) {
            fail(error, callback);
          }
        });
      });
    });

    this.emit('websocket:registered', { namespace, handlers });
    return true;
  }

  private async processQueuedWebSocketRegistrations() {
    // Wait for WebSocket adapter to be ready
    await this.coreFramework.ensureWebSocketReady();

    const adapter = this.coreFramework.getWebSocketAdapter();

    // Check if any unprocessed registrations exist
    const unprocessedRegistrations = this.queuedWebSocketRegistrations.filter(r => !r.processed);

    if (!adapter && unprocessedRegistrations.length > 0) {
      const namespaces = unprocessedRegistrations.map(r => `'${r.namespace}'`).join(', ');
      // The first line is matched by listen() to treat this as fatal.
      if (!this.websocketRequested) {
        throw new Error(
          'WebSocket features require a WebSocket adapter.\n\n' +
            `app.websocket() was called for ${namespaces}, but WebSockets are not enabled, ` +
            'so no adapter was set up. WebSockets are off until the app is created with a ' +
            '`websocket` option:\n\n' +
            '  const app = await createApp({ websocket: { enabled: true } });\n\n' +
            'or, in moro.config.js:\n\n' +
            '  export default { websocket: { enabled: true } };\n\n' +
            'The native engine (the default) then serves WebSockets on the HTTP port; ' +
            'nothing else needs installing.'
        );
      }
      throw new Error(
        'WebSocket features require a WebSocket adapter.\n\n' +
          `app.websocket() was called for ${namespaces} and WebSockets are enabled, but no ` +
          `adapter could be set up on the '${this.engine.server}' HTTP server ` +
          '(the WebSocket warning logged at start-up gives the reason).\n\n' +
          'Option 1: Use the native engine (the default), which serves WebSockets itself.\n\n' +
          'Option 2: On the Node.js server, install socket.io or ws (auto-detected):\n' +
          '  npm install socket.io\n\n' +
          'Option 3: Pass an adapter:\n' +
          "  import { SocketIOAdapter } from '@morojs/moro';\n" +
          '  const app = await createApp({ websocket: { adapter: new SocketIOAdapter() } });'
      );
    }

    if (adapter) {
      // Process all unprocessed registrations
      for (const registration of this.queuedWebSocketRegistrations) {
        if (!registration.processed) {
          try {
            this.processWebSocketRegistration(
              registration.namespace,
              registration.handlers,
              adapter,
              registration.options
            );
          } catch (error) {
            if (!registration.heldForAdapter) throw error;
            // The registration waited for an adapter that then failed to
            // start. app.websocket() would have thrown; fail the start the
            // same way a missing adapter does.
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
              'WebSocket features require a WebSocket adapter.\n\n' +
                `app.websocket() was called for '${registration.namespace}', but the configured ` +
                `adapter did not start: ${reason} ` +
                '(the WebSocket warning logged at start-up gives the cause).'
            );
          }
          registration.processed = true;
        }
      }
    }
  }

  // Start server with events (Node.js only)
  listen(callback?: () => void): void;
  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(
    portOrCallback?: number | (() => void),
    hostOrCallback?: string | (() => void),
    callback?: () => void
  ) {
    // Only available for Node.js runtime
    if (this.runtimeType !== 'node') {
      throw new Error(
        `listen() is only available for Node.js runtime. Current runtime: ${this.runtimeType}. Use getHandler() for other runtimes.`
      );
    }

    // Handle overloaded parameters - supports:
    // listen(callback)
    // listen(port, callback)
    // listen(port, host, callback)
    let port: number;
    let host: string | undefined;

    if (typeof portOrCallback === 'function') {
      // listen(callback) - use port from config
      callback = portOrCallback;
      port = this.config.server.port;
      host = this.config.server.host;
    } else if (typeof portOrCallback === 'number') {
      // listen(port, ...) variants
      port = portOrCallback;
      if (typeof hostOrCallback === 'function') {
        // listen(port, callback)
        callback = hostOrCallback;
        host = undefined;
      } else {
        // listen(port, host, callback)
        host = hostOrCallback;
      }
    } else {
      // listen() - use config defaults
      port = this.config.server.port;
      host = this.config.server.host;
    }

    // listen(0), written out, asks the operating system for a free port (read
    // it back with app.address()). A port of 0 that merely came out of the
    // configuration is still "no port given".
    const ephemeralPort = portOrCallback === 0;

    // Validate that we have a valid port
    if (!ephemeralPort && (!port || typeof port !== 'number')) {
      throw new Error(
        'Port not specified and not found in configuration. Please provide a port number or configure it in moro.config.js/ts'
      );
    }

    // Check if clustering is enabled for massive performance gains
    if (this.config.performance?.clustering?.enabled) {
      if (ephemeralPort) {
        throw new Error(
          'listen(0) cannot be used with performance.clustering: every worker would be given a ' +
            'different port by the operating system. Pass a fixed port number.'
        );
      }
      // Worker threads (engine backend, POSIX, engine >= 1.1.6) or node:cluster
      // processes - startWithClustering picks and logs the transport.
      this.startWithClustering(port, host as string, callback);
      return;
    }

    // Single-process graceful shutdown: SIGINT/SIGTERM (Ctrl-C) drain in-flight
    // work via close() by default; a second signal force-exits. Opt out with
    // `server.gracefulShutdown: false`. (Cluster mode wires its own handlers.)
    this.registerProcessShutdownHandlers();

    void this.eventBus.emit('server:starting', { port, runtime: this.runtimeType });

    // Add documentation middleware first (if enabled)
    try {
      const docsMiddleware = this.documentation.getDocsMiddleware();
      this.coreFramework.addMiddleware(docsMiddleware);
      this.logger.debug('Documentation middleware added', 'Documentation');
    } catch {
      // Documentation not enabled, that's fine
      this.logger.debug('Documentation not enabled', 'Documentation');
    }

    // Attach the unified router (handles both chainable and direct routes)
    this.attachUnifiedRouter();

    // Register legacy direct routes with the HTTP server (for backward compatibility)
    if (this.routes.length > 0) {
      this.registerDirectRoutes();
    }

    const requestedPort = port;
    const startServer = () => {
      const actualCallback = () => {
        // After listen(0) the port to report is the one that was bound.
        const port = ephemeralPort ? (this.address()?.port ?? 0) : requestedPort;
        const displayHost = host || 'localhost';
        const serverKind = this.engine;
        this.logger.info('Moro Server Started', 'Server');
        this.logger.info(`Runtime: ${this.runtimeType}`, 'Server');
        this.logger.info(
          `HTTP engine: ${serverKind.server}` +
            (serverKind.enginePackage ? ` (${serverKind.enginePackage})` : '') +
            engineBinaryNote(serverKind.engineBinary),
          'Server'
        );
        this.logger.info(`HTTP API: http://${displayHost}:${port}`, 'Server');
        if (this.config.websocket.enabled) {
          this.logger.info(`WebSocket: ws://${displayHost}:${port}`, 'Server');
        }
        this.logger.info('Learn more at https://morojs.com', 'Server');

        // Log unified router stats
        const routeCount = this.unifiedRouter.getRouteCount();
        if (routeCount > 0) {
          this.logger.info(`Unified Router: ${routeCount} routes registered`, 'Server');
          // Log performance stats
          this.unifiedRouter.logPerformanceStats();
        }

        void this.eventBus.emit('server:started', {
          port,
          runtime: this.runtimeType,
          engine: serverKind,
        });

        // Start job scheduler after server starts
        this.startJobScheduler().catch(err => {
          this.logger.error(`Failed to start job scheduler: ${String(err)}`);
        });

        // Initialize GraphQL if configured
        this.ensureGraphQLInitialized().catch(error => {
          logErrorLines(this.logger, 'Failed to initialize GraphQL', error, 'GraphQL');
        });

        // Start gRPC server if initialized
        if (this.grpcManager && !this.grpcStarted) {
          this.startGrpc().catch(error => {
            logErrorLines(this.logger, 'Failed to start gRPC server', error, 'GRPC');
          });
        }

        if (callback) callback();
      };

      if (host && typeof host === 'string') {
        this.coreFramework.listen(port, host, actualCallback);
      } else {
        this.coreFramework.listen(port, actualCallback);
      }
    };

    // Ensure auto-discovery and WebSocket setup is complete before starting server.
    // Routes load after modules so DB/services/middleware set up during discovery
    // are available to route files.
    Promise.all([
      this.ensureAutoDiscoveryComplete().then(() => this.ensureRoutesLoaded()),
      this.processQueuedWebSocketRegistrations(),
    ])
      .then(
        () => startServer(),
        initError => {
          // Initialization (auto-discovery / WebSocket setup) failed — this is
          // NOT the listen() call. Handle it here so a subsequent listen()
          // failure can't be misdiagnosed as an init failure and retried.
          this.logger.error('Initialization failed during server start', 'Framework', {
            error: initError instanceof Error ? initError.message : String(initError),
          });
          // WebSocket-adapter misconfiguration is fatal; propagate it.
          if (
            initError instanceof Error &&
            initError.message.includes('WebSocket features require a WebSocket adapter')
          ) {
            throw initError;
          }
          // A non-fatal init issue (e.g. auto-discovery) — start the server anyway.
          startServer();
        }
      )
      .catch(error => {
        // startServer()/listen() failed — e.g. EADDRINUSE thrown synchronously
        // by the native engine. Retrying would fail identically, so surface it
        // via the 'error' event (Node's server convention) instead of retrying
        // into an unhandled rejection. With no 'error' listener, EventEmitter
        // rethrows — the desired visible crash for a fatal bind failure.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to start server on port ${port}: ${message}`, 'Framework');
        this.emit('error', error);
      });
  }

  /**
   * The address the HTTP server is bound to, in the shape of Node's
   * `server.address()`, or `null` while the app is not listening (before the
   * listen callback, after close(), and in the primary of a cluster, where
   * the workers hold the port). After `listen(0)` this is where the port the
   * operating system chose is read.
   *
   * @example
   * app.listen(0, () => {
   *   const { port } = app.address()!;
   * });
   */
  address(): { address: string; family: string; port: number } | null {
    const server = (this.coreFramework as any)?.httpServer?.getServer?.();
    const bound = typeof server?.address === 'function' ? server.address() : null;
    if (!bound || typeof bound !== 'object' || typeof bound.port !== 'number') return null;
    return { address: String(bound.address), family: String(bound.family), port: bound.port };
  }

  // Public method to manually initialize auto-discovery
  // Useful for ensuring auth middleware is registered before auto-discovery
  async initializeAutoDiscoveryNow(): Promise<void> {
    return this.ensureAutoDiscoveryComplete();
  }

  // Load file-based routes from the configured directories (config.routing).
  // Runs once during listen() after module discovery. Idempotent and safe to
  // call alongside a manual app.loadRoutes() — the ES module cache prevents a
  // file from registering twice even if both resolve to the same path.
  private async ensureRoutesLoaded(): Promise<void> {
    if (this.routesLoaded) return;
    if (this.routesLoadedPromise) return this.routesLoadedPromise;

    const routing = this.config.routing;
    const disabled =
      routing === false || (typeof routing === 'object' && routing.enabled === false);
    if (disabled) {
      this.routesLoaded = true;
      return;
    }

    this.routesLoadedPromise = (async () => {
      const isProd = process.env.NODE_ENV === 'production';
      const defaultPaths = isProd ? ['./dist/routes', './dist/src/routes'] : ['./src/routes'];
      const paths =
        typeof routing === 'object' && Array.isArray(routing.paths) && routing.paths.length > 0
          ? routing.paths
          : defaultPaths;

      for (const dir of paths) {
        try {
          await this.loadRoutes(dir);
        } catch (error) {
          this.logger.warn(`Failed to auto-load routes from ${dir}`, 'RouteLoader', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    try {
      await this.routesLoadedPromise;
      this.routesLoaded = true;
    } finally {
      this.routesLoadedPromise = null;
    }
  }

  // Public API: Initialize modules explicitly after middleware setup
  // This provides users with explicit control over module loading timing
  // IMPORTANT: This forces module loading even if autoDiscovery.enabled is false
  // Usage: app.initModules() or app.initModules({ paths: ['./my-modules'] })
  initModules(options?: {
    paths?: string[];
    patterns?: string[];
    recursive?: boolean;
    loadingStrategy?: 'eager' | 'lazy' | 'conditional';
    watchForChanges?: boolean;
    ignorePatterns?: string[];
    loadOrder?: 'alphabetical' | 'dependency' | 'custom';
    failOnError?: boolean;
    maxDepth?: number;
  }): void {
    this.logger.info('User-requested module initialization', 'ModuleSystem');

    // If already initialized, do nothing
    if (this.autoDiscoveryInitialized) {
      this.logger.debug('Auto-discovery already completed, skipping', 'ModuleSystem');
      return;
    }

    // Store the options and mark that we want to force initialization
    this.autoDiscoveryOptions = {
      autoDiscover: {
        enabled: true, // Force enabled regardless of original config
        paths: options?.paths || ['./modules', './src/modules'],
        patterns: options?.patterns || [
          '**/*.module.{ts,js}',
          '**/index.{ts,js}',
          '**/*.config.{ts,js}',
        ],
        recursive: options?.recursive ?? true,
        loadingStrategy: options?.loadingStrategy || ('eager' as const),
        watchForChanges: options?.watchForChanges ?? false,
        ignorePatterns: options?.ignorePatterns || [
          '**/*.test.{ts,js}',
          '**/*.spec.{ts,js}',
          '**/node_modules/**',
        ],
        loadOrder: options?.loadOrder || ('dependency' as const),
        failOnError: options?.failOnError ?? false,
        maxDepth: options?.maxDepth ?? 5,
      },
    };

    this.logger.debug(
      'Module initialization options stored, will execute on next listen/getHandler call',
      'ModuleSystem'
    );
  }

  // Robust method to ensure auto-discovery is complete, handling race conditions
  private async ensureAutoDiscoveryComplete(): Promise<void> {
    // If already initialized, nothing to do
    if (this.autoDiscoveryInitialized) {
      return;
    }

    // If auto-discovery is disabled, mark as initialized
    if (!this.autoDiscoveryOptions) {
      this.autoDiscoveryInitialized = true;
      return;
    }

    // If already in progress, wait for it to complete
    if (this.autoDiscoveryPromise) {
      return this.autoDiscoveryPromise;
    }

    // Start auto-discovery
    this.autoDiscoveryPromise = this.performAutoDiscovery();

    try {
      await this.autoDiscoveryPromise;
      this.autoDiscoveryInitialized = true;
    } catch (error) {
      // Reset promise on error so it can be retried
      this.autoDiscoveryPromise = null;
      throw error;
    } finally {
      this.autoDiscoveryOptions = null; // Clear after attempt
    }
  }

  // Perform the actual auto-discovery work
  private async performAutoDiscovery(optionsOverride?: MoroOptions): Promise<void> {
    const optionsToUse = optionsOverride || this.autoDiscoveryOptions;
    if (!optionsToUse) return;

    this.logger.debug('Starting auto-discovery initialization', 'AutoDiscovery');

    await this.initializeAutoDiscovery(optionsToUse);

    this.logger.debug('Auto-discovery initialization completed', 'AutoDiscovery');
  }

  // An error the global middleware chain ended with on a getHandler()
  // runtime, answered the way the servers answer it: the application's error
  // handler first, then 413 / 400 for a body error and the generic 500.
  private async answerGlobalMiddlewareError(
    error: unknown,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    const statusCode = (error as any)?.statusCode;
    if (statusCode === 413 && !res.headersSent) {
      res.status(413).json({ success: false, error: 'Request entity too large' });
      return;
    }
    this.logger.error('Request error', 'RequestHandler', {
      error: error instanceof Error ? error.message : String(error),
      requestId: req.requestId,
      method: req.method,
      path: req.path,
    });
    if (this.errorHandler && !res.headersSent) {
      try {
        await this.errorHandler(error, req, res);
      } catch (handlerErr) {
        this.logger.error('Error handler itself threw', 'RequestHandler', {
          error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
        });
      }
    }
    if (res.headersSent) return;
    // What a middleware had set described the body it meant to send
    clearRepresentationHeaders(res as any);
    const badRequest = statusCode === 400;
    res.status(badRequest ? 400 : 500).json({
      success: false,
      error: badRequest ? 'Invalid request body' : 'Internal server error',
      requestId: req.requestId,
    });
  }

  // Get handler for non-Node.js runtimes
  getHandler() {
    // Ensure auto-discovery is complete for non-Node.js runtimes
    // This handles the case where users call getHandler() immediately after createApp()
    this.ensureAutoDiscoveryComplete().catch(error => {
      this.logger.error('Auto-discovery initialization failed for runtime handler', 'Framework', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Create a unified request handler that works with the runtime adapter.
    // Lifecycle hooks run here so serverless runtimes (Lambda, Edge, Workers)
    // have parity with the long-running servers. Unlike those servers,
    // 'response' hooks are awaited before returning — post-return work would
    // be frozen or dropped by the platform.
    const hookManager = this.middlewareManager.getHookManager();
    // The global middleware chain: the functions registered with app.use(fn)
    // and the config-driven ones (helmet, CORS, compression, request logging).
    // It is kept by the server object, which exists on every runtime, and is
    // read per request so middleware registered after getHandler() runs too.
    // It runs where the servers run it: after the request hooks, before the
    // documentation routes and the router.
    const httpServer = (this.coreFramework as any).httpServer;
    const handler = async (req: HttpRequest, res: HttpResponse) => {
      try {
        if (hookManager.hasHooks('request')) {
          // A hook that answers the request itself (a rate limit's 429, a
          // CSRF 403) does so before the global middleware has run, and gives
          // its answer the application's helmet and CORS headers by asking
          // the response for its server. The servers' own responses carry
          // that reference; the ones these runtimes create are given it
          // here, and only for an app that has a request hook at all.
          if ((res as any)._server === undefined) (res as any)._server = httpServer;
          await hookManager.execute('request', { request: req, response: res });
          if (res.headersSent) return;
        }

        const globalMiddleware: Middleware[] | undefined = httpServer?.globalMiddleware;
        if (globalMiddleware !== undefined && globalMiddleware.length > 0) {
          try {
            const chain = runGlobalMiddleware(globalMiddleware, req, res);
            if (chain) await chain;
          } catch (error) {
            if (hookManager.hasHooks('error')) {
              try {
                await hookManager.execute('error', { request: req, response: res, error });
              } catch (hookError: any) {
                this.logger.error(`Error hook error: ${hookError?.message || hookError}`, 'Hooks');
              }
            }
            await this.answerGlobalMiddlewareError(error, req, res);
            return;
          }
          // A middleware answered the request itself (a guard, a preflight)
          if (res.headersSent) return;
        }

        // Add documentation middleware first (if enabled)
        try {
          const docsMiddleware = this.documentation.getDocsMiddleware();
          await docsMiddleware(req, res, () => {});
          if (res.headersSent) return;
        } catch {
          // Documentation not enabled, that's fine
        }

        // Try unified router first (handles all routes)
        const handled = await this.unifiedRouter.handleRequest(req, res);
        if (handled) return;

        // Handle legacy direct routes (backward compatibility)
        if (this.routes.length > 0) {
          await this.handleDirectRoutes(req, res);
        }
      } catch (error) {
        if (hookManager.hasHooks('error')) {
          try {
            await hookManager.execute('error', { request: req, response: res, error });
          } catch (hookError: any) {
            this.logger.error(`Error hook error: ${hookError?.message || hookError}`, 'Hooks');
          }
        }
        throw error;
      } finally {
        if (hookManager.hasHooks('response')) {
          try {
            await hookManager.execute('response', { request: req, response: res });
          } catch (hookError: any) {
            this.logger.error(`Response hook error: ${hookError?.message || hookError}`, 'Hooks');
          }
        }
      }
    };

    // Use the runtime adapter to create the appropriate handler
    return this.runtimeAdapter.createServer(handler);
  }

  // Handle direct routes for runtime adapters
  private async handleDirectRoutes(req: HttpRequest, res: HttpResponse) {
    // Find matching route
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const route = this.findMatchingRoute(req.method!, req.path);
    if (!route) {
      (res as any).status(404).json({ success: false, error: 'Not found' });
      return;
    }

    try {
      // Extract path parameters
      const matches = req.path.match(route.pattern);
      if (matches) {
        req.params = {};
        route.paramNames.forEach((name: string, index: number) => {
          req.params[name] = matches[index + 1] ?? '';
        });
      }

      // Get handler function
      const handler = this.routeHandlers[route.handler];
      if (!handler) {
        (res as any).status(500).json({ success: false, error: 'Handler not found' });
        return;
      }

      // Execute validation if present
      if (route.validation) {
        try {
          const validated = route.validation.parse(req.body);
          req.body = validated;
        } catch (error: any) {
          if (error.issues) {
            (res as any).status(400).json({
              success: false,
              error: 'Validation failed',
              details: error.issues.map((issue: any) => ({
                field: issue.path.length > 0 ? issue.path.join('.') : 'body',
                message: issue.message,
                code: issue.code,
              })),
            });
            return;
          }
          throw error;
        }
      }

      // Execute rate limiting if present
      if (route.rateLimit) {
        const clientId = req.ip || 'unknown';
        const key = `${route.method}:${route.path}:${clientId}`;

        if (!this.checkRateLimit(key, route.rateLimit)) {
          (res as any).status(429).json({
            success: false,
            error: 'Rate limit exceeded',
            retryAfter: Math.ceil(route.rateLimit.window / 1000),
          });
          return;
        }
      }

      // Execute the handler
      const result = await handler(req, res);
      if (result && !(res as any).headersSent) {
        (res as any).json(result);
      }
    } catch (error) {
      this.logger.error('Route execution error', 'RequestHandler', {
        error: error instanceof Error ? error.message : String(error),
        route: `${route.method} ${route.path}`,
        requestId: req.requestId,
      });
      if (!(res as any).headersSent) {
        (res as any).status(500).json(directRouteFailureBody(error, req));
      }
    }
  }

  // Advanced route matching with caching and optimization
  private routeCache = new Map<string, { pattern: RegExp; paramNames: string[] }>();
  private staticRouteMap = new Map<string, any>();
  private dynamicRoutesBySegments = new Map<number, any[]>();

  private findMatchingRoute(method: string, path: string) {
    // O(1) static route lookup
    const staticKey = `${method}:${path}`;
    const staticRoute = this.staticRouteMap.get(staticKey);
    if (staticRoute) {
      return {
        ...staticRoute,
        pattern: /^.*$/, // Dummy pattern for static routes
        paramNames: [],
      };
    }

    // Dynamic route matching by segment count
    const segmentCount = PathMatcher.countSegments(path);
    const candidateRoutes = this.dynamicRoutesBySegments.get(segmentCount) || [];

    for (const route of candidateRoutes) {
      if (route.method === method) {
        const cacheKey = `${method}:${route.path}`;
        let pattern = this.routeCache.get(cacheKey);

        if (!pattern) {
          pattern = this.pathToRegex(route.path);
          this.routeCache.set(cacheKey, pattern);
        }

        if (pattern.pattern.test(path)) {
          return {
            ...route,
            pattern: pattern.pattern,
            paramNames: pattern.paramNames,
          };
        }
      }
    }

    return null;
  }

  // Convert path to regex (simplified version)
  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexPath = path
      .replace(/\//g, '\\/')
      .replace(/:([^/]+)/g, (match, paramName) => {
        paramNames.push(paramName);
        return '([^/]+)';
      })
      // A dot in the fixed text of a path is a dot, as in PathMatcher
      .replace(LITERAL_DOT, '\\.');

    return {
      pattern: new RegExp(`^${regexPath}$`),
      paramNames,
    };
  }

  // Access enterprise event system for advanced integrations
  get events() {
    return this.eventBus;
  }

  // The application's live hook manager — the same instance
  // MiddlewareInterface.install() receives. Register request-lifecycle hooks
  // directly: app.hooks.before('request', ctx => {...}),
  // app.hooks.after('response', ctx => {...}).
  get hooks() {
    return this.middlewareManager.getHookManager();
  }

  // Access to core framework for advanced usage
  get core() {
    return this.coreFramework;
  }

  // Which HTTP server actually booted (engine/node/http2), the package
  // backing a native engine, and the fallback reason when one was requested
  // but the Node server booted instead. Stable surface for logs/tests/benchmarks.
  get engine(): ReturnType<MoroCore['getServerKind']> {
    return this.coreFramework.getServerKind();
  }

  /**
   * Rotate the TLS certificate/key on the running listener without a restart.
   * With no argument the key/cert files from `server.ssl` are re-read; with
   * one, the given material (either ssl shape) replaces them. The new pair is
   * validated first, so a bad file leaves the current certificate serving and
   * rejects. Connections already established are untouched. `server.ssl.watch`
   * calls this automatically when the files change.
   */
  async reloadTLS(ssl?: SSLConfigInput): Promise<void> {
    await this.coreFramework.reloadTLS(ssl);
    this.emit('tls:reloaded', { source: ssl ? 'argument' : 'files' });
  }

  getServerKind(): ReturnType<MoroCore['getServerKind']> {
    return this.coreFramework.getServerKind();
  }

  // Public API for accessing the DI container
  getContainer() {
    return this.coreFramework.getContainer();
  }

  // Force cleanup of pooled objects
  forceCleanup(): void {
    const httpServer = (this.coreFramework as any).httpServer;
    if (httpServer && httpServer.forceCleanup) {
      httpServer.forceCleanup();
    }
  }

  // Private methods
  private addRoute(
    method: string,
    path: string,
    handler: ((req: any, res: any) => any | Promise<any>) | string | Buffer | ParamEcho,
    options: any = {}
  ) {
    if (options === null || typeof options !== 'object') {
      // app.get(path, middleware, handler): the second function is in the
      // place of the options object, so it would be dropped and the first one
      // run as the handler. Say so instead of dropping it silently.
      if (typeof options === 'function') {
        this.logger.warn(
          `${method.toUpperCase()} ${path}: the third argument is a function and will NOT run. ` +
            `app.${method.toLowerCase()}(path, handler, options) takes one handler; pass middleware as ` +
            `{ middleware: [fn] } or with the builder: app.${method.toLowerCase()}(path).before(fn).handler(handler).`,
          'Router'
        );
      }
      options = {};
    }

    // An option this form does not have is not applied by anything. Name it
    // here, once, instead of leaving it silently inert.
    const unknown = Object.keys(options).filter(key => !DIRECT_FORM_OPTIONS.has(key));
    if (unknown.length > 0) {
      this.logger.warn(
        `${method.toUpperCase()} ${path}: route option${unknown.length > 1 ? 's' : ''} ` +
          `${unknown.map(key => `'${key}'`).join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not known ` +
          `and will NOT be applied. app.${method.toLowerCase()}(path, handler, options) takes ` +
          `${[...DIRECT_FORM_OPTIONS].join(', ')}.`,
        'Router'
      );
    }

    // The options are the route's schema: the unified router applies each of
    // them on this route as it does for the chain builder (rate limit, auth,
    // validation, the route's middleware, cache, then the handler). A route
    // with no options stays on the router's fast path.
    const schema: RouteSchema = {
      method: method as any,
      path,
      handler: handler as any,
      middleware: options.middleware || [],
    };
    const validation = directFormValidation(options.validation);
    if (validation !== undefined) schema.validation = validation;
    if (options.rateLimit) schema.rateLimit = options.rateLimit;
    if (options.auth) schema.auth = options.auth;
    if (options.cache) schema.cache = options.cache;
    if (options.description !== undefined) schema.description = options.description;
    if (options.tags !== undefined) schema.tags = options.tags;

    // A literal body - app.get('/', '') - is the same route the builder's
    // .handler('') registers: the unified router turns it into a handler and,
    // with nothing else configured, a reply the native engine answers itself.
    // It never enters the legacy direct-route table, whose wrapper would
    // call it as a function.
    if (typeof handler !== 'function') {
      this.unifiedRouter.registerRoute(schema);
      return this;
    }

    // Register with unified router (primary routing system)
    const registered = this.unifiedRouter.registerRoute(schema);

    // Also store in legacy routes array for backward compatibility
    const handlerName = `handler_${this.routes.length}`;
    const route = {
      method: method as any,
      path,
      handler: handlerName,
      validation: options.validation,
      rateLimit: options.rateLimit,
      cache: options.cache,
      middleware: options.middleware,
      // What the server's own route table runs before the handler when it is
      // the one that matched (see registerDirectRoutes)
      registered,
    };

    this.routes.push(route);

    // Organize routes for optimal lookup (legacy)
    this.organizeRouteForLookup(route);

    // Store handler for later module creation (legacy)
    this.routeHandlers[handlerName] = handler;

    return this;
  }

  private organizeRouteForLookup(route: any): void {
    // A route with optional parameters or a wildcard is matched by the
    // unified router alone, on every runtime
    if (hasExtendedSyntax(route.path)) return;
    if (!route.path.includes(':')) {
      // Static route - add to static map for O(1) lookup
      const staticKey = `${route.method}:${route.path}`;
      this.staticRouteMap.set(staticKey, route);
    } else {
      // Dynamic route - organize by segment count
      const segmentCount = PathMatcher.countSegments(route.path);

      if (!this.dynamicRoutesBySegments.has(segmentCount)) {
        this.dynamicRoutesBySegments.set(segmentCount, []);
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.dynamicRoutesBySegments.get(segmentCount)!.push(route);
    }
  }

  // Attach the unified router to the HTTP server. Servers that support direct
  // dispatch (setRouterHandler) get the router called straight from
  // handleRequest - after global middleware, with no per-request promise
  // wrapper. Older/custom servers fall back to the middleware adapter.
  private attachUnifiedRouter(): void {
    const httpServer = (this.coreFramework as any).httpServer;

    // Listening (again): this app counts as open when the current app is chosen
    UnifiedRouter.setClosed(this.unifiedRouter, false);

    if (httpServer && typeof httpServer.setRouterHandler === 'function') {
      const router = this.unifiedRouter;
      httpServer.setRouterHandler((req: HttpRequest, res: HttpResponse) =>
        router.handleRequest(req, res)
      );

      // A server that answers fixed replies itself (MoroEngineServer on an
      // engine with capabilities.staticRoutes) gets every route whose handler
      // is a literal body. The server decides whether the engine answers
      // them: only while it has no global middleware and no request or
      // response hook, so that an app.use() guard, a hook, or config-driven
      // CORS / helmet / request logging is in front of these routes exactly
      // as it is in front of every other one, whenever it was registered.
      // The route's handler stays registered: it answers then, and it
      // answers HEAD and everything on servers without the capability.
      if (typeof httpServer.setStaticRoute === 'function') {
        for (const schema of router.getAllRoutes()) {
          const fixed = schema.static;
          if (fixed) {
            httpServer.setStaticRoute(
              schema.method,
              schema.path,
              fixed.status,
              fixed.headers,
              fixed.body
            );
          }
        }
      }
      // Same for param(name) handlers on bare single-parameter routes: the
      // engine echoes the segment itself (engine >= 1.1.9). The body is
      // whatever the client put in the URL, so the reply always declares a
      // type: left without one, a browser works the type out from the bytes
      // and could render a segment that looks like markup.
      if (typeof httpServer.setParamRoute === 'function') {
        this.handParamEchoRoutes(httpServer, router);
      }
      // A route registered after listen() is handed over the same way, and
      // takes back an echo route it shadows.
      UnifiedRouter.setRouteListener(router, schema => {
        const fixed = schema.static;
        if (fixed && typeof httpServer.setStaticRoute === 'function') {
          httpServer.setStaticRoute(
            schema.method,
            schema.path,
            fixed.status,
            fixed.headers,
            fixed.body
          );
        }
        if (typeof httpServer.setParamRoute === 'function') {
          this.handParamEchoRoutes(httpServer, router);
        }
      });
      return;
    }

    this.coreFramework.addMiddleware(
      async (req: HttpRequest, res: HttpResponse, next: () => void) => {
        // Try unified router first (handles all route types)
        const handled = this.unifiedRouter.handleRequest(req, res);

        // Check if it's a promise (async route) or sync (fast-path)
        if (handled && typeof (handled as any).then === 'function') {
          // Async - await the result
          const isHandled = await (handled as Promise<boolean>);
          if (!isHandled) {
            next();
          }
        } else {
          // Sync - check immediately
          if (!(handled as boolean)) {
            next();
          }
        }
      }
    );
  }

  // Echo routes the server was given, as "METHOD path"
  private paramEchoKeys = new Set<string>();

  // Hand the server every param() echo route it can answer by itself. The
  // engine matches a param route by prefix and suffix alone, ahead of the
  // router, so an echo route is left to the router whenever another route of
  // the same method could match one of its paths: a literal '/user/me'
  // beside '/user/:id' must reach its own handler. One that was handed over
  // and is shadowed now (a route registered after listen()) is taken back.
  private handParamEchoRoutes(httpServer: any, router: UnifiedRouter): void {
    const all = router.getAllRoutes();
    // Segment by segment: a parameter matches any segment, a wildcard the
    // rest of the path, and trailing optional parameters may be absent.
    const segmentsOverlap = (a: string, b: string): boolean => {
      const sa = a.split('/');
      const sb = b.split('/');
      for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
        const x = sa[i];
        const y = sb[i];
        if (x === undefined || y === undefined) {
          return (x === undefined ? sb : sa).slice(i).every(seg => seg.endsWith('?'));
        }
        if (x.startsWith('*') || y.startsWith('*')) return true;
        if (x !== y && !x.startsWith(':') && !y.startsWith(':')) return false;
      }
      return true;
    };
    const wanted = all.filter(
      schema =>
        schema.paramEcho !== undefined &&
        !all.some(
          other =>
            other !== schema &&
            other.method === schema.method &&
            segmentsOverlap(schema.path, other.path)
        )
    );
    const keys = new Set(wanted.map(schema => `${schema.method} ${schema.path}`));
    for (const key of this.paramEchoKeys) {
      if (!keys.has(key)) {
        // The engine has no per-route removal: clear, then hand back the rest
        if (typeof httpServer.clearParamRoutes === 'function') httpServer.clearParamRoutes();
        break;
      }
    }
    for (const schema of wanted) {
      const echo = schema.paramEcho as NonNullable<typeof schema.paramEcho>;
      httpServer.setParamRoute(
        schema.method,
        echo.prefix,
        echo.suffix,
        echo.status,
        echo.headers ?? PARAM_ECHO_HEADERS
      );
    }
    this.paramEchoKeys = keys;
  }

  private registerDirectRoutes() {
    // Register routes directly with the HTTP server for optimal performance
    // This provides the intuitive developer experience users expect
    for (const route of this.routes) {
      const handler = this.routeHandlers[route.handler];
      if (!handler) continue;
      // A route with optional parameters or a wildcard is matched by the
      // unified router alone: one matcher, so one answer on every server
      if (hasExtendedSyntax(route.path)) continue;

      // Get direct access to the HTTP server through the core framework
      const httpServer = (this.coreFramework as any).httpServer;

      // What the route declared in the direct form: its middleware, rate
      // limit, auth, validation and cache. The unified router runs them on the
      // canonical URL; this table is reached for the variants only the server
      // matches (a trailing slash on the Node servers), and must run the same
      // phases, in the same order, before the handler.
      const registered = route.registered;

      // Create a wrapper handler that runs those phases and handles return values
      const wrappedHandler = async (req: any, res: any) => {
        try {
          // Enhance request with events property for direct routes
          req.events = this.eventBus;

          if (registered) {
            // The server matched this URL by dropping its trailing slash. The
            // phases see the path without it, so the rate-limit counter and
            // the cache entry are the ones the canonical URL uses and the
            // slash form is not a second allowance.
            const sentPath = req.path;
            const slashForm =
              typeof sentPath === 'string' && sentPath.length > 1 && sentPath.endsWith('/');
            if (slashForm) req.path = sentPath.slice(0, -1);
            try {
              const pending = this.unifiedRouter.runRoutePhases(registered, req, res);
              if (pending) await pending;
            } finally {
              if (slashForm) req.path = sentPath;
            }
            if (res.headersSent) return;
          }

          // Execute the actual handler
          const result = await handler(req, res);
          if (result && !res.headersSent) {
            res.json(result);
          }
        } catch (error) {
          // Route through user-registered error handler first, if any.
          if (this.errorHandler && !res.headersSent) {
            try {
              const handlerResult = this.errorHandler(error, req, res);
              if (handlerResult && typeof (handlerResult as any).then === 'function') {
                await handlerResult;
              }
              if (res.headersSent) return;
            } catch (handlerErr) {
              this.logger.error('Error handler itself threw', 'RequestHandler', {
                error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
              });
            }
          }
          this.logger.error('Route execution error', 'RequestHandler', {
            error: error instanceof Error ? error.message : String(error),
            route: `${route.method} ${route.path}`,
            requestId: req.requestId,
          });
          if (!res.headersSent) {
            res.status(500).json(directRouteFailureBody(error, req));
          }
        }
      };

      // Register with the appropriate HTTP method
      const method = route.method.toLowerCase();
      if (httpServer && httpServer[method]) {
        httpServer[method](route.path, wrappedHandler);
      }
    }
  }

  // Simple rate limiting for direct routes
  private rateLimitStore = new Map<string, { count: number; resetTime: number }>();

  private checkRateLimit(key: string, config: { requests: number; window: number }): boolean {
    const now = Date.now();
    const bucket = this.rateLimitStore.get(key);

    if (!bucket || now > bucket.resetTime) {
      // Create new bucket or reset expired bucket
      this.rateLimitStore.set(key, {
        count: 1,
        resetTime: now + config.window,
      });
      return true;
    }

    if (bucket.count >= config.requests) {
      return false; // Rate limit exceeded
    }

    bucket.count++;
    return true;
  }

  private setupDefaultMiddleware(_options: MoroOptions) {
    // cors/helmet/compression/bodySize are installed once by MoroCore.setupCore()
    // (config-driven, with the configured bodySizeLimit). Registering them here
    // again made every request run each of them twice.
  }

  // Enhanced auto-discovery initialization
  private async initializeAutoDiscovery(options: MoroOptions): Promise<void> {
    const { ModuleDiscovery } = await import('./core/modules/auto-discovery.js');

    // Merge auto-discovery configuration
    const autoDiscoveryConfig = this.mergeAutoDiscoveryConfig(options);

    if (!autoDiscoveryConfig.enabled) {
      return;
    }

    // Three auto-discovery settings are accepted but do not do what their
    // names say. Say so once at start-up instead of leaving an app without
    // routes, or with modules it meant to leave out.
    if (autoDiscoveryConfig.recursive === false) {
      this.logger.warn(
        'modules.autoDiscovery.recursive: false is not applied: a pattern that contains `**` ' +
          'reaches every directory under a path, down to maxDepth. To load only the files ' +
          'directly in each path, set maxDepth: 0 or use patterns without `**`.',
        'ModuleDiscovery'
      );
    }
    if (autoDiscoveryConfig.loadingStrategy === 'lazy') {
      this.logger.warn(
        "modules.autoDiscovery.loadingStrategy 'lazy' is not applied: discovered modules are " +
          "recorded but never loaded, so none of their routes is served. Use 'eager' (the " +
          "default) or 'conditional' to serve module routes.",
        'ModuleDiscovery'
      );
    }
    if (autoDiscoveryConfig.watchForChanges) {
      this.logger.warn(
        'modules.autoDiscovery.watchForChanges does not reload modules: a changed module file ' +
          "is detected and a 'modules:changed' event is emitted, but the running routes stay as " +
          'loaded. Restart the process to pick up the change (for example run it under ' +
          '`node --watch` or `tsx watch`).',
        'ModuleDiscovery'
      );
    }

    this.moduleDiscovery = new ModuleDiscovery(process.cwd());

    try {
      // Discover modules based on configuration
      const modules = await this.moduleDiscovery.discoverModulesAdvanced(autoDiscoveryConfig);

      // Load modules based on strategy
      await this.loadDiscoveredModules(modules, autoDiscoveryConfig);

      // Setup final module handler to run after user middleware (like auth)
      this.coreFramework.setupFinalModuleHandler();

      // Setup file watching if enabled
      if (autoDiscoveryConfig.watchForChanges) {
        this.moduleDiscovery.watchModulesAdvanced(
          autoDiscoveryConfig,
          async (updatedModules: ModuleConfig[]) => {
            await this.handleModuleChanges(updatedModules);
          }
        );
      }

      this.logger.info(
        `Auto-discovery completed: ${modules.length} modules loaded`,
        'ModuleDiscovery'
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (autoDiscoveryConfig.failOnError) {
        throw new Error(`Module auto-discovery failed: ${errorMsg}`);
      } else {
        this.logger.warn(`Module auto-discovery failed: ${errorMsg}`, 'ModuleDiscovery');
      }
    }
  }

  // Merge auto-discovery configuration from multiple sources
  private mergeAutoDiscoveryConfig(options: MoroOptions) {
    const defaultConfig = this.config.modules.autoDiscovery;

    // Handle legacy modulesPath option
    if (options.modulesPath && !options.autoDiscover) {
      return {
        ...defaultConfig,
        paths: [options.modulesPath],
      };
    }

    // Handle boolean autoDiscover option
    if (typeof options.autoDiscover === 'boolean') {
      return {
        ...defaultConfig,
        enabled: options.autoDiscover,
      };
    }

    // Handle object autoDiscover option
    if (typeof options.autoDiscover === 'object') {
      return {
        ...defaultConfig,
        ...options.autoDiscover,
      };
    }

    return defaultConfig;
  }

  // Load discovered modules based on strategy
  private async loadDiscoveredModules(
    modules: ModuleConfig[],
    config: ModuleDefaultsConfig['autoDiscovery']
  ): Promise<void> {
    switch (config.loadingStrategy) {
      case 'eager':
        // Load all modules immediately
        for (const module of modules) {
          await this.loadModule(module);
        }
        break;

      case 'lazy':
        // Register modules for lazy loading
        this.registerLazyModules(modules);
        break;

      case 'conditional':
        // Load modules based on conditions
        await this.loadConditionalModules(modules);
        break;

      default:
        // Default to eager loading
        for (const module of modules) {
          await this.loadModule(module);
        }
    }
  }

  // Register modules for lazy loading
  private registerLazyModules(modules: ModuleConfig[]): void {
    modules.forEach(module => {
      // Store module for lazy loading when first route is accessed
      this.lazyModules.set(module.name, module);

      // Register placeholder routes that trigger lazy loading
      if (module.routes) {
        module.routes.forEach(route => {
          const basePath = buildModuleBasePath(
            this.config.modules?.apiPrefix,
            module.version,
            module.name
          );
          // Handle root path within module: '/' should map to basePath, not basePath + '/'
          const routePath = route.path === '/' ? '' : route.path;
          const fullPath = `${basePath}${routePath}`;

          // Note: Lazy loading will be implemented when route is accessed
          // For now, we'll store the module for later loading
          this.logger.debug(
            `Registered lazy route: ${route.method} ${fullPath}`,
            'ModuleDiscovery'
          );
        });
      }
    });

    this.logger.info(`Registered ${modules.length} modules for lazy loading`, 'ModuleDiscovery');
  }

  // Load modules conditionally based on environment or configuration
  private async loadConditionalModules(modules: ModuleConfig[]): Promise<void> {
    for (const module of modules) {
      const shouldLoad = this.shouldLoadModule(module);

      if (shouldLoad) {
        await this.loadModule(module);
      } else {
        this.logger.debug(`Skipping module ${module.name} due to conditions`, 'ModuleDiscovery');
      }
    }
  }

  // Determine if a module should be loaded based on conditions
  private shouldLoadModule(module: ModuleConfig): boolean {
    const moduleConfig = module.config as any;

    // Check environment conditions
    if (moduleConfig?.conditions?.environment) {
      const requiredEnv = moduleConfig.conditions.environment;
      const currentEnv = process.env.NODE_ENV || 'development';

      if (Array.isArray(requiredEnv)) {
        if (!requiredEnv.includes(currentEnv)) {
          return false;
        }
      } else if (requiredEnv !== currentEnv) {
        return false;
      }
    }

    // Check feature flags
    if (moduleConfig?.conditions?.features) {
      const requiredFeatures = moduleConfig.conditions.features;

      for (const feature of requiredFeatures) {
        if (!process.env[`FEATURE_${feature.toUpperCase()}`]) {
          return false;
        }
      }
    }

    // Check custom conditions
    if (moduleConfig?.conditions?.custom) {
      const customCondition = moduleConfig.conditions.custom;

      if (typeof customCondition === 'function') {
        return customCondition();
      }
    }

    return true;
  }

  // Handle module changes during development
  private async handleModuleChanges(modules: ModuleConfig[]): Promise<void> {
    this.logger.info('Module changes detected, reloading...', 'ModuleDiscovery');

    // Unload existing modules (if supported)
    // For now, just log the change
    void this.eventBus.emit('modules:changed', {
      modules: modules.map(m => ({ name: m.name, version: m.version })),
      timestamp: new Date(),
    });
  }

  // Legacy method for backward compatibility
  private autoDiscoverModules(modulesPath: string) {
    // Redirect to new system (legacy sync shim over the async discovery path).
    void this.initializeAutoDiscovery({
      autoDiscover: {
        enabled: true,
        paths: [modulesPath],
      },
    }).catch(err => this.logger.error(`Auto-discovery failed: ${String(err)}`, 'ModuleDiscovery'));
  }

  private async importModule(modulePath: string): Promise<ModuleConfig> {
    // Convert file path to proper file URL for Windows compatibility
    const importURL = filePathToImportURL(modulePath);
    const module = await import(importURL);
    return module.default || module;
  }

  /**
   * Node.js Clustering Implementation
   * This clustering algorithm is based on published research and Node.js best practices.
   *
   * IPC (Inter-Process Communication) Considerations:
   * - Excessive workers create IPC bottlenecks (Source: BetterStack Node.js Guide)
   * - Round-robin scheduling provides better load distribution (Node.js Documentation)
   * - Message passing overhead increases significantly with worker count
   *
   * Memory Management:
   * - ~2GB per worker prevents memory pressure and GC overhead
   * - Conservative heap limits reduce memory fragmentation
   *
   * References:
   * - Node.js Cluster Documentation: https://nodejs.org/api/cluster.html
   * - BetterStack Node.js Clustering: https://betterstack.com/community/guides/scaling-nodejs/node-clustering/
   */
  private clusterWorkers = new Map<number, any>();

  private threadCluster: ThreadClusterPrimary | undefined = undefined;

  // Process transport: stops the worker processes within a deadline. Set by
  // startProcessPrimary(), used (and cleared) by close().
  private stopProcessWorkers: ((deadlineMs?: number) => Promise<void>) | undefined = undefined;

  // listen() has started this instance as a cluster primary or a cluster
  // worker; cleared by close().
  private clusterStarted = false;

  // The SIGINT/SIGTERM listeners of the cluster primary, kept so the thread
  // transport's can be taken off again when it falls back to processes.
  private clusterSignalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  private static clusteringModeWarned = false;

  // Graceful shutdown of a cluster primary, the same for both transports:
  // close() stops the workers (each drains its server through its own
  // close()) and then the primary's own services; a second signal exits at
  // once.
  private installClusterSignalHandlers(): void {
    this.removeClusterSignalHandlers();
    let shuttingDown = false;
    const gracefulShutdown = () => {
      if (shuttingDown) {
        process.exit(0);
        return;
      }
      shuttingDown = true;
      this.logger.info('Gracefully shutting down cluster...', 'Cluster');
      Moro.holdEventLoopUntilExit();
      this.close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, gracefulShutdown);
      this.clusterSignalHandlers.push([signal, gracefulShutdown]);
    }
  }

  private removeClusterSignalHandlers(): void {
    for (const [signal, handler] of this.clusterSignalHandlers) {
      process.removeListener(signal, handler);
    }
    this.clusterSignalHandlers = [];
  }

  // Entry point for performance.clustering: decides whether THIS instance is
  // a worker (thread or process) or the primary, and which transport the
  // primary uses. Config keys are unchanged; the transport is automatic.
  private startWithClustering(port: number, host?: string, callback?: () => void): void {
    // A second listen() must not start a second set of workers (or, in a
    // worker, a second listener): the same answer the server gives when it
    // is already listening.
    if (this.clusterStarted) {
      this.logger.warn('Server is already listening', 'Listen');
      return;
    }
    this.clusterStarted = true;

    const { count: workerCount, detail } = computeWorkerCount(this.config.performance?.clustering);
    const tinfo = threadWorkerInfo();
    if (tinfo) {
      this.startClusterWorker({ kind: 'thread', info: tinfo }, port, host);
      return;
    }
    if (nodeCluster().isWorker) {
      this.startClusterWorker({ kind: 'process' }, port, host);
      return;
    }
    this.logger.info(detail, 'Cluster');
    if (
      (this.config.performance?.clustering as { mode?: string } | undefined)?.mode === 'proxy' &&
      !Moro.clusteringModeWarned
    ) {
      Moro.clusteringModeWarned = true;
      this.logger.warn(
        "performance.clustering.mode: 'proxy' is not applied. Workers always bind the port " +
          'themselves (worker threads with SO_REUSEPORT, or node:cluster worker processes); ' +
          'the setting has no effect.',
        'Cluster'
      );
    }
    const engineKind = this.engine;
    const transport = resolveClusterTransport({
      platform: process.platform,
      isMainThread: wt().isMainThread,
      argv1: process.argv[1],
      engineServer: engineKind.server,
      enginePackage: engineKind.enginePackage,
      workerThreadsCapable: loadNativeEngine()?.capabilities?.workerThreads === true,
    });
    if (transport.kind === 'threads') {
      this.startThreadPrimary(transport.entry, workerCount, port, host, callback);
      return;
    }
    this.logger.info(
      `Clustering: ${workerCount} worker processes (node:cluster; ${transport.reason})`,
      'Cluster'
    );
    this.startProcessPrimary(workerCount, port, host, callback);
  }

  // Services that must run exactly ONCE per cluster, in the primary: the job
  // scheduler (leader election already treats the main thread of a
  // non-cluster-worker process as a participant) and the gRPC server (its own
  // port). GraphQL registers HTTP/WS routes, so it initialises in every
  // worker instead. Before 1.9.0 none of these started under clustering.
  private startPrimaryServices(): void {
    this.startJobScheduler().catch(err => {
      this.logger.error(`Failed to start job scheduler: ${String(err)}`);
    });
    if (this.grpcManager && !this.grpcStarted) {
      this.startGrpc().catch(error => {
        logErrorLines(this.logger, 'Failed to start gRPC server', error, 'GRPC');
      });
    }
  }

  private startThreadPrimary(
    entry: string,
    workerCount: number,
    port: number,
    host: string | undefined,
    callback?: () => void
  ): void {
    // The libuv threadpool is process-wide and sized once at first use;
    // the process path set this per worker process. Only if the operator
    // did not choose a size.
    if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';
    // Same young-generation bound the process path applies through execArgv
    // (see YOUNG_GEN_MB_FOR_SEMI_SPACE_4), unless the operator tuned GC.
    const resourceLimits = isUserTunedYoungGen()
      ? undefined
      : { maxYoungGenerationSizeMb: YOUNG_GEN_MB_FOR_SEMI_SPACE_4 };

    const engineKind = this.engine;
    this.logger.info(
      `Clustering: ${workerCount} worker threads (worker_threads + SO_REUSEPORT, ` +
        `${engineKind.enginePackage}${engineKind.engineVersion ? ` v${engineKind.engineVersion}` : ''})`,
      'Cluster'
    );

    let fellBack = false;
    const fallBackToProcesses = (why: string) => {
      if (fellBack) return;
      fellBack = true;
      this.logger.warn(
        `Worker threads unavailable (${why}); falling back to worker processes`,
        'Cluster'
      );
      const primary = this.threadCluster;
      this.threadCluster = undefined;
      // The process transport installs its own. Left in place, this
      // transport's listeners would answer the signal as well, find no
      // thread to wait for and exit the primary under the worker processes.
      this.removeClusterSignalHandlers();
      void primary?.shutdown(1000).finally(() => {
        this.startProcessPrimary(workerCount, port, host, callback);
      });
    };

    const primary = new ThreadClusterPrimary({
      entry,
      argv: process.argv.slice(2),
      workerCount,
      logger: this.logger,
      ...(resourceLimits ? { resourceLimits } : {}),
      onReady: () => {
        this.startPrimaryServices();
        if (callback) callback();
      },
      onFatal: (error, kind) => {
        if (kind === 'bind') {
          // Processes would fail identically: surface it like the single-process
          // path does (Node's server convention; rethrows without a listener).
          this.emit('error', error);
          return;
        }
        fallBackToProcesses(error.message);
      },
    });
    this.threadCluster = primary;
    try {
      primary.start();
    } catch (error) {
      fallBackToProcesses(error instanceof Error ? error.message : String(error));
      return;
    }

    // Graceful shutdown: drain every worker thread (each closes its server),
    // then the primary's own services; a second signal exits at once.
    this.installClusterSignalHandlers();
  }

  private startProcessPrimary(
    workerCount: number,
    port: number,
    host: string | undefined,
    callback?: () => void
  ): void {
    void port;
    void host;
    this.logger.info(`Starting ${workerCount} workers`, 'Cluster');

    // Optimize cluster scheduling for high concurrency
    // Round-robin is the default on all platforms except Windows (Node.js docs)
    // Provides better load distribution than shared socket approach
    nodeCluster().schedulingPolicy = nodeCluster().SCHED_RR;

    // Workers inherit the primary's execArgv; additionally bound each
    // worker's V8 young generation unless the user tuned it themselves.
    // On big machines V8 sizes the nursery from total RAM and grows it
    // under sustained load (~10-34 MB extra RSS per process, measured on a
    // 64 GB box) - and in cluster mode that cost multiplies by the worker
    // count. A/B-benched 2026-08-01: identical throughput at 4 MB semi-space
    // in both the realistic profile (~92k vs ~90k req/s) and the pipelined
    // x10 microbenchmark (~560k both ways), while sustained-load RSS drops
    // ~30 MB per worker (115 -> 81 MB on the 25-route POST soak).
    const userTunedGC = isUserTunedYoungGen();

    // Set cluster settings for better performance
    nodeCluster().setupMaster({
      exec: process.argv[1] || process.execPath,
      args: process.argv.slice(2),
      silent: false,
      ...(userTunedGC ? {} : { execArgv: [...process.execArgv, '--max-semi-space-size=4'] }),
    });

    // IPC Optimization: Reduce communication overhead between master and workers
    // Research shows excessive IPC can create bottlenecks in clustered applications
    // (Source: BetterStack - Node.js Clustering Guide)
    process.env.NODE_CLUSTER_SCHED_POLICY = 'rr'; // Ensure round-robin
    process.env.NODE_DISABLE_COLORS = '1'; // Reduce IPC message size by disabling color codes

    // One slot per configured worker. A slot whose worker died is forked
    // again after the delay the thread transport uses (nextRestartDelay), and
    // never while the cluster is stopping.
    const slots = new Map<number, { slot: number; startedAt: number }>();
    const backoff = new Map<number, RestartState>();
    const restartTimers = new Set<ReturnType<typeof setTimeout>>();
    const onWorkerMessage = this.handleWorkerMessage.bind(this);
    let nextSlot = workerCount;
    let stopping = false;

    const forkWorker = (slot: number, verb: 'started' | 'restarted') => {
      const worker = nodeCluster().fork();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const pid = worker.process.pid!;
      this.clusterWorkers.set(pid, worker);
      slots.set(pid, { slot, startedAt: Date.now() });
      this.logger.info(`Worker ${pid} ${verb}`, 'Cluster');

      // Handle individual worker messages
      worker.on('message', onWorkerMessage);
    };

    const scheduleRestart = (slot: number, aliveMs: number, why: string) => {
      const state = backoff.get(slot) ?? { restarts: 0, lastStart: 0 };
      const delay = nextRestartDelay(state, aliveMs, Date.now());
      backoff.set(slot, state);
      this.logger.warn(`${why}. Restarting in ${delay} ms...`, 'Cluster');
      // Referenced on purpose: with every worker down, this timer is what
      // keeps the primary alive until the next attempt.
      const timer = setTimeout(() => {
        restartTimers.delete(timer);
        if (stopping) return;
        try {
          forkWorker(slot, 'restarted');
        } catch (error) {
          scheduleRestart(
            slot,
            0,
            `Worker restart failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }, delay);
      restartTimers.add(timer);
    };

    // Primary-only services start once the first worker is serving.
    let servicesStarted = false;
    const onListening = () => {
      if (servicesStarted) return;
      servicesStarted = true;
      this.startPrimaryServices();
    };

    const onExit = (worker: any, code: number, signal: string) => {
      const pid = worker.process.pid;
      this.clusterWorkers.delete(pid);
      const known = slots.get(pid);
      slots.delete(pid);
      if (stopping) return;

      if (code !== 0 && !worker.exitedAfterDisconnect) {
        scheduleRestart(
          known ? known.slot : nextSlot++,
          known ? Date.now() - known.startedAt : 0,
          `Worker ${pid} died unexpectedly (${signal || code})`
        );
      }
    };

    // Stop every worker: SIGTERM (each stops accepting, drains its in-flight
    // responses through its own close(), then exits), wait for the exits up
    // to the deadline, SIGKILL whatever is left. The primary must outlive
    // them: a node:cluster worker whose primary disappears exits at once,
    // cutting the very responses it was draining.
    this.stopProcessWorkers = (deadlineMs = 3000) => {
      stopping = true;
      for (const timer of restartTimers) clearTimeout(timer);
      restartTimers.clear();
      nodeCluster().removeListener('listening', onListening);

      const workers = Array.from(this.clusterWorkers);
      return new Promise<void>(resolve => {
        const pending = new Set<number>(workers.map(([pid]) => pid));
        let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
        let killGrace: ReturnType<typeof setTimeout> | undefined = undefined;
        const finish = () => {
          clearTimeout(deadline);
          clearTimeout(killGrace);
          nodeCluster().removeListener('exit', onExit);
          // onExit is gone before it has seen the last of these exits
          for (const [pid] of workers) {
            this.clusterWorkers.delete(pid);
            slots.delete(pid);
          }
          resolve();
        };
        if (pending.size === 0) {
          finish();
          return;
        }
        deadline = setTimeout(() => {
          this.logger.warn(
            `Shutdown deadline reached; terminating ${pending.size} worker process(es)`,
            'Cluster'
          );
          for (const pid of pending) this.clusterWorkers.get(pid)?.kill('SIGKILL');
          // SIGKILL cannot be refused; the exits follow at once. The short
          // wait only keeps a lost 'exit' event from holding close() open.
          killGrace = setTimeout(finish, 500);
        }, deadlineMs);
        for (const [pid, worker] of workers) {
          worker.once('exit', () => {
            pending.delete(pid);
            if (pending.size === 0) finish();
          });
          worker.kill('SIGTERM');
        }
      });
    };

    // SIGINT/SIGTERM: close() - the workers above, then the job scheduler
    // (which releases the leader lock), the onClose hooks and the rest - and
    // only then exit.
    this.installClusterSignalHandlers();

    // Fork workers with basic tracking
    for (let i = 0; i < workerCount; i++) forkWorker(i, 'started');

    nodeCluster().on('listening', onListening);
    nodeCluster().on('exit', onExit);

    // Master process callback
    if (callback) callback();
  }

  // One worker, either a worker_threads thread or a node:cluster process:
  // boot the app exactly like the single-process path (auto-discovery,
  // file-based routes, WebSocket registrations, GraphQL) and listen with
  // SO_REUSEPORT. Signals/exit are the differences: a thread gets 'shutdown'
  // from the primary over parentPort and never calls process.exit().
  private startClusterWorker(
    mode: { kind: 'thread'; info: ThreadWorkerInfo } | { kind: 'process' },
    port: number,
    host?: string
  ): void {
    const label =
      mode.kind === 'thread' ? `Worker thread ${wt().threadId}` : `Worker ${process.pid}`;
    const workerRef = mode.kind === 'thread' ? wt().threadId : process.pid;
    this.logger.info(`${label} initializing`, 'Worker');

    if (mode.kind === 'process' && !process.env.UV_THREADPOOL_SIZE) {
      // A worker process has a libuv pool of its own, sized at first use (a
      // thread shares the primary's, sized before it was spawned). Only if
      // the operator did not choose a size: this is one pool per process,
      // and sixty-four processes with sixty-four threads each is a choice
      // the operator must be able to make the other way.
      process.env.UV_THREADPOOL_SIZE = '64';
    }

    // Reduce logging contention in workers (major bottleneck)
    // Multiple workers writing to same log files creates I/O contention
    // ONLY reduce log level if user didn't explicitly set one
    if (!this.userSetLogger) {
      // Workers log less frequently to reduce I/O contention (only if not explicitly configured)
      applyLoggingConfiguration(undefined, { level: 'warn' }); // Only warnings and errors
    }

    // Optimize garbage collection for workers
    // eslint-disable-next-line no-undef
    if ((global as any).gc) {
      const gcTimer = setInterval(() => {
        // eslint-disable-next-line no-undef
        if ((global as any).gc) (global as any).gc();
      }, 60000); // GC every 60 seconds (less frequent)
      // Housekeeping only: it must not be what keeps a closed worker alive
      gcTimer.unref();
    }

    let tcw: ThreadClusterWorker | null = null;
    if (mode.kind === 'thread') {
      tcw = new ThreadClusterWorker(this.logger);
      // 'shutdown' from the primary: drain and close; the thread then exits
      // on its own once the engine's handles are gone.
      tcw.onShutdown(async () => {
        this.eventBus.removeAllListeners();
        this.removeAllListeners();
        await this.close();
      });
    } else {
      // Graceful shutdown for worker: the same close() the single-process
      // and worker-thread paths run (onClose hooks, in-flight requests,
      // subsystems), then exit.
      let closing = false;
      const workerShutdown = () => {
        // Ctrl-C reaches the worker twice, once from the terminal and once
        // as the primary's SIGTERM: the second one changes nothing.
        if (closing) return;
        closing = true;
        this.logger.info(`${label} shutting down gracefully...`, 'Worker');

        // The primary kills a worker that has not exited 3 s after it asked;
        // a worker signalled directly holds itself to the same bound. The
        // timer is referenced, so close() is not cut short by an event loop
        // that happens to empty before it has finished.
        setTimeout(() => process.exit(0), 3000);

        // Clean up event listeners
        this.eventBus.removeAllListeners();
        this.removeAllListeners();

        this.close().then(
          () => process.exit(0),
          () => process.exit(1)
        );
      };

      // Handle worker shutdown signals
      process.on('SIGTERM', workerShutdown);
      process.on('SIGINT', workerShutdown);
    }

    const fatal = (code: string, message: string) => {
      this.logger.error(`${label} ${message}`, 'Worker');
      if (tcw) {
        tcw.fatal(code, message);
        void this.close().finally(() => tcw?.close());
      } else {
        process.exit(1);
      }
    };

    // Continue with normal server startup for this worker
    void this.eventBus.emit('server:starting', {
      port,
      runtime: this.runtimeType,
      worker: workerRef,
    });

    // Add documentation middleware first (if enabled)
    try {
      const docsMiddleware = this.documentation.getDocsMiddleware();
      this.coreFramework.addMiddleware(docsMiddleware);
    } catch {
      // Documentation not enabled, that's fine
    }

    // Attach the unified router (handles both chainable and direct routes)
    this.attachUnifiedRouter();

    // Register legacy direct routes with the HTTP server (for backward compatibility)
    if (this.routes.length > 0) {
      this.registerDirectRoutes();
    }

    const workerCallback = () => {
      const displayHost = host || 'localhost';
      this.logger.info(`${label} ready on ${displayHost}:${port}`, 'Worker');
      void this.eventBus.emit('server:started', {
        port,
        runtime: this.runtimeType,
        worker: workerRef,
        engine: this.engine,
      });
      // GraphQL registers HTTP/WS routes on this app: every worker.
      this.ensureGraphQLInitialized().catch(error => {
        logErrorLines(this.logger, 'Failed to initialize GraphQL', error, 'GraphQL');
      });
      tcw?.ready(port);
    };

    const startWorkerListening = () => {
      if (host) {
        this.coreFramework.listen(port, host, workerCallback);
      } else {
        this.coreFramework.listen(port, workerCallback);
      }
    };
    // Same init as the single-process path: auto-discovery, file-based
    // routes, queued WebSocket registrations - before 1.9.0 workers skipped
    // discovery/route loading entirely.
    Promise.all([
      this.ensureAutoDiscoveryComplete().then(() => this.ensureRoutesLoaded()),
      this.processQueuedWebSocketRegistrations(),
    ])
      .then(startWorkerListening)
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as any)?.code;
        // listen() itself failed (EADDRINUSE etc.): retrying is guaranteed to
        // fail again and would surface as an unhandled rejection crash-loop.
        // Report fatally so the primary sees a clean death.
        if (
          code === 'EADDRINUSE' ||
          code === 'EACCES' ||
          /EADDRINUSE|failed to bind/i.test(message)
        ) {
          fatal(
            code === 'EACCES' ? 'EACCES' : 'EADDRINUSE',
            `could not bind port ${port}: ${message}`
          );
          return;
        }
        this.logger.error('Initialization failed in worker', 'Worker', { error: message });
        // For WebSocket failures with queued registrations, error will propagate
        if (
          error instanceof Error &&
          error.message.includes('WebSocket features require a WebSocket adapter')
        ) {
          throw error;
        }
        // Init failed but the HTTP server can still serve: start anyway, and
        // surface (not swallow) a listen failure from this path.
        try {
          startWorkerListening();
        } catch (listenError) {
          const lm = listenError instanceof Error ? listenError.message : String(listenError);
          fatal(
            (listenError as any)?.code === 'EACCES' ? 'EACCES' : 'EADDRINUSE',
            `failed to start: ${lm}`
          );
        }
      });
  }

  // Simple worker message handler
  private handleWorkerMessage(message: any): void {
    // Handle inter-worker communication if needed. A worker can send any
    // value, null included (process.send(null)).
    if (message?.type === 'health-check') {
      // Worker health check response
      return;
    }

    // Log other worker messages
    this.logger.debug(`Worker message: ${JSON.stringify(message)}`, 'Cluster');
  }

  /**
   * Gracefully close the application and clean up resources
   * This should be called in tests and during shutdown
   */
  private shutdownHandlersRegistered = false;
  private isShuttingDown = false;
  // Per-instance opt-in uncaught-error listeners (removed by close()).
  private processListeners: Array<[string, (...args: any[]) => void]> = [];

  // Graceful shutdown is driven by ONE process-level SIGINT/SIGTERM handler
  // shared across every Moro instance (installed once), so creating many apps
  // never accumulates process listeners. Instances register here on listen()
  // and deregister on close().
  private static activeInstances = new Set<Moro>();
  private static globalSignalsInstalled = false;
  private static globalShuttingDown = false;

  // A shutdown that ends in process.exit() must reach it. close() waits on
  // timers that do not hold the event loop (the job scheduler polls a running
  // job that way), and once the listener and the workers are gone nothing
  // else may: Node would then exit with close() half done - the leader lock
  // not released, queues and mail not shut down. One referenced timer keeps
  // the loop alive until the handler's own process.exit().
  private static holdEventLoopUntilExit(): void {
    setInterval(() => {}, 0x7fffffff);
  }

  private static installGlobalShutdownSignals(): void {
    if (Moro.globalSignalsInstalled) return;
    Moro.globalSignalsInstalled = true;

    const handle = (signal: string, code: number) => {
      // A second signal while already draining forces an immediate exit, so a
      // stuck shutdown can never make the process unkillable via Ctrl-C.
      if (Moro.globalShuttingDown) {
        process.exit(code);
        return;
      }
      Moro.globalShuttingDown = true;
      Moro.holdEventLoopUntilExit();
      const instances = Array.from(Moro.activeInstances);
      instances[0]?.logger.info(`Received ${signal}, shutting down gracefully...`, 'Server');
      Promise.allSettled(instances.map(inst => inst.close()))
        .then(() => process.exit(code))
        .catch(() => process.exit(1));
    };

    process.on('SIGINT', () => handle('SIGINT', 0));
    process.on('SIGTERM', () => handle('SIGTERM', 0));
  }

  /**
   * Enable graceful shutdown for this instance. SIGINT/SIGTERM (Ctrl-C) drain
   * in-flight work via close() by default; a second signal force-exits. Opt out
   * with `server.gracefulShutdown: false` (e.g. when the host app owns signals).
   * Uncaught-error draining is separate and opt-in (`server.handleUncaught`).
   */
  private registerProcessShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) return;
    const serverCfg = this.config.server as any;
    if (serverCfg?.gracefulShutdown === false) return; // default ON; opt out here
    this.shutdownHandlersRegistered = true;

    Moro.activeInstances.add(this);
    Moro.installGlobalShutdownSignals();

    // Opt-in uncaught-error draining (per instance, removed on close()).
    if (serverCfg?.handleUncaught === true) {
      const add = (event: string, handler: (...args: any[]) => void) => {
        process.on(event as any, handler);
        this.processListeners.push([event, handler]);
      };
      add('unhandledRejection', reason => {
        this.logger.error(`Unhandled promise rejection: ${String(reason)}`, 'Server');
        this.drainAndExit(1);
      });
      add('uncaughtException', err => {
        this.logger.error(
          `Uncaught exception: ${err instanceof Error ? err.stack || err.message : String(err)}`,
          'Server'
        );
        this.drainAndExit(1);
      });
    }
  }

  private drainAndExit(code: number): void {
    if (this.isShuttingDown) {
      process.exit(code);
      return;
    }
    this.isShuttingDown = true;
    Moro.holdEventLoopUntilExit();
    this.close()
      .then(() => process.exit(code))
      .catch(() => process.exit(1));
  }

  /** Deregister this instance from process shutdown handling (called by close()). */
  private removeProcessShutdownHandlers(): void {
    Moro.activeInstances.delete(this);
    for (const [event, handler] of this.processListeners) {
      process.removeListener(event as any, handler);
    }
    this.processListeners = [];
    this.shutdownHandlersRegistered = false;
  }

  async close(): Promise<void> {
    this.logger.debug('Closing Moro application...');

    // No longer the current app while another one is open; this router's
    // rate-limit counters go with the listener. Routes registered from here
    // on are handed to the server at the next listen().
    UnifiedRouter.setClosed(this.unifiedRouter, true);
    UnifiedRouter.setRouteListener(this.unifiedRouter, undefined);

    // Detach our process signal listeners so repeated create/close cycles
    // (tests, or a host that spins up many apps) don't leak process listeners.
    this.removeProcessShutdownHandlers();

    // Run user-registered onClose hooks first, while subsystems are still alive.
    // Failures in one hook don't prevent subsequent hooks or Moro's own teardown.
    if (this.closeHooks.length > 0) {
      for (const hook of this.closeHooks) {
        try {
          await hook();
        } catch (err) {
          this.logger.error(`onClose hook failed: ${String(err)}`);
        }
      }
    }

    // Cluster worker threads first: each drains its server via its own
    // close(); the primary's services below stop after the traffic did.
    if (this.threadCluster) {
      const primary = this.threadCluster;
      this.threadCluster = undefined;
      try {
        await primary.shutdown();
      } catch (err) {
        this.logger.error(`Error shutting down cluster worker threads: ${String(err)}`);
      }
    }

    // Cluster worker processes, the same way and within the same deadline.
    if (this.stopProcessWorkers) {
      const stopWorkers = this.stopProcessWorkers;
      this.stopProcessWorkers = undefined;
      try {
        await stopWorkers();
      } catch (err) {
        this.logger.error(`Error shutting down cluster worker processes: ${String(err)}`);
      }
    }
    this.clusterStarted = false;

    // Shutdown worker threads first (fastest)
    try {
      this.logger.info('Shutting down worker threads...');
      await this.workerFacade.shutdown();
    } catch {
      // Workers might not be initialized or available
      this.logger.debug('Worker threads not available for shutdown');
    }

    // Shutdown job scheduler
    if (this.jobScheduler) {
      try {
        this.logger.info('Shutting down job scheduler...');
        await this.jobScheduler.shutdown();
        this.jobsStarted = false;
      } catch (err) {
        this.logger.error(`Error shutting down job scheduler: ${String(err)}`);
      }
    }

    // Shutdown gRPC server
    if (this.grpcManager && this.grpcStarted) {
      try {
        this.logger.info('Shutting down gRPC server...');
        await this.stopGrpc();
      } catch (err) {
        this.logger.error(`Error shutting down gRPC server: ${String(err)}`);
      }
    }

    // Cleanup GraphQL adapter resources
    if (this.graphqlCore) {
      try {
        await this.graphqlCore.cleanup();
      } catch (err) {
        this.logger.error(`Error cleaning up GraphQL: ${String(err)}`);
      }
    }

    // Flush logger buffer before shutdown
    try {
      // Use flushBuffer for immediate synchronous flush
      this.logger.flushBuffer();
    } catch {
      // Ignore flush errors during shutdown
    }

    // Close the core framework with timeout
    if (this.coreFramework && (this.coreFramework as any).httpServer) {
      try {
        const httpServer = (this.coreFramework as any).httpServer;
        const server = httpServer.getServer?.() || httpServer.getApp?.();

        // Only wait for close if the server is actually listening
        const isListening = server?.listening || server?.address?.() !== null;

        if (isListening) {
          // Stop accepting new connections and let in-flight requests finish,
          // but don't hang on idle keep-alive / WebSocket connections: close
          // idle sockets right away, then force-close whatever remains at the
          // deadline so this promise reflects a real close instead of only the
          // timer firing. (closeIdle/closeAllConnections exist on the Node http
          // server; the engine backend ignores the optional calls.)
          server?.closeIdleConnections?.();
          this.coreFramework.stopTlsWatch();
          // The engine server reports the close through a callback; the
          // Node http and HTTP/2 servers take no callback and return a
          // promise. Whichever this server offers settles the wait. The
          // deadline timer stays referenced until then: were it the only
          // thing left, an unreferenced one would let the process exit with
          // this await still pending.
          let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
          try {
            await Promise.race([
              new Promise<void>(resolve => {
                const closed = () => resolve();
                const returned = httpServer.close(closed);
                if (typeof returned?.then === 'function') returned.then(closed, closed);
              }),
              new Promise<void>(resolve => {
                deadline = setTimeout(() => {
                  try {
                    server?.closeAllConnections?.();
                  } catch {
                    // best-effort force-close
                  }
                  resolve();
                }, 2000); // 2 second grace period
              }),
            ]);
          } finally {
            clearTimeout(deadline);
          }
        } else {
          // Server was never started, just skip close
          this.logger.debug('HTTP server was never started, skipping close');
        }
      } catch {
        // Force close if graceful close fails
        this.logger.warn('Force closing HTTP server due to timeout');
      }
    }

    // Clean up module discovery watchers
    if (this.moduleDiscovery && typeof this.moduleDiscovery.cleanup === 'function') {
      try {
        this.moduleDiscovery.cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }

    // Shutdown queue manager
    if (this.queueManager) {
      try {
        await this.queueManager.shutdown();
        this.logger.debug('Queue system shutdown complete');
      } catch (error) {
        this.logger.warn(`Error shutting down queue system: ${error}`);
      }
    }
    // Clear queue state on close
    this.queueConfigs.clear();
    this.queueInitialized = false;
    this.queueInitPromise = undefined;
    this.queueManager = undefined;

    // Shutdown mail system
    if (this.mailManager) {
      try {
        await this.mailManager.close();
        this.logger.debug('Mail system shutdown complete');
      } catch (error) {
        this.logger.warn(`Error shutting down mail system: ${error}`);
      }
    }

    // Clean up event listeners
    try {
      this.eventBus.removeAllListeners();
      this.removeAllListeners();
    } catch {
      // Ignore cleanup errors
    }

    this.logger.debug('Moro application closed successfully');
  }

  // ========================================
  // Job Scheduling API
  // ========================================

  /**
   * Register a background job with cron or interval schedule
   * @param name - Job name (used for identification)
   * @param schedule - Cron expression, interval string ('5m', '1h'), or schedule object
   * @param handler - Job function to execute
   * @param options - Job configuration options
   * @returns Job ID for management
   *
   * @example
   * // Cron schedule
   * app.job('cleanup', '0 2 * * *', async () => {
   *   await cleanupOldData();
   * });
   *
   * // Interval schedule
   * app.job('health-check', '5m', async (ctx) => {
   *   console.log('Health check', ctx.executionId);
   * });
   *
   * // Advanced options
   * app.job('report', '@daily', generateReport, {
   *   timeout: 60000,
   *   maxRetries: 3,
   *   onError: (ctx, error) => console.error('Job failed', error)
   * });
   */
  job(
    name: string,
    schedule: string | JobSchedule,
    handler: JobFunction,
    options: SimpleJobOptions = {}
  ): string {
    if (!this.jobScheduler) {
      throw new Error('Job scheduler is not enabled. Set config.jobs.enabled = true');
    }

    let jobSchedule: JobSchedule;

    // Parse schedule input
    if (typeof schedule === 'string') {
      // Check if it's a cron expression or interval
      if (schedule.match(/^(\d+[smhd]|\d+\s*(seconds?|minutes?|hours?|days?))$/i)) {
        // Interval format
        jobSchedule = everyInterval(schedule);
      } else {
        // Cron format
        jobSchedule = cronSchedule(schedule, options.timezone);
      }
    } else {
      jobSchedule = schedule;
    }

    const jobOptions: Partial<JobOptions> = {
      name: options.name || name,
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
      ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.retryDelay !== undefined ? { retryDelay: options.retryDelay } : {}),
      ...(options.retryBackoff !== undefined ? { retryBackoff: options.retryBackoff } : {}),
      ...(options.enableCircuitBreaker !== undefined
        ? { enableCircuitBreaker: options.enableCircuitBreaker }
        : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      ...(options.onStart !== undefined ? { onStart: options.onStart } : {}),
      ...(options.onComplete !== undefined ? { onComplete: options.onComplete } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    };

    const jobId = this.jobScheduler.registerJob(name, jobSchedule, handler, jobOptions);

    this.logger.info(`Job registered: ${name} (${jobId})`);

    return jobId;
  }

  /**
   * Enable or disable a registered job
   */
  setJobEnabled(jobId: string, enabled: boolean): boolean {
    if (!this.jobScheduler) {
      return false;
    }

    return this.jobScheduler.setJobEnabled(jobId, enabled);
  }

  /**
   * Manually trigger a job execution
   */
  async triggerJob(jobId: string, metadata?: Record<string, any>): Promise<any> {
    if (!this.jobScheduler) {
      throw new Error('Job scheduler is not enabled');
    }

    return this.jobScheduler.triggerJob(jobId, metadata);
  }

  /**
   * Unregister a job
   */
  unregisterJob(jobId: string): boolean {
    if (!this.jobScheduler) {
      throw new Error('Job scheduler is not enabled');
    }

    return this.jobScheduler.unregisterJob(jobId);
  }

  /**
   * Get job metrics
   */
  getJobMetrics(jobId: string): JobMetrics | null {
    if (!this.jobScheduler) {
      return null;
    }

    return this.jobScheduler.getJobMetrics(jobId);
  }

  /**
   * Get job health status
   */
  getJobHealth(jobId?: string): JobHealth | JobHealth[] {
    if (!this.jobHealthChecker) {
      if (jobId) {
        return {
          jobId,
          name: 'Unknown',
          status: 'unknown',
          enabled: false,
          consecutiveFailures: 0,
          message: 'Job scheduler not enabled',
        };
      }
      return [];
    }

    if (jobId) {
      return this.jobHealthChecker.checkJobHealth(jobId);
    }

    return this.jobHealthChecker.checkAllJobs();
  }

  /**
   * Get scheduler statistics
   */
  getJobStats(): SchedulerStats | null {
    if (!this.jobScheduler) {
      return null;
    }

    return this.jobScheduler.getStats();
  }

  /**
   * Get overall scheduler health
   */
  getSchedulerHealth() {
    if (!this.jobHealthChecker) {
      return {
        status: 'unknown' as const,
        message: 'Job scheduler not enabled',
        stats: null,
        jobs: [],
        unhealthyJobCount: 0,
      };
    }

    return this.jobHealthChecker.getSchedulerHealth();
  }

  /**
   * Start the job scheduler (called automatically on listen)
   */
  private async startJobScheduler(): Promise<void> {
    if (!this.jobScheduler || this.jobsStarted) {
      return;
    }

    try {
      await this.jobScheduler.start();
      this.jobsStarted = true;
      this.logger.info('Job scheduler started');
    } catch (err) {
      this.logger.error(`Failed to start job scheduler: ${String(err)}`);
    }
  }

  // ========================================
  // GraphQL API
  // ========================================

  /**
   * Configure GraphQL endpoint (synchronous, lazy initialization)
   *
   * @param options - GraphQL configuration options
   *
   * @example
   * ```ts
   * // Using type definitions and resolvers
   * app.graphqlInit({
   *   typeDefs: `
   *     type Query {
   *       hello: String
   *       users: [User]
   *     }
   *     type User {
   *       id: ID!
   *       name: String!
   *     }
   *   `,
   *   resolvers: {
   *     Query: {
   *       hello: () => 'Hello World!',
   *       users: () => [{ id: '1', name: 'Alice' }]
   *     }
   *   }
   * });
   *
   * // Using Pothos schema builder
   * import SchemaBuilder from '@pothos/core';
   *
   * const builder = new SchemaBuilder();
   * builder.queryType({
   *   fields: (t) => ({
   *     hello: t.string({ resolve: () => 'Hello World!' })
   *   })
   * });
   *
   * app.graphqlInit({
   *   pothosSchema: builder
   * });
   * ```
   */
  graphqlInit(options: GraphQLOptions): this {
    if (this.graphqlCore || this.graphqlInitPromise) {
      throw new Error('GraphQL has already been configured. Call graphqlInit() only once.');
    }

    // Check if graphql package is available
    if (!this.isGraphQLAvailable()) {
      throw new Error(
        'GraphQL support requires the graphql package to be installed.\n' +
          'Install it with: npm install graphql\n' +
          'For TypeScript-first GraphQL, also consider: npm install @pothos/core\n' +
          'For performance boost: npm install graphql-jit'
      );
    }

    this.logger.info('Configuring GraphQL (will initialize on server start)', 'GraphQL', {
      path: options.path || '/graphql',
      jit: options.enableJIT !== false,
      playground: options.enablePlayground !== false,
    });

    // Store config and trigger initialization immediately
    this.graphqlConfig = options;
    this.graphqlInitPromise = this.initializeGraphQL(options);
    // A failure is logged where it happens and still reaches whoever awaits
    // the promise (listen(), getGraphQLSchema(), a GraphQL request). It must
    // not also end the process as an unhandled rejection.
    this.graphqlInitPromise.catch(() => {});
    this.serveGraphQL(options);
    void this.eventBus.emit('graphql:configured', { options });

    return this;
  }

  /**
   * Answer HTTP requests for the GraphQL endpoint configured with
   * graphqlInit(). Registered in the same tick as graphqlInit(); a request
   * that arrives while the schema is still being built waits for it.
   */
  private serveGraphQL(options: GraphQLOptions): void {
    const graphqlPath = options.path || '/graphql';
    const playgroundPath = options.playgroundPath || `${graphqlPath}/playground`;
    const enablePlayground =
      options.enablePlayground !== false && process.env.NODE_ENV !== 'production';

    (this.middlewareManager as any).hooks.before('request', async (context: any) => {
      const req = context.request;
      const res = context.response;
      // Answered by a hook that ran before this one: nothing left to do
      if (res.headersSent) return;

      const wantsPlayground =
        enablePlayground && req.path === playgroundPath && req.method === 'GET';
      if (!wantsPlayground && req.path !== graphqlPath) {
        return; // Not a GraphQL request
      }

      let ready = true;
      try {
        await this.graphqlInitPromise;
      } catch {
        // Logged by initializeGraphQL(); the reason is not sent to clients.
        ready = false;
      }
      const core = this.graphqlCore;
      if (!ready || !core) {
        res.status(500).json({ errors: [{ message: 'GraphQL is not available' }] });
        return;
      }

      if (wantsPlayground) {
        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(core.getPlaygroundHTML());
        return;
      }

      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }

      if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({
          errors: [{ message: 'GraphQL only supports GET and POST requests' }],
        });
        return;
      }

      await core.handleRequest(req, res);
    });
  }

  /**
   * Lazy initialize GraphQL system
   */
  private async ensureGraphQLInitialized(): Promise<void> {
    if (this.graphqlCore || this.graphqlInitPromise) {
      await this.graphqlInitPromise;
      return;
    }

    if (!this.graphqlConfig) {
      return; // GraphQL not configured, skip
    }

    this.graphqlInitPromise = this.initializeGraphQL(this.graphqlConfig);
    await this.graphqlInitPromise;
  }

  /**
   * Initialize GraphQL system asynchronously
   */
  private async initializeGraphQL(options: GraphQLOptions): Promise<void> {
    try {
      // Lazy load GraphQL modules
      await this.loadGraphQLModules();

      // Create GraphQL core
      this.graphqlCore = new GraphQLCore(options);

      // Initialize GraphQL
      await this.graphqlCore.initialize();

      this.logger.info('GraphQL initialized successfully', 'GraphQL');

      // Setup subscriptions if enabled
      if (options.enableSubscriptions !== false && this.config.websocket.enabled) {
        this.setupGraphQLSubscriptions(options);
      }
    } catch (error) {
      this.logger.error('Failed to initialize GraphQL', 'GraphQL', { error });
      throw error;
    }
  }

  /**
   * Check if GraphQL package is available: resolved from the application's
   * directory, which is where the GraphQL adapter loads it from. (`require`
   * does not exist in an ES module, which is what the published build is.)
   */
  private isGraphQLAvailable(): boolean {
    return isPackageAvailable('graphql');
  }

  /**
   * Lazy load GraphQL modules
   */
  private async loadGraphQLModules(): Promise<void> {
    if (GraphQLCore) {
      return; // Already loaded
    }

    try {
      // GraphQL core now uses adapters with no static imports from 'graphql'
      const coreModule = await import('./core/graphql/core.js');
      GraphQLCore = coreModule.GraphQLCore;

      const subsModule = await import('./core/middleware/built-in/graphql/subscriptions.js');
      GraphQLSubscriptionManager = subsModule.GraphQLSubscriptionManager;
      setupGraphQLSubscriptions = subsModule.setupGraphQLSubscriptions;
    } catch (error) {
      this.logger.error('Failed to load GraphQL modules', 'GraphQL', { error });
      throw new Error('Failed to load GraphQL modules. Please ensure graphql is installed.');
    }
  }

  /**
   * Setup GraphQL subscriptions
   */
  private setupGraphQLSubscriptions(options: GraphQLOptions): void {
    const websocketAdapter = this.coreFramework.getWebSocketAdapter();

    if (!websocketAdapter) {
      this.logger.warn('GraphQL subscriptions require WebSocket to be enabled', 'GraphQL');
      return;
    }

    if (!this.graphqlCore) {
      return;
    }

    const schema = this.graphqlCore.getSchema();

    this.graphqlSubscriptionManager = setupGraphQLSubscriptions(websocketAdapter, schema, {
      path: options.path ? `${options.path}/subscriptions` : '/graphql/subscriptions',
      contextFactory: options.context,
    });

    this.logger.info('GraphQL subscriptions enabled', 'GraphQL', {
      path: options.path ? `${options.path}/subscriptions` : '/graphql/subscriptions',
    });
  }

  /**
   * Get GraphQL schema (if configured)
   */
  async getGraphQLSchema(): Promise<any | undefined> {
    await this.ensureGraphQLInitialized();
    return this.graphqlCore?.getSchema();
  }

  // ========================================
  // Worker Threads API
  // ========================================

  /**
   * Execute a task on worker threads (CPU-intensive operations)
   * @param task - Task to execute
   * @returns Promise resolving to task result
   *
   * @example
   * ```ts
   * // JWT verification (CPU-intensive)
   * const payload = await app.executeOnWorker({
   *   id: 'jwt-verify-123',
   *   type: 'jwt:verify',
   *   data: { token, secret }
   * });
   *
   * // Heavy computation
   * const result = await app.executeOnWorker({
   *   id: 'compute-456',
   *   type: 'computation:heavy',
   *   data: { iterations: 1000000 }
   * });
   * ```
   */
  async executeOnWorker<T = any>(task: WorkerTask): Promise<T> {
    return this.workerFacade.executeTask<T>(task);
  }

  /**
   * Get worker manager instance for advanced usage
   */
  async getWorkerManager() {
    await this.workerFacade.ensureInitialized?.(); // Trigger initialization if needed
    return this.workerFacade;
  }

  /**
   * Get worker thread statistics
   */
  async getWorkerStats() {
    return this.workerFacade.getStats();
  }

  /**
   * JWT operations using worker threads (prevents event loop blocking)
   */
  async getJwtWorker() {
    return this.workerFacade.getJwtWorker();
  }

  /**
   * Crypto operations using worker threads
   */
  async getCryptoWorker() {
    return this.workerFacade.getCryptoWorker();
  }

  /**
   * Heavy computation operations using worker threads
   */
  async getComputeWorker() {
    return this.workerFacade.getComputeWorker();
  }

  /**
   * Get GraphQL stats
   */
  async getGraphQLStats() {
    await this.ensureGraphQLInitialized();

    if (!this.graphqlCore) {
      return null;
    }

    return {
      ...this.graphqlCore.getStats(),
      subscriptions: this.graphqlSubscriptionManager?.getSubscriptionCount() || 0,
    };
  }

  // =====================
  // gRPC Methods
  // =====================

  /**
   * Configure gRPC server (synchronous, lazy initialization)
   *
   * @example
   * ```typescript
   * app.grpcInit({
   *   port: 50051,
   *   host: '0.0.0.0',
   *   adapter: 'grpc-js',
   *   enableHealthCheck: true
   * });
   * ```
   */
  grpcInit(options: GrpcOptions = {}): this {
    if (this.grpcInitPromise) {
      this.logger.warn('gRPC already configured', 'GRPC');
      return this;
    }

    this.logger.info('Configuring gRPC (will initialize on server start)', 'GRPC');

    // Store config for lazy initialization
    this.grpcConfig = {
      port: 50051,
      host: '0.0.0.0',
      adapter: 'grpc-js',
      enableHealthCheck: true,
      enableReflection: false,
      ...options,
    };

    return this;
  }

  /**
   * Lazy initialize gRPC system
   */
  private async ensureGrpcInitialized(): Promise<void> {
    if (this.grpcManager || this.grpcInitPromise) {
      await this.grpcInitPromise;
      return;
    }

    if (!this.grpcConfig) {
      return; // gRPC not configured, skip
    }

    this.grpcInitPromise = (async () => {
      try {
        this.logger.info('Initializing gRPC system', 'GRPC');

        // Lazy load gRPC manager
        const { GrpcManager } = await import('./core/grpc/grpc-manager.js');

        // Create gRPC manager
        this.grpcManager = new GrpcManager(this.grpcConfig);

        // Initialize gRPC
        await this.grpcManager.initialize();

        this.logger.info('gRPC system initialized', 'GRPC');
      } catch (error) {
        logErrorLines(this.logger, 'Failed to initialize gRPC', error, 'GRPC');
        throw error;
      }
    })();

    await this.grpcInitPromise;
  }

  /**
   * Register a gRPC service from a proto file
   *
   * @example
   * ```typescript
   * app.grpcService('./proto/users.proto', 'UserService', {
   *   getUser: async (call, callback) => {
   *     const user = await db.users.findById(call.request.id);
   *     callback(null, user);
   *   },
   *   listUsers: async (call) => {
   *     for (const user of users) {
   *       call.write(user);
   *     }
   *     call.end();
   *   }
   * });
   * ```
   */
  async grpcService(
    protoPath: string,
    serviceName: string,
    implementation: ServiceImplementation,
    packageName?: string
  ): Promise<void> {
    if (!this.grpcConfig && !this.grpcManager) {
      throw new Error(
        'gRPC not initialized. Call app.grpcInit() first.\n' +
          'Example: app.grpcInit({ port: 50051 });'
      );
    }

    // Lazy initialize gRPC if not already done
    await this.ensureGrpcInitialized();

    if (!this.grpcManager) {
      throw new Error(
        'gRPC not initialized. Call app.grpcInit() first.\n' +
          'Example: app.grpcInit({ port: 50051 });'
      );
    }

    try {
      await this.grpcManager.registerService(protoPath, serviceName, implementation, packageName);

      this.logger.info(`gRPC service registered: ${serviceName}`, 'GRPC');
    } catch (error) {
      this.logger.error(`Failed to register gRPC service ${serviceName}: ${error}`, 'GRPC');
      throw error;
    }
  }

  /**
   * Start gRPC server
   * Called automatically by listen() if gRPC is configured
   */
  async startGrpc(): Promise<void> {
    // Lazy initialize if needed
    await this.ensureGrpcInitialized();

    if (!this.grpcManager) {
      return;
    }

    if (this.grpcStarted) {
      this.logger.warn('gRPC server already started', 'GRPC');
      return;
    }

    try {
      await this.grpcManager.start();
      this.grpcStarted = true;

      const stats = this.grpcManager.getStats();
      if (stats) {
        this.logger.info('gRPC server started successfully', 'GRPC');
      }
    } catch (error) {
      logErrorLines(this.logger, 'Failed to start gRPC server', error, 'GRPC');
      throw error;
    }
  }

  /**
   * Stop gRPC server gracefully
   */
  async stopGrpc(): Promise<void> {
    if (!this.grpcManager || !this.grpcStarted) {
      return;
    }

    try {
      await this.grpcManager.stop();
      this.grpcStarted = false;
      this.logger.info('gRPC server stopped', 'GRPC');
    } catch (error) {
      this.logger.error(`Error stopping gRPC server: ${error}`, 'GRPC');
      throw error;
    }
  }

  /**
   * Create a gRPC client for calling remote services
   *
   * @example
   * ```typescript
   * const client = await app.createGrpcClient(
   *   './proto/users.proto',
   *   'UserService',
   *   'localhost:50051'
   * );
   *
   * const user = await client.getUser({ id: '123' });
   * ```
   */
  async createGrpcClient(
    protoPath: string,
    serviceName: string,
    address: string,
    options?: Partial<GrpcClientOptions>
  ): Promise<GrpcClient> {
    if (!this.grpcConfig && !this.grpcManager) {
      throw new Error(
        'gRPC not initialized. Call app.grpcInit() first.\n' +
          'Example: app.grpcInit({ port: 50051 });'
      );
    }

    // Lazy initialize gRPC if not already done
    await this.ensureGrpcInitialized();

    if (!this.grpcManager) {
      throw new Error(
        'gRPC not initialized. Call app.grpcInit() first.\n' +
          'Example: app.grpcInit({ port: 50051 });'
      );
    }

    try {
      const client = await this.grpcManager.createClient(protoPath, serviceName, address, options);

      this.logger.info(`gRPC client created for ${serviceName} at ${address}`, 'GRPC');

      return client;
    } catch (error) {
      this.logger.error(`Failed to create gRPC client: ${error}`, 'GRPC');
      throw error;
    }
  }

  /**
   * Get gRPC statistics
   */
  getGrpcStats() {
    if (!this.grpcManager) {
      return null;
    }

    return this.grpcManager.getStats();
  }

  /**
   * Get list of registered gRPC services
   */
  getGrpcServices() {
    if (!this.grpcManager) {
      return [];
    }

    return this.grpcManager.getServices();
  }

  /**
   * Initialize queue system (synchronous for first queue, subsequent queues added immediately)
   *
   * @example
   * ```typescript
   * app.queueInit('emails', {
   *   adapter: 'bull',
   *   connection: {
   *     host: 'localhost',
   *     port: 6379
   *   },
   *   concurrency: 5
   * });
   * ```
   */
  queueInit(name: string, options: any): this {
    // Initialize queue manager on first call
    if (!this.queueInitialized && !this.queueInitPromise) {
      // A new queue system: nothing recorded for an earlier one applies to it
      this.queueRegistrations = new Map();
      this.queueRegistrationErrors = new Map();
      this.queueProcessorNames = new Set();
      this.queueInitPromise = (async () => {
        try {
          this.logger.info('Initializing queue system', 'QUEUE');
          const { QueueManager } = await import('./core/queue/index.js');
          this.queueManager = new QueueManager(this.eventBus as any);
          this.queueInitialized = true;
          this.logger.info('Queue system initialized', 'QUEUE');
        } catch (error) {
          this.logger.error(`Failed to initialize queue system: ${error}`, 'QUEUE');
          throw error;
        }
      })();
    }

    // Store config to register after initialization
    this.queueConfigs.set(name, options);
    this.queueRegistrationErrors.delete(name);
    this.logger.debug(`Queue "${name}" configured`, 'QUEUE');

    // Register the queue once the manager is ready. The promise is kept so
    // that the first use of the queue can wait for it: adapters that connect
    // to a broker (bull, RabbitMQ, Kafka, SQS) finish registering later than
    // the manager itself is created.
    const managerReady = this.queueInitPromise ?? Promise.resolve();
    const registration: Promise<void> = managerReady
      .then(async () => {
        if (this.queueManager) {
          await this.queueManager.registerQueue(name, options);
          this.logger.info(`Queue "${name}" registered with ${options.adapter} adapter`, 'QUEUE');
        }
      })
      .catch(error => {
        this.logger.error(`Failed to register queue "${name}": ${error}`, 'QUEUE');
        // A queue that could not be registered does not exist: forget its
        // name and keep the reason for whoever uses it next. (A second
        // queueInit() for a name that is already registered fails too; that
        // queue is working and stays.)
        if (
          this.queueRegistrations.get(name) === registration &&
          !this.queueManager?.hasQueue(name)
        ) {
          this.queueConfigs.delete(name);
          this.queueRegistrationErrors.set(name, error);
        }
      })
      .finally(() => {
        if (this.queueRegistrations.get(name) === registration) {
          this.queueRegistrations.delete(name);
        }
      });
    this.queueRegistrations.set(name, registration);

    return this;
  }

  /**
   * Ensure the queue system is initialized and, when a queue is named, that
   * its registration has finished. A registration that failed is reported
   * here with its original error.
   */
  private async ensureQueueInitialized(queueName?: string): Promise<void> {
    if (this.queueInitPromise) {
      await this.queueInitPromise;
    }
    if (queueName === undefined) return;

    const registration = this.queueRegistrations.get(queueName);
    if (registration) {
      await registration;
    }
    const failure = this.queueRegistrationErrors.get(queueName);
    if (failure !== undefined) {
      throw failure;
    }
  }

  /**
   * @deprecated Use queueInit() instead
   */
  async queue(name: string, options: any): Promise<void> {
    if (!this.queueInitialized) {
      try {
        this.logger.info('Initializing queue system', 'QUEUE');
        const { QueueManager } = await import('./core/queue/index.js');
        this.queueManager = new QueueManager(this.eventBus as any);
        this.queueInitialized = true;
        this.logger.info('Queue system initialized', 'QUEUE');
      } catch (error) {
        this.logger.error(`Failed to initialize queue system: ${error}`, 'QUEUE');
        throw error;
      }
    }

    try {
      await this.queueManager.registerQueue(name, options);
      this.logger.info(`Queue "${name}" registered with ${options.adapter} adapter`, 'QUEUE');
    } catch (error) {
      this.logger.error(`Failed to register queue "${name}": ${error}`, 'QUEUE');
      throw error;
    }
  }

  /**
   * Add a job to a queue
   *
   * @example
   * ```typescript
   * await app.addToQueue('emails', {
   *   to: 'user@example.com',
   *   subject: 'Welcome'
   * }, {
   *   priority: 10,
   *   delay: 5000
   * });
   * ```
   */
  async addToQueue<T = any>(queueName: string, data: T, options?: any): Promise<any> {
    // Ensure queue system is initialized and this queue is registered
    await this.ensureQueueInitialized(queueName);

    if (!this.queueManager) {
      throw new Error(
        `Queue "${queueName}" not initialized. Call app.queueInit('${queueName}', options) first.`
      );
    }

    return await this.queueManager.addToQueue(queueName, data, options);
  }

  /**
   * Add multiple jobs to a queue in bulk
   *
   * @example
   * ```typescript
   * await app.addBulkToQueue('emails', [
   *   { data: { to: 'user1@example.com' }, options: { priority: 1 } },
   *   { data: { to: 'user2@example.com' }, options: { priority: 2 } }
   * ]);
   * ```
   */
  async addBulkToQueue<T = any>(
    queueName: string,
    jobs: Array<{ data: T; options?: any }>
  ): Promise<any[]> {
    // Ensure queue system is initialized and this queue is registered
    await this.ensureQueueInitialized(queueName);

    if (!this.queueManager) {
      throw new Error(
        `Queue "${queueName}" not initialized. Call app.queue('${queueName}', options) first.`
      );
    }

    return await this.queueManager.addBulkToQueue(queueName, jobs);
  }

  /**
   * Register a processor for a queue
   *
   * @example
   * ```typescript
   * // Simple processor
   * app.processQueue('emails', async (job) => {
   *   await sendEmail(job.data);
   * });
   *
   * // With concurrency
   * app.processQueue('images', 3, async (job) => {
   *   await processImage(job.data);
   * });
   * ```
   */
  async processQueue<R = any>(
    queueName: string,
    concurrencyOrHandler: number | ((job: any) => Promise<R>),
    handler?: (job: any) => Promise<R>
  ): Promise<void> {
    // Recorded before anything is awaited, so that mail set up at the same
    // moment sees that this queue has the application's own processor.
    const alreadyAttached = this.queueProcessorNames.has(queueName);
    this.queueProcessorNames.add(queueName);

    try {
      // Ensure queue system is initialized and this queue is registered
      await this.ensureQueueInitialized(queueName);

      if (!this.queueManager) {
        throw new Error(
          `Queue "${queueName}" not initialized. Call app.queueInit('${queueName}', options) first.`
        );
      }

      await this.queueManager.processQueue(queueName, concurrencyOrHandler, handler);
    } catch (error) {
      if (!alreadyAttached) {
        this.queueProcessorNames.delete(queueName);
      }
      throw error;
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(queueName: string): Promise<any> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.getQueueStatus(queueName);
  }

  /**
   * Get a specific job from a queue
   */
  async getJob(queueName: string, jobId: string): Promise<any> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.getJob(queueName, jobId);
  }

  /**
   * Get jobs from a queue by status
   */
  async getJobs(
    queueName: string,
    status?: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused',
    start: number = 0,
    end: number = -1
  ): Promise<any[]> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.getJobs(queueName, status, start, end);
  }

  /**
   * Remove a job from a queue
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.removeJob(queueName, jobId);
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.retryJob(queueName, jobId);
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.pauseQueue(queueName);
  }

  /**
   * Resume a paused queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.resumeQueue(queueName);
  }

  /**
   * Clean old jobs from a queue
   */
  async cleanQueue(
    queueName: string,
    gracePeriod: number,
    status?: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused'
  ): Promise<void> {
    if (!this.queueManager) {
      throw new Error(`Queue system not initialized.`);
    }

    return await this.queueManager.cleanQueue(queueName, gracePeriod, status);
  }

  /**
   * Get all registered queue names
   */
  getQueueNames(): string[] {
    // Return configured queues (includes both initialized and pending)
    const configuredQueues = Array.from(this.queueConfigs.keys());

    if (!this.queueManager) {
      return configuredQueues;
    }

    // Merge with manager's queues (in case some were added directly)
    const managerQueues = this.queueManager.getQueueNames();
    const allQueues = new Set([...configuredQueues, ...managerQueues]);
    return Array.from(allQueues);
  }

  /**
   * Check if a queue is registered
   */
  hasQueue(queueName: string): boolean {
    // Check if it's configured (includes both initialized and pending)
    if (this.queueConfigs.has(queueName)) {
      return true;
    }

    if (!this.queueManager) {
      return false;
    }

    return this.queueManager.hasQueue(queueName);
  }

  // =====================
  // Mail System Methods
  // =====================

  /**
   * Configure mail system (synchronous, lazy initialization)
   *
   * @example
   * ```typescript
   * // Using Nodemailer (SMTP) - chainable, no await needed!
   * app.mailInit({
   *   adapter: 'nodemailer',
   *   from: { name: 'My App', email: 'noreply@myapp.com' },
   *   connection: {
   *     host: 'smtp.gmail.com',
   *     port: 587,
   *     secure: false,
   *     auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
   *   },
   *   templates: { path: './emails', engine: 'moro', cache: true }
   * });
   *
   * // Using SendGrid
   * app.mailInit({
   *   adapter: 'sendgrid',
   *   from: 'noreply@myapp.com',
   *   connection: { apiKey: process.env.SENDGRID_API_KEY }
   * });
   * ```
   */
  mailInit(config: MailConfig): this {
    if (this.mailInitialized) {
      this.logger.warn('Mail system already configured', 'Mail');
      return this;
    }

    // Store config for lazy initialization
    this.mailConfig = config;
    this.logger.debug('Mail system configured (will initialize on first use)', 'Mail');
    void this.eventBus.emit('mail:configured', { config });

    return this;
  }

  /**
   * Lazy initialize mail system on first use. Concurrent first uses share one
   * initialisation; a failed one is retried by the next use.
   */
  private async ensureMailInitialized(): Promise<void> {
    if (this.mailInitialized) {
      return;
    }

    if (!this.mailConfig) {
      throw new Error(
        'Mail system not configured. Call app.mailInit(config) first.\n' +
          "Example: app.mailInit({ adapter: 'console', from: 'noreply@myapp.com' });"
      );
    }

    if (!this.mailInitPromise) {
      const attempt: Promise<void> = this.initializeMail().finally(() => {
        if (this.mailInitPromise === attempt) {
          this.mailInitPromise = undefined;
        }
      });
      this.mailInitPromise = attempt;
    }

    return this.mailInitPromise;
  }

  private async initializeMail(): Promise<void> {
    try {
      this.logger.info('Initializing mail system', 'Mail');

      const { MailManager } = await import('./core/mail/index.js');
      this.mailManager = new MailManager(this.mailConfig);

      await this.mailManager.initialize();

      if (this.mailConfig.queue?.enabled) {
        await this.connectMailQueue(this.mailConfig.queue.name || 'emails');
      }

      this.mailInitialized = true;
      this.logger.info('Mail system initialized successfully', 'Mail');
    } catch (error) {
      this.logger.error(`Failed to initialize mail system: ${error}`, 'Mail');
      throw error;
    }
  }

  /**
   * Route mail through the named queue (`mailInit({ queue: { enabled: true } })`).
   *
   * - The application registered the queue: it is used as registered, with
   *   its adapter and concurrency, and the delivering processor is attached
   *   unless the application attached its own with processQueue().
   * - The application uses queues but not this one: an in-memory queue is
   *   registered for mail.
   * - The application has no queue system at all: mail is sent directly, as
   *   it always has been in that case, and a warning says so.
   */
  private async connectMailQueue(queueName: string): Promise<void> {
    const queuesInUse =
      this.queueInitPromise !== undefined ||
      this.queueManager !== undefined ||
      this.hasQueue(queueName);
    if (!queuesInUse) {
      this.logger.warn(
        `Mail queue "${queueName}" is enabled but this app has no queue system, so mail is sent ` +
          `directly, not queued. Call app.queueInit('${queueName}', { adapter: 'memory' }) (or ` +
          'another adapter) before the first send to queue it.',
        'Mail'
      );
      return;
    }

    // Waits for a registration the application started; rethrows its error
    // if it failed, instead of quietly queueing in memory.
    await this.ensureQueueInitialized(queueName);

    if (!this.hasQueue(queueName)) {
      this.queueInit(queueName, {
        adapter: 'memory',
        concurrency: Moro.MAIL_QUEUE_CONCURRENCY,
      });
      await this.ensureQueueInitialized(queueName);
    }

    this.mailManager.setQueueManager(this.queueManager);

    if (!this.queueProcessorNames.has(queueName)) {
      // Straight to the manager: this is the framework's processor, not one
      // the application attached. With no concurrency argument the queue's
      // own `concurrency` option applies.
      await this.queueManager.processQueue(queueName, async (job: any) => {
        if (!this.mailManager) {
          throw new Error('Mail manager not initialized');
        }
        // deliver() bypasses the queue check; send() would re-enqueue the
        // job forever and never actually transmit the email.
        const result = await this.mailManager.deliver(job.data);
        if (result && result.success === false) {
          // A failed delivery fails the job, so the queue retries it.
          throw new Error(result.error || 'Mail delivery failed');
        }
        return result;
      });
    }

    this.logger.info(`Mail queue "${queueName}" configured`, 'Mail');
  }

  /**
   * Send an email
   *
   * @example
   * ```typescript
   * // Simple email
   * await app.sendMail({
   *   to: 'user@example.com',
   *   subject: 'Welcome',
   *   text: 'Welcome to our app!'
   * });
   *
   * // With template
   * await app.sendMail({
   *   to: 'user@example.com',
   *   subject: 'Password Reset',
   *   template: 'password-reset',
   *   data: { name: 'John', resetUrl: 'https://myapp.com/reset/token123' }
   * });
   *
   * // With attachments
   * await app.sendMail({
   *   to: 'user@example.com',
   *   subject: 'Invoice',
   *   template: 'invoice',
   *   data: { invoice },
   *   attachments: [{ filename: 'invoice.pdf', content: pdfBuffer }]
   * });
   * ```
   */
  async sendMail(options: MailOptions): Promise<MailResult> {
    // Lazy initialize on first use
    await this.ensureMailInitialized();

    void this.eventBus.emit('mail:sending', { options });

    try {
      const result = await this.mailManager.send(options);

      if (result.success) {
        void this.eventBus.emit('mail:sent', { result, options });
      } else {
        void this.eventBus.emit('mail:failed', { error: new Error(result.error), options });
      }

      return result;
    } catch (error) {
      void this.eventBus.emit('mail:failed', { error, options });
      throw error;
    }
  }

  /**
   * Send multiple emails in bulk
   *
   * @example
   * ```typescript
   * await app.sendBulkMail([
   *   { to: 'user1@example.com', subject: 'Hello', text: 'Hi!' },
   *   { to: 'user2@example.com', subject: 'Hello', text: 'Hi!' }
   * ]);
   * ```
   */
  async sendBulkMail(options: MailOptions[]): Promise<MailResult[]> {
    // Lazy initialize on first use
    await this.ensureMailInitialized();

    return await this.mailManager.sendBulk(options);
  }

  /**
   * Verify mail adapter connection
   */
  async verifyMail(): Promise<boolean> {
    // Lazy initialize on first use
    try {
      await this.ensureMailInitialized();
      return await this.mailManager.verify();
    } catch {
      return false;
    }
  }

  /**
   * Get mail template engine for advanced usage
   */
  getMailTemplateEngine(): any {
    if (!this.mailManager) {
      return undefined;
    }

    return this.mailManager.getTemplateEngine();
  }

  /**
   * Check if mail system is configured
   */
  hasMailSystem(): boolean {
    return !!this.mailConfig || this.mailInitialized;
  }
}

let currentApp: Moro | null = null;
// The apps the factories below created: the ones getApp() may return
const factoryApps = new WeakSet<Moro>();

function registerFactoryApp(app: Moro): Moro {
  factoryApps.add(app);
  currentApp = app;
  return app;
}

/**
 * Get the current Moro application instance.
 *
 * Returns the app created by the most recent createApp() call (or
 * createAppNode(), createAppEdge(), createAppLambda(), createAppWorker()).
 * Use this in standalone route files so they can register routes
 * without needing the app to be passed in.
 *
 * With several apps in one process: inside a route file that an app is
 * loading (`app.loadRoutes()`, file-based routing) it is that app; otherwise
 * the most recently created app that has not been closed, and once every app
 * has been closed, the most recently created one.
 *
 * @example
 * // routes/health.routes.ts
 * import { getApp } from '@morojs/moro';
 * const app = getApp();
 *
 * app.get('/health', (req, res) => {
 *   res.json({ status: 'healthy' });
 * });
 */
export function getApp(): Moro {
  if (!currentApp) {
    throw new Error('No app instance available. Call createApp() before getApp().');
  }
  // The app whose router is the current one: the app loading its route files,
  // or an older one that is still open when the newest has been closed.
  const routed = UnifiedRouter.currentOwner();
  if (routed !== currentApp && routed instanceof Moro && factoryApps.has(routed)) return routed;
  return currentApp;
}

/**
 * Create and fully initialise a Moro application.
 *
 * Must be awaited — the async step loads moro.config.js/ts via dynamic
 * import() so ESM config files (projects with "type":"module") work correctly,
 * exactly the same way all other modules are loaded.
 *
 * @example
 * const app = await createApp({ server: { port: 3000 } });
 * app.listen();
 */
/**
 * Apply LOG_LEVEL / MORO_LOG_LEVEL env var and options.logger to the global logger
 * before config loading runs, so config-system debug logs respect the user's level.
 */
function applyEarlyLogLevel(options?: MoroOptions): void {
  const envLevel = process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL;
  if (envLevel) {
    applyLoggingConfiguration({ level: envLevel }, undefined);
  }
  if (options?.logger !== undefined) {
    applyLoggingConfiguration(undefined, options.logger);
  }
}

export async function createApp(options?: MoroOptions): Promise<Moro> {
  applyEarlyLogLevel(options);
  const config = await createAppConfigAsync(options);
  return registerFactoryApp(new Moro(options, config));
}

/**
 * Create a Node.js-targeted Moro application. Must be awaited.
 * @example const app = await createAppNode();
 */
export async function createAppNode(options?: Omit<MoroOptions, 'runtime'>): Promise<Moro> {
  const mergedOptions = { ...options, runtime: { type: 'node' as const } };
  applyEarlyLogLevel(mergedOptions);
  const config = await createAppConfigAsync(mergedOptions);
  return registerFactoryApp(new Moro(mergedOptions, config));
}

/**
 * Create a Vercel Edge-targeted Moro application. Must be awaited.
 * @example const app = await createAppEdge();
 */
export async function createAppEdge(options?: Omit<MoroOptions, 'runtime'>): Promise<Moro> {
  const mergedOptions = { ...options, runtime: { type: 'vercel-edge' as const } };
  applyEarlyLogLevel(mergedOptions);
  const config = await createAppConfigAsync(mergedOptions);
  return registerFactoryApp(new Moro(mergedOptions, config));
}

/**
 * Create an AWS Lambda-targeted Moro application. Must be awaited.
 * @example const app = await createAppLambda();
 */
export async function createAppLambda(options?: Omit<MoroOptions, 'runtime'>): Promise<Moro> {
  const mergedOptions = { ...options, runtime: { type: 'aws-lambda' as const } };
  applyEarlyLogLevel(mergedOptions);
  const config = await createAppConfigAsync(mergedOptions);
  return registerFactoryApp(new Moro(mergedOptions, config));
}

/**
 * Create a Cloudflare Workers-targeted Moro application. Must be awaited.
 * @example const app = await createAppWorker();
 */
export async function createAppWorker(options?: Omit<MoroOptions, 'runtime'>): Promise<Moro> {
  const mergedOptions = { ...options, runtime: { type: 'cloudflare-workers' as const } };
  applyEarlyLogLevel(mergedOptions);
  const config = await createAppConfigAsync(mergedOptions);
  return registerFactoryApp(new Moro(mergedOptions, config));
}
