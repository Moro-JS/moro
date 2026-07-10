import { Server } from 'http';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { MoroHttpServer, HttpRequest, HttpResponse } from './http/index.js';
import { UWebSocketsHttpServer } from './http/uws-http-server.js';
import { MoroEngineServer } from './http/moro-engine-server.js';
import { MoroHttp2Server, Http2ServerOptions } from './http/http2-server.js';
import { Router } from './routing/router.js';
import { Container, buildModuleBasePath } from './utilities/index.js';
import { ModuleLoader } from './modules/index.js';
import { WebSocketManager } from './networking/websocket-manager.js';
import { CircuitBreaker } from './utilities/circuit-breaker.js';
import {
  isPackageAvailable,
  loadNativeEngine,
  getNativeEngineLoadErrors,
  NativeEngineLoadResult,
} from './utilities/package-utils.js';
import { parseSizeToBytes, type HttpRuntimeLimits } from './http/utils/size.js';
import {
  normalizeSSLConfig,
  sslForNode,
  sslForUws,
  sslForEngine,
  sslIsComplete,
} from './http/utils/ssl-config.js';
import type { EngineCapabilities } from './utilities/package-utils.js';
import { MoroEventBus } from './events/index.js';
import { createFrameworkLogger, logger as globalLogger } from './logger/index.js';
import { ModuleConfig, InternalRouteDefinition } from '../types/module.js';
import { MoroOptions as CoreMoroOptions } from '../types/core.js';
import {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  mergeWebSocketConfig,
} from './networking/websocket-adapter.js';
import { cors, helmet, compression } from './middleware/built-in/index.js';

/**
 * Which HTTP server actually booted, and why, when the native engine was
 * bypassed. Exposed via getServerKind() / app.engine for logs, tests and
 * benchmarks that need to assert the transport in use.
 */
export interface ServerKind {
  server: 'engine' | 'node' | 'http2';
  /** Package backing the native engine ('@morojs/engine' or 'uWebSockets.js') */
  enginePackage?: string;
  engineVersion?: string;
  /** Present when the native engine was requested but the Node server booted */
  fallbackReason?: string;
  /** Protocols the booted server can speak (observability for app.engine). */
  protocols?: Array<'http/1.1' | 'h2'>;
}

// Flattened, size-resolved server limits built once and passed to whichever
// server boots (shared shape lives in http/utils/size.ts). Required fields
// here (maxBodySize/maxUploadSize/maxConnections/timeouts/multipart) are
// always populated by buildRuntimeLimits().
type RuntimeLimits = HttpRuntimeLimits &
  Required<
    Pick<
      HttpRuntimeLimits,
      'maxBodySize' | 'maxUploadSize' | 'maxConnections' | 'timeouts' | 'multipart'
    >
  >;

// Internal result of resolveEngineMode()
type EngineChoice =
  | {
      kind: 'engine';
      engine: NativeEngineLoadResult;
      requested: 'moro' | 'uws';
      /** Serve HTTP/2 natively via the engine's ALPN (engine caps.http2). */
      h2?: boolean;
    }
  | { kind: 'http2' }
  // explicitEngine: the user explicitly chose a native engine that could not
  // be honored (drives warn-level vs info-level fallback logging).
  | { kind: 'node'; fallbackReason?: string; explicitEngine?: boolean };

// Extended MoroOptions that includes both core options and framework-specific options
export interface MoroOptions extends CoreMoroOptions {
  http2?: boolean | Http2ServerOptions;
  https?: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: string | Buffer;
  };
  websocket?:
    | {
        enabled?: boolean;
        adapter?: WebSocketAdapter;
        compression?: boolean;
        customIdGenerator?: () => string;
        options?: WebSocketAdapterOptions;
      }
    | false;
  config?: any; // Full configuration object
}

export class Moro extends EventEmitter {
  private httpServer: MoroHttpServer | UWebSocketsHttpServer | MoroEngineServer | MoroHttp2Server;
  private server: Server | any; // HTTP/2 server type or uWebSockets app
  private websocketAdapter?: WebSocketAdapter;
  private container: Container;
  private moduleLoader: ModuleLoader;
  private websocketManager?: WebSocketManager;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private rateLimiters = new Map<string, Map<string, { count: number; resetTime: number }>>();
  // Enterprise-grade event system
  private eventBus: MoroEventBus;
  // Framework logger
  private logger: any;
  private options: MoroOptions;
  private config: any;
  private usingUWebSockets = false;
  // True when the Moro-shaped @morojs/engine backs this app (usingUWebSockets
  // stays reserved for the legacy uWS-API-shaped engine)
  private usingEngine = false;
  private usingHttp2 = false;
  // Which server actually booted (engine = native uWS-style engine)
  private engineInfo: ServerKind = { server: 'node' };
  // WebSocket initialization promise to handle async adapter detection
  private websocketSetupPromise: Promise<void> | null = null;

