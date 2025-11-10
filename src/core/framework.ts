// Core Moro Framework with Pluggable WebSocket Adapters
import { Server } from 'http';
import { EventEmitter } from 'events';
import { MoroHttpServer, HttpRequest, HttpResponse, Middleware } from './http/index.js';
import { UWebSocketsHttpServer } from './http/uws-http-server.js';
import { MoroHttp2Server, Http2ServerOptions } from './http/http2-server.js';
import { Router } from './routing/router.js';
import { Container } from './utilities/container.js';
import { ModuleLoader } from './modules/index.js';
import { WebSocketManager } from './networking/websocket-manager.js';
import { CircuitBreaker } from './utilities/circuit-breaker.js';
import { isPackageAvailable } from './utilities/package-utils.js';
import { MoroEventBus } from './events/index.js';
import { createFrameworkLogger, logger as globalLogger } from './logger/index.js';
import { ModuleConfig, InternalRouteDefinition } from '../types/module.js';
import { MoroOptions as CoreMoroOptions } from '../types/core.js';
import { WebSocketAdapter, WebSocketAdapterOptions } from './networking/websocket-adapter.js';
import { cors, helmet, compression, bodySize } from './middleware/built-in/index.js';

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
  private httpServer: MoroHttpServer | UWebSocketsHttpServer | MoroHttp2Server;
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
  private usingHttp2 = false;
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

    // Check if uWebSockets should be used for HTTP and WebSocket
    const useUWebSockets = this.config.server?.useUWebSockets || false;

    if (useUWebSockets) {
      try {
        // Try to use uWebSockets for high performance HTTP and WebSocket
        const sslOptions = this.config.server?.ssl || options.https;
        this.httpServer = new UWebSocketsHttpServer({ ssl: sslOptions });
        this.server = (this.httpServer as UWebSocketsHttpServer).getApp();
        this.usingUWebSockets = true;
        this.logger.info('uWebSockets HTTP+WebSocket server created', 'ServerInit');
      } catch (error) {
        // Fallback to standard HTTP/1.1 if uWebSockets fails to load
        this.logger.warn(
          'uWebSockets failed to initialize, falling back to Node.js http.Server. ' +
            'Error: ' +
            (error instanceof Error ? error.message : String(error)),
          'ServerInit'
        );
        this.usingUWebSockets = false;
        this.httpServer = new MoroHttpServer();
        this.server = (this.httpServer as MoroHttpServer).getServer();
      }
    } else if (options.http2) {
      // Use HTTP/2 with proper adapter
      const http2Options: Http2ServerOptions = {};

      if (typeof options.http2 === 'object') {
        // Advanced HTTP/2 configuration
        Object.assign(http2Options, options.http2);
      }

      // Add SSL configuration if provided
      if (options.https) {
        http2Options.key = options.https.key;
        http2Options.cert = options.https.cert;
        if (options.https.ca) {
          http2Options.ca = options.https.ca;
        }
      }

      this.httpServer = new MoroHttp2Server(http2Options);
      this.server = (this.httpServer as MoroHttp2Server).getServer();
      this.usingHttp2 = true;
      this.logger.info('HTTP/2 server created with native adapter', 'ServerInit');
    } else {
      // Use standard HTTP/1.1
      this.httpServer = new MoroHttpServer();
      this.server = (this.httpServer as MoroHttpServer).getServer();
    }

    this.container = new Container();
    this.moduleLoader = new ModuleLoader(this.container);

    // Setup WebSocket adapter if enabled in config OR options
    if (
      this.config.websocket.enabled ||
      (options.websocket && typeof options.websocket === 'object')
    ) {
      // Store the promise so we can await it before using websockets
      this.websocketSetupPromise = this.setupWebSockets(options.websocket || {});
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
      this.httpServer.use(cors(corsOptions) as unknown as Middleware);
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

    // Body size middleware - always enabled with configurable limit
    this.httpServer.use(bodySize({ limit: this.config.server.bodySizeLimit }));

    // Configure request tracking (ID generation) in HTTP server
    if (this.httpServer.setRequestTracking) {
      this.httpServer.setRequestTracking(this.config.server.requestTracking.enabled);
    }

    // Request logging middleware - separate from request tracking (ID generation)
    if (this.config.server.requestLogging.enabled) {
      this.httpServer.use(this.requestLoggingMiddleware());
    }

    // Error boundary middleware - configurable but recommended to keep enabled
    if (this.config.server.errorBoundary.enabled) {
      this.httpServer.use(this.errorBoundaryMiddleware());
    }
  }

  /**
   * Setup WebSocket adapter and manager
   */
  private async setupWebSockets(wsConfig: any): Promise<void> {
    try {
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
        if (wsConfig.adapter) {
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

      if (adapterType === 'uws' && isPackageAvailable('uWebSockets.js')) {
        try {
          const { UWebSocketsAdapter } = await import('./networking/adapters/index.js');
          return new UWebSocketsAdapter();
        } catch {
          this.logger.warn('uWebSockets.js specified but failed to load', 'AdapterDetection');
        }
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

    // Auto-detect: Try uWebSockets.js first (highest performance)
    if (isPackageAvailable('uWebSockets.js')) {
      try {
        const { UWebSocketsAdapter } = await import('./networking/adapters/index.js');
        this.logger.debug('uWebSockets.js detected and loaded', 'AdapterDetection');
        return new UWebSocketsAdapter();
      } catch {
        // Failed to load adapter
      }
    }

    // Try socket.io second
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

  private errorBoundaryMiddleware() {
    return async (req: HttpRequest, res: HttpResponse, next: () => void) => {
      try {
        next();
      } catch (error: any) {
        this.logger.error('Error:', error.message, error.stack);

        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: 'Internal server error',
            requestId: req.requestId,
          });
        }
      }
    };
  }

  // Public API for adding middleware
  addMiddleware(middleware: any) {
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

    // Mount with versioning
    this.logger.debug(`Module version before basePath: "${moduleConfig.version}"`, 'ModuleLoader');
    const basePath = `/api/v${moduleConfig.version}/${moduleConfig.name}`;
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

    for (const route of config.routes) {
      this.logger.debug(
        `Adding route: ${route.method} ${route.path} -> ${route.handler}`,
        'Router'
      );
      const handler = await this.createResilientHandler(route, config, moduleEventBus);
      const method = route.method.toLowerCase() as keyof Router;

      // Add route to router
      (router[method] as CallableFunction)(route.path, handler);
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
      const requestId = req.headers['x-request-id'] || Math.random().toString(36);

      try {
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

              res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: validationError.issues.map((issue: any) => ({
                  field: issue.path.length > 0 ? issue.path.join('.') : 'request',
                  message: issue.message,
                  code: issue.code,
                })),
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
          requestToUse = {
            ...req,
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

  private mountRouter(basePath: string, router: Router): void {
    this.logger.debug(`Mounting router for basePath: ${basePath}`, 'Router');

    // Enterprise-grade middleware integration with performance optimization
    // IMPORTANT: Module middleware runs AFTER user middleware (like auth) to ensure proper order
    this.httpServer.use(async (req: HttpRequest, res: HttpResponse, next: () => void) => {
      if (req.path.startsWith(basePath)) {
        this.logger.debug(`Module middleware handling: ${req.method} ${req.path}`, 'Middleware', {
          basePath,
        });

        // Mark this request as being handled by a module
        (req as any).__moduleBasePath = basePath;
        (req as any).__moduleRouter = router;

        // Continue to next middleware (including auth) first
        next();
      } else {
        next();
      }
    });

    this.logger.info(`Router mounted for ${basePath}`, 'Router');
  }

  private finalModuleHandlerSetup = false;

  // Setup final module handler that runs after all user middleware
  setupFinalModuleHandler(): void {
    // Prevent duplicate setup
    if (this.finalModuleHandlerSetup) {
      this.logger.debug('Final module handler already set up, skipping', 'ModuleSystem');
      return;
    }
    this.finalModuleHandlerSetup = true;

    this.logger.info(
      'Setting up final module handler to run after user middleware',
      'ModuleSystem'
    );

    this.httpServer.use(async (req: HttpRequest, res: HttpResponse, next: () => void) => {
      // Check if this request was marked for module handling
      const moduleBasePath = (req as any).__moduleBasePath;
      const moduleRouter = (req as any).__moduleRouter;

      if (moduleBasePath && moduleRouter && !res.headersSent) {
        this.logger.debug(`Final module handler processing: ${req.method} ${req.path}`, 'Router');

        try {
          const handled = await moduleRouter.handle(req, res, moduleBasePath);
          this.logger.debug(`Route handled by module: ${handled}`, 'Router');

          if (!handled) {
            next(); // Let other middleware handle it
          }
          // If handled, the router already sent the response, so don't call next()
        } catch (error) {
          this.logger.error('Module router error', 'Router', {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Internal server error' });
          }
        }
      } else {
        next();
      }
    });
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
