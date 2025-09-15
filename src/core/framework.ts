// Core Moro Framework with Pluggable WebSocket Adapters
import { createServer, Server } from 'http';
import {
  createSecureServer as createHttp2SecureServer,
  createServer as createHttp2Server,
} from 'http2';
import { EventEmitter } from 'events';
import { MoroHttpServer, HttpRequest, HttpResponse, middleware } from './http';
import { Router } from './http';
import { Container } from './utilities';
import { ModuleLoader } from './modules';
import { WebSocketManager } from './networking';
import { CircuitBreaker } from './utilities';
import { MoroEventBus } from './events';
import { createFrameworkLogger, logger as globalLogger } from './logger';
import { ModuleConfig, InternalRouteDefinition } from '../types/module';
import { LogLevel, LoggerOptions } from '../types/logger';
import { WebSocketAdapter, WebSocketAdapterOptions } from './networking/websocket-adapter';

export interface MoroOptions {
  http2?: boolean;
  https?: {
    key: string | Buffer;
    cert: string | Buffer;
    ca?: string | Buffer;
  };
  compression?: {
    enabled?: boolean;
    threshold?: number;
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
  logger?: LoggerOptions | boolean;
}

export class Moro extends EventEmitter {
  private httpServer: MoroHttpServer;
  private server: Server | any; // HTTP/2 server type
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

  constructor(options: MoroOptions = {}) {
    super();
    this.options = options;

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

    this.httpServer = new MoroHttpServer();

    // Create HTTP/2 or HTTP/1.1 server based on options
    if (options.http2) {
      if (options.https) {
        this.server = createHttp2SecureServer(options.https);
      } else {
        this.server = createHttp2Server();
      }

      // Handle HTTP/2 streams manually
      this.server.on('stream', (stream: any, headers: any) => {
        // Convert HTTP/2 stream to HTTP/1.1-like request/response
        const req = stream as any;
        const res = stream as any;
        req.url = headers[':path'];
        req.method = headers[':method'];
        req.headers = headers;
        this.httpServer['handleRequest'](req, res);
      });

      this.logger.info('HTTP/2 server created', 'ServerInit');
    } else {
      this.server = this.httpServer.getServer();
    }

    this.container = new Container();
    this.moduleLoader = new ModuleLoader(this.container);

    // Setup WebSocket adapter if enabled
    if (options.websocket !== false) {
      this.setupWebSockets(options.websocket || {});
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
    // Security middleware
    this.httpServer.use(middleware.helmet());
    this.httpServer.use(middleware.cors());

    // Performance middleware
    this.httpServer.use(middleware.compression());
    this.httpServer.use(middleware.bodySize({ limit: '10mb' }));

    // Request tracking middleware
    this.httpServer.use(this.requestTrackingMiddleware());

    // Error boundary middleware
    this.httpServer.use(this.errorBoundaryMiddleware());
  }

  /**
   * Setup WebSocket adapter and manager
   */
  private async setupWebSockets(wsConfig: any): Promise<void> {
    try {
      // Use provided adapter or try to auto-detect
      if (wsConfig.adapter) {
        this.websocketAdapter = wsConfig.adapter;
      } else {
        this.websocketAdapter = (await this.detectWebSocketAdapter()) || undefined;
      }

      if (this.websocketAdapter) {
        await this.websocketAdapter.initialize(this.server, wsConfig.options);
        this.websocketManager = new WebSocketManager(this.websocketAdapter, this.container);

        // Configure adapter features
        if (wsConfig.compression) {
          this.websocketAdapter.setCompression(true);
        }
        if (wsConfig.customIdGenerator) {
          this.websocketAdapter.setCustomIdGenerator(wsConfig.customIdGenerator);
        }

        this.logger.info(
          `WebSocket adapter initialized: ${this.websocketAdapter.getAdapterName()}`,
          'WebSocketSetup'
        );
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
   */
  private async detectWebSocketAdapter(): Promise<WebSocketAdapter | null> {
    // Try socket.io first
    try {
      const { SocketIOAdapter } = await import('./networking/adapters');
      return new SocketIOAdapter();
    } catch {
      // socket.io not available
    }

    // Try native ws library
    try {
      const { WSAdapter } = await import('./networking/adapters');
      return new WSAdapter();
    } catch {
      // ws not available
    }

    this.logger.warn(
      'No WebSocket adapter found. Install socket.io or ws for WebSocket support',
      'AdapterDetection'
    );
    return null;
  }

  private requestTrackingMiddleware() {
    return (req: HttpRequest, res: HttpResponse, next: () => void) => {
      const startTime = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        this.logger.info(
          `${req.method} ${req.path} - ${res.statusCode} - ${duration}ms [${req.requestId}]`
        );
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
      (router[method] as Function)(route.path, handler);
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
    this.httpServer.use(async (req: HttpRequest, res: HttpResponse, next: () => void) => {
      if (req.path.startsWith(basePath)) {
        this.logger.debug(`Module middleware handling: ${req.method} ${req.path}`, 'Middleware', {
          basePath,
        });

        try {
          const handled = await router.handle(req, res, basePath);
          this.logger.debug(`Route handled: ${handled}`, 'Router');

          if (!handled) {
            next(); // Let other middleware handle it
          }
          // If handled, the router already sent the response, so don't call next()
        } catch (error) {
          this.logger.error('Router error', 'Router', {
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

    this.logger.info(`Router mounted for ${basePath}`, 'Router');
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
  set(key: string, value: any): void {
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