  constructor(options: MoroOptions = {}) {
    super();
    this.options = options;
    this.config = options.config || {};

    // Configure global logger based on options
    if (options.logger !== undefined) {
      if (options.logger === false) {
        // Disable logging by setting level to fatal (highest level)
        globalLogger.setLevel('fatal');
      } else if (typeof options.logger === 'object') {
        // Configure logger with provided options
        if (options.logger.level) {
          globalLogger.setLevel(options.logger.level);
        }
        // Additional logger options can be configured here in the future
        // For now, we focus on the level setting which is the most common need
      }
    }

    // Initialize framework logger after global configuration
    this.logger = createFrameworkLogger('Core');

    // Resolve which HTTP server backs this app: the native engine
    // (@morojs/engine, or a legacy user-installed uWebSockets.js), Node's
    // http server, or the http2 server. The engine module is loaded
    // SYNCHRONOUSLY here - UWebSocketsHttpServer finishes initialization
    // asynchronously, so a load failure (package missing, or no prebuilt
    // binary for this Node ABI) surfacing there would never hit the fallback
    // and the app would hang at listen() bound to nothing.
    const engineChoice = this.resolveEngineMode(options);

    // One normalized SSL config + one flattened limits object, built here and
    // projected per-runtime, so a single server.ssl / server.limits flows
    // everywhere regardless of which server boots.
    const ssl = normalizeSSLConfig(this.config.server?.ssl, options.https as any, this.logger);
    const rt = this.buildRuntimeLimits();

    if (engineChoice.kind === 'engine') {
      try {
        // The two native engines expose different APIs: @morojs/engine is
        // Moro-shaped (serve/respond, one JS crossing each way), the legacy
        // uWS peer is App()-shaped. Pick the adapter by capability.
        const engineSurface = engineChoice.engine.module?.default || engineChoice.engine.module;
        const caps = engineChoice.engine.capabilities;
        if (
          typeof engineSurface?.serve === 'function' &&
          typeof engineSurface?.respond === 'function'
        ) {
          this.httpServer = new MoroEngineServer({
            ssl,
            capabilities: caps,
            limits: rt,
            http2Settings: engineChoice.h2 ? this.resolveH2Settings(options) : undefined,
            maxBodySize: rt.maxBodySize,
            maxUploadSize: rt.maxUploadSize,
            engineModule: engineChoice.engine.module,
            // Cluster workers each bind the port; SO_REUSEPORT lets the kernel
            // balance accepts across them (Windows is gated to Node earlier).
            reusePort: this.config.performance?.clustering?.enabled === true,
          });
          this.server = (this.httpServer as MoroEngineServer).getServer();
          this.usingEngine = true;
        } else {
          this.httpServer = new UWebSocketsHttpServer({
            ssl: ssl ? sslForUws(ssl) : undefined,
            sslInlineOnly: ssl ? !sslForUws(ssl) : false,
            limits: rt,
            maxBodySize: rt.maxBodySize,
            maxUploadSize: rt.maxUploadSize,
            engineModule: engineChoice.engine.module,
          });
          this.server = (this.httpServer as UWebSocketsHttpServer).getApp();
          this.usingUWebSockets = true;
        }
        this.engineInfo = {
          server: 'engine',
          enginePackage: engineChoice.engine.source,
          engineVersion: engineChoice.engine.version,
          protocols: engineChoice.h2 && caps?.http2 ? ['h2', 'http/1.1'] : ['http/1.1'],
        };
        this.logger.info(
          `HTTP engine: ${engineChoice.engine.source}` +
            (engineChoice.engine.version ? ` v${engineChoice.engine.version}` : '') +
            ` (native, Node ABI ${process.versions.modules})`,
          'ServerInit'
        );
      } catch (error) {
        // Construction failed after a successful module load - unexpected, but
        // never boot nothing: fall back to the Node.js http server.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Native engine (${engineChoice.requested}) failed to initialize, falling back to Node.js http.Server. Error: ${reason}`,
          'ServerInit'
        );
        this.usingUWebSockets = false;
        this.usingEngine = false;
        this.engineInfo = { server: 'node', fallbackReason: reason };
        this.httpServer = new MoroHttpServer({
          ssl: ssl && sslIsComplete(ssl) ? sslForNode(ssl) : undefined,
          limits: rt,
          maxBodySize: rt.maxBodySize,
          maxUploadSize: rt.maxUploadSize,
        });
        this.server = (this.httpServer as MoroHttpServer).getServer();
      }
    } else if (engineChoice.kind === 'http2') {
      // Use HTTP/2 with proper adapter
      const http2Options: Http2ServerOptions = this.resolveH2Settings(options);

      // SSL now flows from the unified config (either shape) as well as the
      // legacy options.https, via the normalizer.
      if (ssl) {
        const nodeSsl = sslForNode(ssl);
        http2Options.key = nodeSsl.key;
        http2Options.cert = nodeSsl.cert;
        if (nodeSsl.ca) http2Options.ca = nodeSsl.ca as any;
      }

      this.httpServer = new MoroHttp2Server({
        ...http2Options,
        limits: rt,
        maxBodySize: rt.maxBodySize,
        maxUploadSize: rt.maxUploadSize,
      });
      this.server = (this.httpServer as MoroHttp2Server).getServer();
      this.usingHttp2 = true;
      this.engineInfo = { server: 'http2', protocols: ['h2', 'http/1.1'] };
      this.logger.info('HTTP/2 server created with native adapter', 'ServerInit');
    } else {
      // Use standard HTTP/1.1 (Node), now with optional in-process HTTPS.
      this.httpServer = new MoroHttpServer({
        ssl:
          ssl && require('./http/utils/ssl-config.js').sslIsComplete(ssl)
            ? sslForNode(ssl)
            : undefined,
        limits: rt,
        maxBodySize: rt.maxBodySize,
        maxUploadSize: rt.maxUploadSize,
      });
      this.server = (this.httpServer as MoroHttpServer).getServer();
      this.engineInfo = { server: 'node', fallbackReason: engineChoice.fallbackReason };
      if (engineChoice.fallbackReason) {
        // The default engine simply not being installed is expected (it is an
        // optional dependency) - only an EXPLICIT engine choice that cannot be
        // honored deserves warn-level noise on every boot.
        const message = `Native engine unavailable, using Node.js http.Server - ${engineChoice.fallbackReason}`;
        if (engineChoice.explicitEngine) {
          this.logger.warn(message, 'ServerInit');
        } else {
          this.logger.info(message, 'ServerInit');
        }
      }
    }

    this.container = new Container();
    this.moduleLoader = new ModuleLoader(this.container);

    // Setup WebSocket adapter if enabled in config OR options
    if (
      this.config.websocket.enabled ||
      (options.websocket && typeof options.websocket === 'object')
    ) {
      // Store the promise so we can await it before using websockets
      this.websocketSetupPromise = this.setupWebSockets(
        mergeWebSocketConfig(this.config.websocket, options.websocket)
      );
    }

    // Initialize enterprise event bus
    this.eventBus = new MoroEventBus({
      maxListeners: 200,
      enableMetrics: true,
      isolation: 'module',
    });

    // Register event bus in DI container as factory
    this.container.register('eventBus', () => this.eventBus);

    this.setupCore();
  }

  // Middleware support
  use(middleware: any): this {
    this.httpServer.use(middleware);
    return this;
  }

  private setupCore() {
    // PERFORMANCE FIX: Only apply middleware if enabled in config OR options

    // Security - check config enabled property OR options.security.*.enabled === true
    if (this.config.security.helmet.enabled || this.options.security?.helmet?.enabled === true) {
      this.httpServer.use(helmet());
    }

    if (this.config.security.cors.enabled || this.options.security?.cors?.enabled === true) {
      const corsOptions =
        typeof this.options.cors === 'object'
          ? this.options.cors
          : this.config.security.cors
            ? this.config.security.cors
            : {};
      this.httpServer.use(cors(corsOptions));
    }

    // Performance middleware - check config enabled property OR options.performance.*.enabled === true
    if (
      this.config.performance.compression.enabled ||
      this.options.performance?.compression?.enabled === true
    ) {
      const compressionOptions =
        typeof this.options.compression === 'object'
          ? this.options.compression
          : this.config.performance.compression
            ? this.config.performance.compression
            : {};
      this.httpServer.use(compression(compressionOptions));
    }

    // Body size limits are enforced inside the HTTP server's parseBody
    // (configured via maxBodySize/maxUploadSize above), which responds 413.
    // No per-request middleware needed - keeps the default chain empty.

    // Configure request tracking (ID generation) in HTTP server
    if (this.httpServer.setRequestTracking) {
      this.httpServer.setRequestTracking(this.config.server.requestTracking.enabled);
    }

    // Request logging middleware - separate from request tracking (ID generation)
    if (this.config.server.requestLogging.enabled) {
      this.httpServer.use(this.requestLoggingMiddleware());
    }

    // Error boundary: handled by the HTTP server's top-level catch in
    // handleRequest (which invokes the registered errorHandler / default 500).
    // The old errorBoundaryMiddleware wrapped a callback-style next() in
    // try/catch, which can never observe downstream errors - it cost a promise
    // per request and caught nothing, so it is no longer installed.
  }

  /**
   * Setup WebSocket adapter and manager
   */
  private async setupWebSockets(wsConfig: any): Promise<void> {
    try {
      // The Moro-shaped @morojs/engine has native RFC 6455 WebSocket support:
      // upgrades share the HTTP listen socket, driven by the engine's C++ WS
      // path via the EngineWebSocketAdapter.
      if (this.usingEngine) {
        const { EngineWebSocketAdapter } = await import('./networking/adapters/engine-adapter.js');
        this.websocketAdapter = new EngineWebSocketAdapter();
        await this.websocketAdapter.initialize(this.httpServer, wsConfig.options);
        this.websocketManager = new WebSocketManager(this.websocketAdapter, this.container);
        if (wsConfig.compression) this.websocketAdapter.setCompression(true);
        if (wsConfig.customIdGenerator)
          this.websocketAdapter.setCustomIdGenerator(wsConfig.customIdGenerator);
        this.logger.info(
          'Engine WebSocket adapter initialized (integrated with @morojs/engine)',
          'WebSocketSetup'
        );
        return;
      }

      // If using uWebSockets HTTP server, automatically use uWebSockets for WebSocket too
      if (this.usingUWebSockets) {
        const { UWebSocketsAdapter } = await import('./networking/adapters/index.js');
        this.websocketAdapter = new UWebSocketsAdapter();

        // For uWebSockets, we need to integrate with the existing app
        const uwsHttpServer = this.httpServer as UWebSocketsHttpServer;
        await this.websocketAdapter.initialize(uwsHttpServer.getApp(), wsConfig.options);

        this.logger.info(
          'uWebSockets adapter initialized (integrated with HTTP server)',
          'WebSocketSetup'
        );
      } else {
        // Use provided adapter or try to auto-detect
        if (wsConfig.adapter && typeof wsConfig.adapter === 'object') {
          this.websocketAdapter = wsConfig.adapter;
        } else {
          this.websocketAdapter = (await this.detectWebSocketAdapter()) || undefined;
        }

        if (this.websocketAdapter) {
          await this.websocketAdapter.initialize(this.server, wsConfig.options);

          this.logger.info(
            `WebSocket adapter initialized: ${this.websocketAdapter.getAdapterName()}`,
            'WebSocketSetup'
          );
        }
      }

      // Configure adapter features (if adapter was created)
      if (this.websocketAdapter) {
        this.websocketManager = new WebSocketManager(this.websocketAdapter, this.container);

        if (wsConfig.compression) {
          this.websocketAdapter.setCompression(true);
        }
        if (wsConfig.customIdGenerator) {
          this.websocketAdapter.setCustomIdGenerator(wsConfig.customIdGenerator);
        }
      }
    } catch (error) {
      this.logger.warn(
        'WebSocket setup failed, continuing without WebSocket support',
        'WebSocketSetup',
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Auto-detect available WebSocket adapter
   * Tests if the library is actually installed by checking require.resolve
   */
  private async detectWebSocketAdapter(): Promise<WebSocketAdapter | null> {
    // Check if adapter is specified in config
    if (this.config.websocket?.adapter) {
      const adapterType = this.config.websocket.adapter;

      if (adapterType === 'uws') {
        // The uws adapter only works integrated with the native engine's own
        // app (setupWebSockets handles that path before detection runs).
        // Standalone it would register routes on a second, never-listening
        // uWS app - fall through to the Node-compatible adapters instead.
        this.logger.warn(
          "websocket adapter 'uws' requires a native engine HTTP server " +
            "(engine: 'moro' or 'uws') - falling back to socket.io/ws detection",
          'AdapterDetection'
        );
      } else if (adapterType === 'socket.io' && isPackageAvailable('socket.io')) {
        try {
          const { SocketIOAdapter } = await import('./networking/adapters/index.js');
          return new SocketIOAdapter();
        } catch {
          this.logger.warn('socket.io specified but failed to load', 'AdapterDetection');
        }
      } else if (adapterType === 'ws' && isPackageAvailable('ws')) {
        try {
          const { WSAdapter } = await import('./networking/adapters/index.js');
          return new WSAdapter();
        } catch {
          this.logger.warn('ws specified but failed to load', 'AdapterDetection');
        }
      }
    }

    // Auto-detect. The uws adapter is deliberately NOT probed here: it only
    // works integrated with the native engine's app (the usingUWebSockets
    // branch of setupWebSockets), and with the engine installed by default a
    // resolvable package no longer implies the engine is serving HTTP.

    // Try socket.io first
    if (isPackageAvailable('socket.io')) {
      try {
        const { SocketIOAdapter } = await import('./networking/adapters/index.js');
        this.logger.debug('socket.io detected and loaded', 'AdapterDetection');
        return new SocketIOAdapter();
      } catch {
        // Failed to load adapter
      }
    }

    // Try native ws library last
    if (isPackageAvailable('ws')) {
      try {
        const { WSAdapter } = await import('./networking/adapters/index.js');
        this.logger.debug('ws detected and loaded', 'AdapterDetection');
        return new WSAdapter();
      } catch {
        // Failed to load adapter
      }
    }

    this.logger.warn(
      'No WebSocket adapter found. Install uWebSockets.js, socket.io, or ws for WebSocket support',
      'AdapterDetection'
    );
    return null;
  }

  private requestLoggingMiddleware() {
    return (req: HttpRequest, res: HttpResponse, next: () => void) => {
      const startTime = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        // Include request ID in log if request tracking is enabled
        const idPart = req.requestId ? ` [${req.requestId}]` : '';
        this.logger.info(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms${idPart}`);
      });

      next();
    };
  }

  // Public API for adding middleware
  addMiddleware(middleware: any) {
    // Check if it's a MiddlewareInterface object - don't add to globalMiddleware
    // MiddlewareInterface objects should be handled by MiddlewareManager
    if (middleware && typeof middleware === 'object' && middleware.install && middleware.metadata) {
      // This is a MiddlewareInterface - log warning and skip
      this.logger.warn(
        `MiddlewareInterface "${middleware.metadata.name}" passed to addMiddleware. ` +
          `This should be handled by MiddlewareManager.install() instead.`,
        'Middleware'
      );
      return this;
    }

    // Standard middleware function - add to HTTP server
    this.httpServer.use(middleware);
    this.emit('middleware:added', { middleware });
    return this;
  }

  // Public API for database registration
  registerDatabase(adapter: any) {
    this.container.register('database', () => adapter, true);
    this.emit('database:registered', { adapter });
    return this;
  }

  // Public API for accessing the DI container
  getContainer(): Container {
    return this.container;
  }

  // Public API for accessing HTTP server
  getHttpServer() {
    return this.httpServer;
  }

  // Public API for accessing Socket.IO server
  /**
   * Get WebSocket adapter (for backward compatibility)
   * @deprecated Use getWebSocketAdapter() instead
   */
  getIOServer() {
    if (!this.websocketAdapter) {
      throw new Error(
        'WebSocket adapter not available. Install socket.io or configure a WebSocket adapter.'
      );
    }
    return this.websocketAdapter;
  }

  /**
   * Get the WebSocket adapter
   */
  getWebSocketAdapter(): WebSocketAdapter | undefined {
    return this.websocketAdapter;
  }

  /**
   * Ensure WebSocket setup is complete (for async adapter detection)
   */
  async ensureWebSocketReady(): Promise<void> {
    if (this.websocketSetupPromise) {
      await this.websocketSetupPromise;
    }
  }

  /**
   * Get the WebSocket manager
   */
  getWebSocketManager(): WebSocketManager | undefined {
    return this.websocketManager;
  }

  async loadModule(moduleConfig: ModuleConfig): Promise<void> {
    this.logger.info(
      `Loading module: ${moduleConfig.name}@${moduleConfig.version}`,
      'ModuleLoader'
    );

    // Create module event bus once during module loading
    const moduleEventBus = this.eventBus.createModuleBus(moduleConfig.name);

    // Register services in DI container
    this.registerServices(moduleConfig);

    // Create module router with resilience patterns
    const router = await this.createModuleRouter(moduleConfig, moduleEventBus);

    // Setup WebSocket handlers
    if (moduleConfig.websockets) {
      await this.setupWebSocketHandlers(moduleConfig);
    }

    // Mount with versioning and configurable API prefix
    this.logger.debug(`Module version before basePath: "${moduleConfig.version}"`, 'ModuleLoader');
    const basePath = buildModuleBasePath(
      this.config.modules?.apiPrefix,
      moduleConfig.version,
      moduleConfig.name
    );
    this.logger.debug(`Generated basePath: "${basePath}"`, 'ModuleLoader');
    this.mountRouter(basePath, router);

    this.logger.info(`Module loaded: ${moduleConfig.name}`, 'ModuleLoader');
    this.emit('moduleLoaded', moduleConfig.name);
  }

  private registerServices(config: ModuleConfig): void {
    if (!config.services) return;

    for (const service of config.services) {
      const factory = () => {
        const dependencies = (service.dependencies || []).map(dep => this.container.resolve(dep));
        return new service.implementation(...dependencies);
      };

      this.container.register(service.name, factory, service.singleton || false);
    }

    // Register functional route handlers if they exist
    if (config.routeHandlers) {
      for (const [name, handler] of Object.entries(config.routeHandlers)) {
        this.container.register(name, () => handler, false);
      }
    }

    // Register functional socket handlers if they exist
    if (config.socketHandlers) {
      for (const [name, handler] of Object.entries(config.socketHandlers)) {
        this.container.register(name, () => handler, false);
      }
    }
  }

  private async createModuleRouter(config: ModuleConfig, moduleEventBus: any): Promise<Router> {
    const router = new Router();

    this.logger.debug(`Creating router for module: ${config.name}`, 'Router');
    this.logger.debug(`Module has ${config.routes?.length || 0} routes`, 'Router');

    if (!config.routes) return router;

    // Calculate basePath for this module
    const basePath = buildModuleBasePath(
      this.config.modules?.apiPrefix,
      config.version,
      config.name
    );

    for (const route of config.routes) {
      this.logger.debug(
        `Adding route: ${route.method} ${route.path} -> ${route.handler}`,
        'Router'
      );
      const handler = await this.createResilientHandler(route, config, moduleEventBus);
      const method = route.method.toLowerCase() as keyof Router;

      // Transform path: module root '/' becomes the basePath, other paths are appended
      const routePath = route.path === '/' ? '' : route.path;
      const fullPath = basePath + routePath;

      // Add route to router with FULL PATH (including basePath)
      // This ensures UnifiedRouter sees the complete path like /api/v1.0.0/health
      (router[method] as CallableFunction)(fullPath, handler);
    }

    this.logger.debug(`Router created with ${router.getRoutes().length} total routes`, 'Router');
    return router;
  }

  private async createResilientHandler(
    route: InternalRouteDefinition,
    config: ModuleConfig,
    moduleEventBus: any
  ) {
    const handlerKey = `${config.name}.${route.handler}`;

    return async (req: HttpRequest, res: HttpResponse) => {
      const requestId = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');

      try {
        // Apply module-level middleware first
        if (config.middleware && config.middleware.length > 0) {
          const moduleMiddlewareExecuted = await this.executeModuleMiddleware(
            config.middleware,
            req,
            res
          );
          if (!moduleMiddlewareExecuted) {
            // Middleware handled response or stopped execution
            return;
          }
        }

        // Apply route-level middleware
        if (route.middleware && route.middleware.length > 0) {
          const routeMiddlewareExecuted = await this.executeModuleMiddleware(
            route.middleware,
            req,
            res
          );
          if (!routeMiddlewareExecuted) {
            // Middleware handled response or stopped execution
            return;
          }
        }

        // Try to get functional handler first, then fall back to service-based
        let handler;
        let useEnhancedReq = false;

        if (config.routeHandlers && config.routeHandlers[route.handler]) {
          // New functional handler
          handler = config.routeHandlers[route.handler];
          useEnhancedReq = true;
          this.logger.debug(`Using functional handler: ${route.handler}`, 'Handler', {
            availableHandlers: Object.keys(config.routeHandlers || {}),
          });
        } else if (this.container.has(config.name)) {
          // Old service-based handler
          const service = this.container.resolve(config.name) as any;
          handler = service[route.handler];
          this.logger.debug(`Using service handler: ${config.name}.${route.handler}`, 'Handler');
        } else {
          this.logger.error(`No handler found for route ${route.method} ${route.path}`, 'Handler', {
            routeHandlers: Object.keys(config.routeHandlers || {}),
            containerHasModule: this.container.has(config.name),
          });
          throw new Error(`Handler ${route.handler} not found for module ${config.name}`);
        }

        if (!handler || typeof handler !== 'function') {
          throw new Error(`Handler ${route.handler} is not a function`);
        }

        // Check authentication if auth configuration is provided
        if ((route as any).auth) {
          const auth = (req as any).auth;
          const authConfig = (route as any).auth;

          if (!auth) {
            res.status(401);
            res.json({
              success: false,
              error: 'Authentication required',
              message: 'You must be logged in to access this resource',
            });
            return;
          }

          // Check authentication requirement (default is required unless optional: true)
          if (!authConfig.optional && !auth.isAuthenticated) {
            res.status(401);
            res.json({
              success: false,
              error: 'Authentication required',
              message: 'You must be logged in to access this resource',
            });
            return;
          }

          // Skip further checks if not authenticated but optional
          if (!auth.isAuthenticated && authConfig.optional) {
            // Continue to handler
          } else if (auth.isAuthenticated) {
            const user = auth.user;

            // Check roles if specified
            if (authConfig.roles && authConfig.roles.length > 0) {
              const userRoles = user?.roles || [];
              const hasRole = authConfig.roles.some((role: string) => userRoles.includes(role));

              if (!hasRole) {
                res.status(403);
                res.json({
                  success: false,
                  error: 'Insufficient permissions',
                  message: `Required roles: ${authConfig.roles.join(', ')}`,
                  userRoles,
                });
                return;
              }
            }

            // Check permissions if specified
            if (authConfig.permissions && authConfig.permissions.length > 0) {
              const userPermissions = user?.permissions || [];
              const hasPermission = authConfig.permissions.every((permission: string) =>
                userPermissions.includes(permission)
              );

              if (!hasPermission) {
                res.status(403);
                res.json({
                  success: false,
                  error: 'Insufficient permissions',
                  message: `Required permissions: ${authConfig.permissions.join(', ')}`,
                  userPermissions,
                });
                return;
              }
            }
          }
        }

        // Validate request if validation schema is provided
        if (route.validation) {
          try {
            // Validate body
            if (route.validation.body && req.body !== undefined) {
              req.body = route.validation.body.parse(req.body);
            }

            // Validate query
            if (route.validation.query && req.query !== undefined) {
              req.query = route.validation.query.parse(req.query);
            }

            // Validate params
            if (route.validation.params && req.params !== undefined) {
              req.params = route.validation.params.parse(req.params);
            }

            // Validate headers
            if (route.validation.headers && req.headers !== undefined) {
              req.headers = route.validation.headers.parse(req.headers);
            }

            this.logger.debug('Module route validation passed', 'ModuleValidation', {
              route: `${route.method} ${route.path}`,
              module: config.name,
            });
          } catch (validationError: any) {
            if (validationError.issues) {
              this.logger.debug('Module route validation failed', 'ModuleValidation', {
                route: `${route.method} ${route.path}`,
                module: config.name,
                errors: validationError.issues.length,
              });

              // Format errors
              const errors = validationError.issues.map((issue: any) => ({
                field: issue.path.length > 0 ? issue.path.join('.') : 'request',
                message: issue.message,
                code: issue.code,
                path: issue.path,
              }));

              // Use route-level or global error handler
              const handler = route.onValidationError || this.config.modules.validation.onError;
              if (handler) {
                try {
                  // Determine which field failed (simplified - checks first validation type)
                  let failedField: 'body' | 'query' | 'params' | 'headers' = 'body';
                  if (route.validation.query) failedField = 'query';
                  if (route.validation.params) failedField = 'params';
                  if (route.validation.headers) failedField = 'headers';

                  const errorResponse = handler(errors, {
                    request: {
                      method: req.method || 'UNKNOWN',
                      path: req.path || req.url || '',
                      url: req.url || '',
                      headers: req.headers || {},
                    },
                    route: {
                      path: route.path,
                      method: route.method,
                    },
                    field: failedField,
                  });

                  if (errorResponse.headers) {
                    Object.entries(errorResponse.headers).forEach(([key, value]) => {
                      res.setHeader(key, String(value));
                    });
                  }

                  res.status(errorResponse.status).json(errorResponse.body);
                  return;
                } catch (handlerError) {
                  this.logger.error('Error in validation error handler', 'ValidationError', {
                    error:
                      handlerError instanceof Error ? handlerError.message : String(handlerError),
                  });

                  // Fallback if handler throws
                  res.status(500).json({
                    success: false,
                    error: 'Internal error while handling validation error',
                    requestId,
                  });
                  return;
                }
              }

              // Default error response if no handler
              res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: errors,
                requestId,
              });
              return;
            }
            throw validationError;
          }
        }

        // Prepare request object based on handler type
        let requestToUse: any = req;
        if (useEnhancedReq) {
          // Use the pre-created module event bus
          // IMPORTANT: Spread operator doesn't copy getters from IncomingMessage
          // so we need to explicitly pass critical properties like headers
          requestToUse = {
            ...req,
            headers: req.headers, // Explicitly preserve headers
            params: req.params,
            query: req.query,
            body: req.body,
            path: req.path,
            method: req.method,
            url: req.url,
            ip: req.ip,
            requestId: req.requestId,
            cookies: req.cookies,
            database: this.container.has('database')
              ? this.container.resolve('database')
              : undefined,
            events: moduleEventBus, // Use pre-created event bus
            app: {
              get: (key: string) => (key === 'io' ? this.websocketAdapter : undefined),
            },
          };
          this.logger.debug(`Database available: ${!!requestToUse.database}`, 'Handler', {
            moduleId: config.name,
          });
        }

        // Execute with circuit breaker
        const circuitBreaker = this.getCircuitBreaker(handlerKey);
        const result = await circuitBreaker.execute(() => handler(requestToUse, res));

        // For functional handlers, ensure the response is sent
        if (useEnhancedReq && result !== undefined && result !== null && !res.headersSent) {
          this.logger.debug(`Sending functional handler result`, 'Handler', {
            result,
          });
          res.json(result);
        }

        return result;
      } catch (error: any) {
        this.logger.error(`Route handler error [${requestId}]: ${error.message}`, 'Handler', {
          requestId,
          handlerKey,
          stack: error.stack,
        });
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: 'Internal server error',
            requestId,
          });
        }
        throw error;
      }
    };
  }

  /**
   * Execute module middleware (resolve strings or use functions directly)
   * Returns false if middleware stopped execution, true to continue
   */
  private async executeModuleMiddleware(
    middleware: any[],
    req: HttpRequest,
    res: HttpResponse
  ): Promise<boolean> {
    // Get middleware manager from container (may not exist in all contexts)
    let middlewareManager: any = null;
    try {
      middlewareManager = this.container.resolve('middlewareManager');
    } catch {
      // Middleware manager not registered, will fall back to built-in only
    }

    for (const mw of middleware) {
      // If middleware is a string, resolve it from built-in or installed middleware
      let resolvedMiddleware: any;

      if (typeof mw === 'string') {
        // Try to resolve from middleware manager
        if (middlewareManager) {
          resolvedMiddleware = middlewareManager.get(mw);
        }

        if (!resolvedMiddleware) {
          // Try to resolve from built-in middleware
          const { builtInMiddleware } = await import('./middleware/built-in/index.js');
          resolvedMiddleware = (builtInMiddleware as any)[mw];
        }

        if (!resolvedMiddleware) {
          this.logger.warn(`Middleware '${mw}' not found, skipping`, 'ModuleMiddleware');
          continue;
        }
      } else if (typeof mw === 'function') {
        // Middleware is already a function
        resolvedMiddleware = mw;
      } else {
        this.logger.warn(`Invalid middleware type: ${typeof mw}, skipping`, 'ModuleMiddleware');
        continue;
      }

      // Execute the middleware
      try {
        let middlewareContinue = true;

        // Check if it's a MiddlewareInterface (needs to be converted to standard middleware)
        if (
          resolvedMiddleware &&
          typeof resolvedMiddleware === 'object' &&
          typeof resolvedMiddleware.install === 'function'
        ) {
          // This is a MiddlewareInterface, we can't execute it directly
          // These should be installed globally via app.use() or via the middleware manager
          this.logger.warn(
            `Middleware '${typeof mw === 'string' ? mw : 'unknown'}' is a MiddlewareInterface and cannot be used directly in module middleware. Use app.use() to install it globally instead.`,
            'ModuleMiddleware'
          );
          continue;
        }

        await new Promise<void>((resolve, reject) => {
          const next = () => {
            middlewareContinue = true;
            resolve();
          };

          const result = resolvedMiddleware(req, res, next);

          // Handle async middleware
          if (result && typeof result.then === 'function') {
            result
              .then(() => {
                if (middlewareContinue) {
                  resolve();
                }
              })
              .catch(reject);
          }
        });

        // Check if response was sent
        if (res.headersSent) {
          return false; // Stop execution
        }
      } catch (error: any) {
        this.logger.error(`Module middleware error: ${error.message}`, 'ModuleMiddleware', {
          middleware: typeof mw === 'string' ? mw : mw.name || 'anonymous',
          stack: error.stack,
        });
        // Let error propagate
        throw error;
      }
    }

    return true; // Continue to handler
  }

  private mountRouter(basePath: string, router: Router): void {
    this.logger.debug(`Mounting router for basePath: ${basePath}`, 'Router');

    // Register module routes directly with http-server
    // Routes are already stored with full paths (basePath + route.path) from createModuleRouter
    const routes = router.getRoutes();
    for (const route of routes) {
      // Routes already have full paths, no need to transform
      const fullPath = route.path;
      const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';

      this.logger.debug(`Registering module route: ${route.method} ${fullPath}`, 'Router');

      // Register route directly with http-server using its routing methods
      // Cast to any to handle different server types (MoroHttpServer, UWebSocketsHttpServer, MoroHttp2Server)
      const server = this.httpServer as any;
      if (server[method] && typeof server[method] === 'function') {
        server[method](fullPath, route.handler);
      }
    }

    this.logger.info(`Router mounted for ${basePath} with ${routes.length} routes`, 'Router');
  }

  private finalModuleHandlerSetup = false;

  // Setup final module handler - NO LONGER NEEDED
  // Module routes are now registered directly with http-server via mountRouter()
  setupFinalModuleHandler(): void {
    // Prevent duplicate setup
    if (this.finalModuleHandlerSetup) {
      this.logger.debug('Final module handler already set up, skipping', 'ModuleSystem');
      return;
    }
    this.finalModuleHandlerSetup = true;

    this.logger.info(
      'Module routes registered directly with http-server (no deferred handling needed)',
      'ModuleSystem'
    );

    // No middleware needed - routes are in the http-server route table
  }

  private async setupWebSocketHandlers(config: ModuleConfig): Promise<void> {
    if (!this.websocketAdapter || !this.websocketManager) {
      this.logger.warn(
        `Module ${config.name} defines WebSocket handlers but no WebSocket adapter is available`,
        'WebSocketSetup'
      );
      return;
    }

    const namespace = this.websocketAdapter.createNamespace(`/${config.name}`);

    for (const wsConfig of config.websockets || []) {
      await this.websocketManager.registerHandler(namespace, wsConfig, config);
    }
  }

  private checkRateLimit(
    identifier: string,
    rateLimit: { requests: number; window: number }
  ): boolean {
    if (!this.rateLimiters.has(identifier)) {
      this.rateLimiters.set(identifier, new Map());
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const handlerLimiter = this.rateLimiters.get(identifier)!;
    const now = Date.now();
    const limit = handlerLimiter.get(identifier);

    if (!limit || now > limit.resetTime) {
      handlerLimiter.set(identifier, {
        count: 1,
        resetTime: now + rateLimit.window,
      });
      return true;
    }

    if (limit.count >= rateLimit.requests) {
      return false;
    }

    limit.count++;
    return true;
  }

  /**
   * Which HTTP server backs this app, which package provides it, and the
   * fallback reason when the native engine was requested but unavailable.
   */
  getServerKind(): ServerKind {
    return { ...this.engineInfo };
  }

  // Decide which HTTP server to construct. Engine values:
  //   'moro' (default) - Moro's own native engine (@morojs/engine)
  //   'uws'            - opt in to uWebSockets.js
  //   'node'           - the Node.js http server (no native engine)
  // A chosen native engine that cannot load on this platform/Node ABI (e.g.
  // no prebuilt binary) silently degrades to the Node.js http server and logs
  // why - the app never fails to boot. The engine load happens here,
  // synchronously; the CJS module cache shares the instance with the server.
  private resolveEngineMode(options: MoroOptions): EngineChoice {
    const server = this.config.server || {};
    // Explicit engine wins. The deprecated useUWebSockets:true counts as an
    // explicit 'uws' choice - it always beat http2 before the engine option
    // existed, and silently changing that transport on upgrade would break
    // existing apps.
    let engineExplicit = server.engine !== undefined || server.useUWebSockets === true;
    let mode: 'moro' | 'node' | 'uws' = server.engine ?? (server.useUWebSockets ? 'uws' : 'moro');

    // A user-provided uWS adapter INSTANCE implies the uWS engine when the
    // engine wasn't chosen explicitly - otherwise the instance would be
    // silently discarded in favor of the default engine's WS bridge.
    const wsAdapterOption =
      options.websocket && typeof options.websocket === 'object'
        ? (options.websocket as any).adapter
        : undefined;
    const isUwsAdapterInstance =
      wsAdapterOption &&
      typeof wsAdapterOption.getAdapterName === 'function' &&
      wsAdapterOption.getAdapterName() === 'uWebSockets.js';
    if (isUwsAdapterInstance) {
      if (!engineExplicit && mode === 'moro') {
        mode = 'uws';
        engineExplicit = true;
      } else if (mode === 'moro') {
        this.logger.warn(
          "A uWebSockets.js adapter instance was provided but engine: 'moro' is set - " +
            'the instance is superseded by the Moro engine WebSocket bridge',
          'ServerInit'
        );
      }
    }

    // HTTP/2 is wanted via either the top-level option or server.http2 config.
    const wantH2 = Boolean(options.http2 ?? this.config.server?.http2);

    if (mode === 'node') {
      // The Node runtime serves HTTP/2 via the separate MoroHttp2Server.
      return wantH2 ? { kind: 'http2' } : { kind: 'node' };
    }

    // Clustering forks workers that each bind the port themselves; the native
    // engines rely on SO_REUSEPORT for that, which Windows lacks. The Node
    // server shares the listener over cluster IPC instead, so fall back there
    // rather than letting workers 2..N crash with EADDRINUSE.
    if (this.config.performance?.clustering?.enabled === true && process.platform === 'win32') {
      return {
        kind: 'node',
        fallbackReason:
          'clustering on Windows requires the Node.js http server (SO_REUSEPORT is unavailable)',
        explicitEngine: engineExplicit,
      };
    }

    // Environments where a native engine cannot apply (edge runtime, an
    // explicit ws/socket.io adapter that needs a Node http.Server)
    const gate = this.nativeEngineGate(options);
    if (gate) {
      // The native engine can't apply here - but http2 still can, and works
      // fine with the ws/socket.io adapters that trigger the gate, so honor an
      // explicit http2 opt-in rather than silently dropping it.
      return wantH2 ? { kind: 'http2' } : { kind: 'node', fallbackReason: gate };
    }

    // Load the specific package for the chosen engine - 'moro' never silently
    // uses uWS and vice-versa; each falls back only to Node. The load happens
    // BEFORE the http2 decision so we can feature-detect native ALPN h2.
    const pkg = mode === 'uws' ? 'uWebSockets.js' : '@morojs/engine';
    const loadErrors: string[] = [];
    const engine = loadNativeEngine({ candidates: [pkg], collectErrors: loadErrors });
    if (!engine) {
      // Prefer this load's own failure detail (missing prebuilt binary, ABI
      // mismatch, ...); only degrade to "not installed" when there is none.
      const detail =
        (loadErrors.length ? loadErrors : getNativeEngineLoadErrors())
          .map(e => e.split('\n')[0])
          .join('; ') || `${pkg} is not installed`;
      // An explicit http2 opt-in survives the engine's absence - falling all
      // the way to plain HTTP/1.1 would silently drop the user's choice.
      if (wantH2) {
        this.logger.warn(
          `Native engine (${mode}) unavailable (${detail}) - using the configured http2 server`,
          'ServerInit'
        );
        return { kind: 'http2' };
      }
      return { kind: 'node', fallbackReason: detail, explicitEngine: engineExplicit };
    }

    // HTTP/2 decision, now that the engine is loaded and its capabilities known.
    if (wantH2) {
      const canH2 = engine.capabilities?.http2 === true;
      if (mode === 'uws') {
        // uWebSockets.js does not serve HTTP/2 through this integration.
        this.logger.warn(
          "engine: 'uws' does not serve HTTP/2 - serving HTTP/1.1 (use engine: " +
            "'moro' with an h2-capable build, or engine: 'node' for the http2 server)",
          'ServerInit'
        );
        return { kind: 'engine', engine, requested: mode };
      }
      if (canH2) {
        // The Moro engine speaks ALPN h2 + http/1.1 on one TLS port.
        return { kind: 'engine', engine, requested: mode, h2: true };
      }
      // Engine can't do h2. An explicit engine choice keeps the engine (h1);
      // the default engine yields to the dedicated MoroHttp2Server.
      if (engineExplicit) {
        this.logger.warn(
          `engine: '${mode}' (build ${engine.version ?? 'unknown'}) does not support ` +
            'HTTP/2 - serving HTTP/1.1. Upgrade @morojs/engine or use engine: ' +
            "'node' for the http2 server.",
          'ServerInit'
        );
        return { kind: 'engine', engine, requested: mode };
      }
      return { kind: 'http2' };
    }

    return { kind: 'engine', engine, requested: mode };
  }

  // Reasons the native engine should not back this app even when loadable:
  // edge/serverless runtimes never use a listening server, and the ws /
  // socket.io adapters attach to a real Node http.Server for upgrades.
  private nativeEngineGate(options: MoroOptions): string | null {
    const runtimeType = (options as any).runtime?.type;
    if (runtimeType && runtimeType !== 'node') {
      return `runtime '${runtimeType}' does not use a Node listening server`;
    }

    const optionsAdapter =
      options.websocket && typeof options.websocket === 'object'
        ? options.websocket.adapter
        : undefined;
    if (optionsAdapter && typeof optionsAdapter.getAdapterName === 'function') {
      const name = optionsAdapter.getAdapterName();
      if (name && name !== 'uWebSockets.js') {
        return `websocket adapter '${name}' requires the Node.js http server`;
      }
    }

    const configuredAdapter = this.config.websocket?.adapter;
    if (typeof configuredAdapter === 'string' && configuredAdapter !== 'uws') {
      return `websocket adapter '${configuredAdapter}' requires the Node.js http server`;
    }

    return null;
  }

  /**
   * Parse size string (e.g., "10mb", "5gb") to bytes.
   * Delegates to the shared utility so every server + config path agrees.
   */
  private parseSizeToBytes(size: string | number): number {
    return parseSizeToBytes(size);
  }

  /**
   * Merge HTTP/2 settings from config.server.http2 and the top-level
   * options.http2 (options win — the highest-precedence, back-compat path)
   * into one Http2ServerOptions used by both the engine (ALPN h2) and the
   * MoroHttp2Server fallback.
   */
  private resolveH2Settings(options: MoroOptions): Http2ServerOptions {
    const out: Http2ServerOptions = {};
    const cfg = this.config.server?.http2;
    if (cfg && typeof cfg === 'object') {
      if (cfg.allowHTTP1 !== undefined) out.allowHTTP1 = cfg.allowHTTP1;
      if (cfg.maxSessionMemory !== undefined) out.maxSessionMemory = cfg.maxSessionMemory;
      if (cfg.settings) out.settings = { ...cfg.settings };
    }
    if (typeof options.http2 === 'object') {
      Object.assign(out, options.http2);
      if ((options.http2 as any).settings) {
        out.settings = { ...(out.settings ?? {}), ...(options.http2 as any).settings };
      }
    }
    if (out.allowHTTP1 === undefined) out.allowHTTP1 = true;
    return out;
  }

  /**
   * Resolve every size string in server.limits/timeouts/backlog into one flat
   * object of bytes/ms, built once and passed to whichever server boots. A
   * value left undefined means "use the server's own documented default".
   */
  private buildRuntimeLimits(): RuntimeLimits {
    const s = this.config.server ?? ({} as any);
    const limits = s.limits ?? {};
    const timeouts = s.timeouts ?? {};
    const size = (v: unknown): number | undefined =>
      v === undefined ? undefined : parseSizeToBytes(v as string | number);
    const multipart = limits.multipart ?? {};
    return {
      maxBodySize: parseSizeToBytes(s.bodySizeLimit ?? '10mb'),
      maxUploadSize: parseSizeToBytes(s.maxUploadSize ?? '100mb'),
      maxConnections: typeof s.maxConnections === 'number' ? s.maxConnections : 0,
      backlog: s.backlog,
      timeouts: {
        request: timeouts.request,
        idle: timeouts.idle,
        keepAlive: timeouts.keepAlive,
        headers: timeouts.headers,
      },
      maxHeaderSize: size(limits.maxHeaderSize),
      maxHeaders: limits.maxHeaders,
      wsMaxMessageSize: size(
        limits.wsMaxMessageSize ?? this.config.websocket?.options?.maxPayloadLength
      ),
      wsBackpressureLimit: size(limits.wsBackpressureLimit),
      writeHighWaterMark: size(limits.writeHighWaterMark),
      maxPendingBytes: size(limits.maxPendingBytes),
      multipart: {
        maxParts: multipart.maxParts,
        maxPartHeaderBytes: size(multipart.maxPartHeaderBytes),
        maxFiles: multipart.maxFiles,
        maxFileSize: size(multipart.maxFileSize),
      },
    };
  }

  private getCircuitBreaker(key: string): CircuitBreaker {
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(
        key,
        new CircuitBreaker({
          failureThreshold: 5,
          resetTimeout: 30000,
          monitoringPeriod: 10000,
        })
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.circuitBreakers.get(key)!;
  }

  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  listen(port: number, host?: string | (() => void), callback?: () => void): void {
    if (typeof host === 'function') {
      this.httpServer.listen(port, host);
    } else if (host) {
      this.httpServer.listen(port, host, callback);
    } else {
      this.httpServer.listen(port, callback);
    }
  }

  // Compatibility method for existing controllers
  set(key: string, _value: any): void {
    if (key === 'io') {
      // Deprecated: Use websocket adapter instead
      this.logger.warn(
        'Setting io instance is deprecated. Use websocket adapter configuration.',
        'Deprecated'
      );
    }
  }

  get(key: string): any {
    if (key === 'io') {
      return this.websocketAdapter;
    }
    return undefined;
  }
}
