// Moro Framework - Modern TypeScript API Framework
// Built for developers who demand performance, elegance, and zero compromises
// Event-driven • Modular • Enterprise-ready • Developer-first
import { Moro as MoroCore } from './core/framework.js';
import { HttpRequest, HttpResponse, middleware } from './core/http/index.js';
import { ModuleConfig, InternalRouteDefinition } from './types/module.js';
import { MoroOptions } from './types/core.js';
import { ModuleDefaultsConfig } from './types/config.js';
import { MoroEventBus } from './core/events/index.js';
import { createFrameworkLogger, applyLoggingConfiguration } from './core/logger/index.js';
import { Logger } from './types/logger.js';
import { MiddlewareManager } from './core/middleware/index.js';
import { IntelligentRoutingManager } from './core/routing/app-integration.js';
import { RouteSchema } from './core/routing/index.js';
import {
  UnifiedRouter,
  RouteBuilder as UnifiedRouteBuilder,
} from './core/routing/unified-router.js';
import { AppDocumentationManager, DocsConfig } from './core/docs/index.js';
import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { normalizeValidationError } from './core/validation/schema-interface.js';
// Configuration System Integration
import { initializeConfig, type AppConfig } from './core/config/index.js';
// Runtime System Integration
import { RuntimeAdapter, RuntimeType, createRuntimeAdapter } from './core/runtime/index.js';

export class Moro extends EventEmitter {
  private coreFramework!: MoroCore;
  private routes: InternalRouteDefinition[] = [];
  private moduleCounter = 0;
  private loadedModules = new Set<string>();
  private lazyModules = new Map<string, ModuleConfig>();
  private routeHandlers: Record<string, Function> = {};
  private moduleDiscovery?: any; // Store for cleanup
  private autoDiscoveryOptions: MoroOptions | null = null;
  private autoDiscoveryInitialized = false;
  private autoDiscoveryPromise: Promise<void> | null = null;
  // Enterprise event system integration
  private eventBus!: MoroEventBus;
  // Application logger
  private logger!: Logger;
  // Unified routing system (singleton - shared across all routers)
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
    handlers: Record<string, Function>;
    processed: boolean;
  }> = [];

  constructor(options: MoroOptions = {}) {
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

    // Use simplified global configuration system
    this.config = initializeConfig(options);

    // Apply final config logging (this includes normalized logger → logging conversion)
    // Always apply this as it's the authoritative merged config
    if (this.config.logging) {
      applyLoggingConfiguration(this.config.logging, undefined);
      // Recreate logger with updated config
      this.logger = createFrameworkLogger('App');
    }

    // NOW initialize routing systems AFTER logger is configured
    this.unifiedRouter = UnifiedRouter.getInstance();
    this.intelligentRouting = new IntelligentRoutingManager();

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

    this.coreFramework = new MoroCore(frameworkOptions);

    // Initialize middleware system
    this.middlewareManager = new MiddlewareManager();

    // Integrate hooks system with HTTP server
    const httpServer = (this.coreFramework as any).httpServer;
    if (httpServer && httpServer.setHookManager) {
      httpServer.setHookManager((this.middlewareManager as any).hooks);
    }

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
    this.eventBus.emit('framework:initialized', {
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
  get(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  get(
    path: string,
    handler?: (req: HttpRequest, res: HttpResponse) => any,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler) {
      // Direct route registration
      return this.addRoute('GET', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.get(path);
  }

  post(path: string): UnifiedRouteBuilder;
  post(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  post(
    path: string,
    handler?: (req: HttpRequest, res: HttpResponse) => any,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler) {
      // Direct route registration
      return this.addRoute('POST', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.post(path);
  }

  put(path: string): UnifiedRouteBuilder;
  put(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  put(
    path: string,
    handler?: (req: HttpRequest, res: HttpResponse) => any,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler) {
      // Direct route registration
      return this.addRoute('PUT', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.put(path);
  }

  delete(path: string): UnifiedRouteBuilder;
  delete(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  delete(
    path: string,
    handler?: (req: HttpRequest, res: HttpResponse) => any,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler) {
      // Direct route registration
      return this.addRoute('DELETE', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.delete(path);
  }

  patch(path: string): UnifiedRouteBuilder;
  patch(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  patch(
    path: string,
    handler?: (req: HttpRequest, res: HttpResponse) => any,
    options?: any
  ): UnifiedRouteBuilder | this {
    if (handler) {
      // Direct route registration
      return this.addRoute('PATCH', path, handler, options);
    }
    // Use unified router for chainable API
    return this.unifiedRouter.patch(path);
  }

  // Schema-first route method
  route(schema: RouteSchema): void {
    // Use unified router for schema-first registration
    this.unifiedRouter.route(schema);
  }

  // Enable automatic API documentation
  enableDocs(config: DocsConfig): void {
    this.documentation.enableDocs(config, this.intelligentRouting);

    this.logger.info(`API Documentation enabled at ${config.basePath || '/docs'}`, 'Documentation');
    this.eventBus.emit('docs:enabled', { config });
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
    // Standard middleware integration (req, res, next pattern)
    if (typeof middlewareOrFunction === 'function' && middlewareOrFunction.length >= 3) {
      this.coreFramework.addMiddleware(middlewareOrFunction);
      this.eventBus.emit('middleware:registered', {
        type: 'standard',
        middleware: middlewareOrFunction,
      });
      return this;
    }

    // Function-style middleware execution
    if (typeof middlewareOrFunction === 'function' && middlewareOrFunction.length <= 1) {
      await middlewareOrFunction(this);
      this.eventBus.emit('middleware:executed', {
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
      return this;
    }

    // Fallback: emit event for unknown middleware types
    this.eventBus.emit('middleware:advanced', {
      middleware: middlewareOrFunction,
      config,
    });
    this.logger.debug(
      'Advanced middleware integration - enhanced capabilities loading...',
      'Middleware'
    );
    return this;
  }

  // Plugin compatibility layer - unified middleware interface
  async plugin(middleware: any, options?: any): Promise<this> {
    return this.use(middleware, options);
  }

  // Module loading with events
  async loadModule(moduleOrPath: ModuleConfig | string) {
    this.eventBus.emit('module:loading', {
      moduleId: typeof moduleOrPath === 'string' ? moduleOrPath : moduleOrPath.name,
    });

    if (typeof moduleOrPath === 'string') {
      const module = await this.importModule(moduleOrPath);
      await this.coreFramework.loadModule(module);
      this.loadedModules.add(moduleOrPath);
      this.eventBus.emit('module:loaded', {
        moduleId: module.name,
        version: module.version || '1.0.0',
      });
    } else {
      await this.coreFramework.loadModule(moduleOrPath);
      this.loadedModules.add(moduleOrPath.name);
      this.eventBus.emit('module:loaded', {
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
    this.eventBus.emit('database:connected', {
      adapter: adapter.constructor.name,
      config: 'hidden',
    });
    this.coreFramework.registerDatabase(adapter);
    return this;
  }

  // WebSocket helper with events
  websocket(namespace: string, handlers: Record<string, Function>) {
    // Queue the registration to be processed after adapter initialization
    const registration = { namespace, handlers, processed: false };
    this.queuedWebSocketRegistrations.push(registration);

    // Try to process immediately if adapter is already ready
    const adapter = this.coreFramework.getWebSocketAdapter();
    if (adapter && !registration.processed) {
      // Adapter is ready, process immediately
      this.processWebSocketRegistration(namespace, handlers, adapter);
      registration.processed = true;
    }
    // Otherwise, it will be processed when the server starts

    return this;
  }

  private processWebSocketRegistration(
    namespace: string,
    handlers: Record<string, Function>,
    adapter: any
  ) {
    this.emit('websocket:registering', { namespace, handlers });

    const ns = adapter.createNamespace(namespace);

    Object.entries(handlers).forEach(([event, handler]) => {
      ns.on('connection', (socket: any) => {
        this.emit('websocket:connection', { namespace, event, socket });

        socket.on(event, (data: any, callback: any) => {
          this.emit('websocket:event', { namespace, event, data });

          Promise.resolve(handler(socket, data))
            .then((result: any) => {
              this.emit('websocket:response', { namespace, event, result });
              if (callback) callback(result);
              else if (result) socket.emit(`${event}:response`, result);
            })
            .catch((error: any) => {
              this.emit('websocket:error', { namespace, event, error });
              const errorResponse = { success: false, error: error.message };
              if (callback) callback(errorResponse);
              else socket.emit('error', errorResponse);
            });
        });
      });
    });

    this.emit('websocket:registered', { namespace, handlers });
  }

  private async processQueuedWebSocketRegistrations() {
    // Wait for WebSocket adapter to be ready
    await this.coreFramework.ensureWebSocketReady();

    const adapter = this.coreFramework.getWebSocketAdapter();

    // Check if any unprocessed registrations exist
    const unprocessedRegistrations = this.queuedWebSocketRegistrations.filter(r => !r.processed);

    if (!adapter && unprocessedRegistrations.length > 0) {
      throw new Error(
        'WebSocket features require a WebSocket adapter.\n\n' +
          'Option 1: Install socket.io (auto-detected):\n' +
          '  npm install socket.io\n' +
          '  const app = new Moro({ websocket: {} });\n\n' +
          'Option 2: Configure a specific adapter:\n' +
          "  import { SocketIOAdapter } from '@morojs/moro';\n" +
          '  const app = new Moro({ websocket: { adapter: new SocketIOAdapter() } });\n\n' +
          'Option 3: Enable in config file (moro.config.js):\n' +
          '  export default { websocket: { enabled: true } };'
      );
    }

    if (adapter) {
      // Process all unprocessed registrations
      for (const registration of this.queuedWebSocketRegistrations) {
        if (!registration.processed) {
          this.processWebSocketRegistration(registration.namespace, registration.handlers, adapter);
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

    // Validate that we have a valid port
    if (!port || typeof port !== 'number') {
      throw new Error(
        'Port not specified and not found in configuration. Please provide a port number or configure it in moro.config.js/ts'
      );
    }

    // Check if clustering is enabled for massive performance gains
    // NOTE: uWebSockets.js does NOT support Node.js clustering - it's single-threaded only
    const usingUWebSockets = this.config.server?.useUWebSockets || false;

    if (this.config.performance?.clustering?.enabled) {
      if (usingUWebSockets) {
        this.logger.warn(
          'Clustering is not supported with uWebSockets.js - running in single-threaded mode. ' +
            'uWebSockets is so fast that single-threaded performance often exceeds multi-threaded Node.js!',
          'Cluster'
        );
        // Continue without clustering
      } else {
        this.startWithClustering(port, host as string, callback);
        return;
      }
    }
    this.eventBus.emit('server:starting', { port, runtime: this.runtimeType });

    // Add documentation middleware first (if enabled)
    try {
      const docsMiddleware = this.documentation.getDocsMiddleware();
      this.coreFramework.addMiddleware(docsMiddleware);
      this.logger.debug('Documentation middleware added', 'Documentation');
    } catch (error) {
      // Documentation not enabled, that's fine
      this.logger.debug('Documentation not enabled', 'Documentation');
    }

    // Add unified routing middleware (handles both chainable and direct routes)
    // Optimized: call router without extra async wrapper when possible
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

    // Register legacy direct routes with the HTTP server (for backward compatibility)
    if (this.routes.length > 0) {
      this.registerDirectRoutes();
    }

    const startServer = () => {
      const actualCallback = () => {
        const displayHost = host || 'localhost';
        this.logger.info('Moro Server Started', 'Server');
        this.logger.info(`Runtime: ${this.runtimeType}`, 'Server');
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

        this.eventBus.emit('server:started', { port, runtime: this.runtimeType });
        if (callback) callback();
      };

      if (host && typeof host === 'string') {
        this.coreFramework.listen(port, host, actualCallback);
      } else {
        this.coreFramework.listen(port, actualCallback);
      }
    };

    // Ensure auto-discovery and WebSocket setup is complete before starting server
    Promise.all([this.ensureAutoDiscoveryComplete(), this.processQueuedWebSocketRegistrations()])
      .then(() => {
        startServer();
      })
      .catch(error => {
        this.logger.error('Initialization failed during server start', 'Framework', {
          error: error instanceof Error ? error.message : String(error),
        });
        // For auto-discovery failures, start server anyway
        // For WebSocket failures with queued registrations, error will propagate
        if (
          error instanceof Error &&
          error.message.includes('WebSocket features require a WebSocket adapter')
        ) {
          throw error;
        }
        startServer();
      });
  }

  // Public method to manually initialize auto-discovery
  // Useful for ensuring auth middleware is registered before auto-discovery
  async initializeAutoDiscoveryNow(): Promise<void> {
    return this.ensureAutoDiscoveryComplete();
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

  // Get handler for non-Node.js runtimes
  getHandler() {
    // Ensure auto-discovery is complete for non-Node.js runtimes
    // This handles the case where users call getHandler() immediately after createApp()
    this.ensureAutoDiscoveryComplete().catch(error => {
      this.logger.error('Auto-discovery initialization failed for runtime handler', 'Framework', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Create a unified request handler that works with the runtime adapter
    const handler = async (req: HttpRequest, res: HttpResponse) => {
      // Add documentation middleware first (if enabled)
      try {
        const docsMiddleware = this.documentation.getDocsMiddleware();
        await docsMiddleware(req, res, () => {});
        if (res.headersSent) return;
      } catch (error) {
        // Documentation not enabled, that's fine
      }

      // Try unified router first (handles all routes)
      const handled = await this.unifiedRouter.handleRequest(req, res);
      if (handled) return;

      // Handle legacy direct routes (backward compatibility)
      if (this.routes.length > 0) {
        await this.handleDirectRoutes(req, res);
      }
    };

    // Use the runtime adapter to create the appropriate handler
    return this.runtimeAdapter.createServer(handler);
  }

  // Handle direct routes for runtime adapters
  private async handleDirectRoutes(req: HttpRequest, res: HttpResponse) {
    // Find matching route
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
          req.params[name] = matches[index + 1];
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
      if (!(res as any).headersSent) {
        (res as any).status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Internal server error',
        });
      }
    }
  }

  // Advanced route matching with caching and optimization
  private routeCache = new Map<string, { pattern: RegExp; paramNames: string[] }>();
  private staticRouteMap = new Map<string, any>();
  private dynamicRoutesBySegments = new Map<number, any[]>();

  private findMatchingRoute(method: string, path: string) {
    // Phase 1: O(1) static route lookup
    const staticKey = `${method}:${path}`;
    const staticRoute = this.staticRouteMap.get(staticKey);
    if (staticRoute) {
      return {
        ...staticRoute,
        pattern: /^.*$/, // Dummy pattern for static routes
        paramNames: [],
      };
    }

    // Phase 2: Optimized dynamic route matching by segment count
    const segments = path.split('/').filter(s => s.length > 0);
    const segmentCount = segments.length;
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
    const regexPath = path.replace(/\//g, '\\/').replace(/:([^/]+)/g, (match, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });

    return {
      pattern: new RegExp(`^${regexPath}$`),
      paramNames,
    };
  }

  // Access enterprise event system for advanced integrations
  get events() {
    return this.eventBus;
  }

  // Access to core framework for advanced usage
  get core() {
    return this.coreFramework;
  }

  // Force cleanup of pooled objects
  forceCleanup(): void {
    const httpServer = (this.coreFramework as any).httpServer;
    if (httpServer && httpServer.forceCleanup) {
      httpServer.forceCleanup();
    }
  }

  // Private methods
  private addRoute(method: string, path: string, handler: Function, options: any = {}) {
    // Register with unified router (primary routing system)
    this.unifiedRouter.addRoute(method as any, path, handler as any, options.middleware || []);

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
    };

    this.routes.push(route);

    // Organize routes for optimal lookup (legacy)
    this.organizeRouteForLookup(route);

    // Store handler for later module creation (legacy)
    this.routeHandlers[handlerName] = handler;

    return this;
  }

  private organizeRouteForLookup(route: any): void {
    if (!route.path.includes(':')) {
      // Static route - add to static map for O(1) lookup
      const staticKey = `${route.method}:${route.path}`;
      this.staticRouteMap.set(staticKey, route);
    } else {
      // Dynamic route - organize by segment count
      const segments = route.path.split('/').filter((s: string) => s.length > 0);
      const segmentCount = segments.length;

      if (!this.dynamicRoutesBySegments.has(segmentCount)) {
        this.dynamicRoutesBySegments.set(segmentCount, []);
      }
      this.dynamicRoutesBySegments.get(segmentCount)!.push(route);
    }
  }

  private registerDirectRoutes() {
    // Register routes directly with the HTTP server for optimal performance
    // This provides the intuitive developer experience users expect
    for (const route of this.routes) {
      const handler = this.routeHandlers[route.handler];

      // Get direct access to the HTTP server through the core framework
      const httpServer = (this.coreFramework as any).httpServer;

      // Create a wrapper handler that handles validation, rate limiting, and return values
      const wrappedHandler = async (req: any, res: any) => {
        try {
          // Enhance request with events property for direct routes
          req.events = this.eventBus;

          // Universal validation middleware (works with any ValidationSchema)
          if (route.validation) {
            try {
              const validated = await route.validation.parseAsync(req.body);
              req.body = validated;
            } catch (error: any) {
              // Handle universal validation errors
              const normalizedError = normalizeValidationError(error);
              res.status(400).json({
                success: false,
                error: 'Validation failed',
                details: normalizedError.issues.map((issue: any) => ({
                  field: issue.path.length > 0 ? issue.path.join('.') : 'body',
                  message: issue.message,
                  code: issue.code,
                })),
                requestId: req.requestId,
              });
              return;
            }
          }

          // Rate limiting middleware
          if (route.rateLimit) {
            const clientId = req.ip || req.connection.remoteAddress || 'unknown';
            const key = `${route.method}:${route.path}:${clientId}`;

            if (!this.checkRateLimit(key, route.rateLimit)) {
              res.status(429).json({
                success: false,
                error: 'Rate limit exceeded',
                retryAfter: Math.ceil(route.rateLimit.window / 1000),
              });
              return;
            }
          }

          // Execute the actual handler
          const result = await handler(req, res);
          if (result && !res.headersSent) {
            res.json(result);
          }
        } catch (error) {
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: error instanceof Error ? error.message : 'Internal server error',
            });
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

  private setupDefaultMiddleware(options: MoroOptions) {
    // CORS - check config enabled property OR options.security.cors.enabled === true
    if (this.config.security.cors.enabled || options.security?.cors?.enabled === true) {
      const corsOptions =
        typeof options.cors === 'object'
          ? options.cors
          : this.config.security.cors
            ? this.config.security.cors
            : {};
      this.use(middleware.cors(corsOptions));
    }

    // Helmet - check config enabled property OR options.security.helmet.enabled === true
    if (this.config.security.helmet.enabled || options.security?.helmet?.enabled === true) {
      this.use(middleware.helmet());
    }

    // Compression - check config enabled property OR options.performance.compression.enabled === true
    if (
      this.config.performance.compression.enabled ||
      options.performance?.compression?.enabled === true
    ) {
      const compressionOptions =
        typeof options.compression === 'object'
          ? options.compression
          : this.config.performance.compression
            ? this.config.performance.compression
            : {};
      this.use(middleware.compression(compressionOptions));
    }

    // Body size limiting
    this.use(middleware.bodySize({ limit: '10mb' }));
  }

  // Enhanced auto-discovery initialization
  private async initializeAutoDiscovery(options: MoroOptions): Promise<void> {
    const { ModuleDiscovery } = await import('./core/modules/auto-discovery.js');

    // Merge auto-discovery configuration
    const autoDiscoveryConfig = this.mergeAutoDiscoveryConfig(options);

    if (!autoDiscoveryConfig.enabled) {
      return;
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
          const basePath = `/api/v${module.version}/${module.name}`;
          const fullPath = `${basePath}${route.path}`;

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
    this.eventBus.emit('modules:changed', {
      modules: modules.map(m => ({ name: m.name, version: m.version })),
      timestamp: new Date(),
    });
  }

  // Legacy method for backward compatibility
  private autoDiscoverModules(modulesPath: string) {
    // Redirect to new system
    this.initializeAutoDiscovery({
      autoDiscover: {
        enabled: true,
        paths: [modulesPath],
      },
    });
  }

  private async importModule(modulePath: string): Promise<ModuleConfig> {
    const module = await import(modulePath);
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

  private startWithClustering(port: number, host?: string, callback?: () => void): void {
    // Worker count calculation - respect user choice
    let workerCount = this.config.performance?.clustering?.workers || os.cpus().length;

    // Only auto-optimize if user hasn't specified a number or set it to 'auto'
    if (workerCount === 'auto') {
      const cpuCount = os.cpus().length;
      const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);

      // Get memory per worker from config - if not set by user, calculate dynamically
      let memoryPerWorkerGB = this.config.performance?.clustering?.memoryPerWorkerGB;

      if (!memoryPerWorkerGB) {
        // Dynamic calculation: (Total RAM - 4GB headroom) / CPU cores
        const headroomGB = 4;
        memoryPerWorkerGB = Math.max(0.5, Math.floor((totalMemoryGB - headroomGB) / cpuCount));
      }

      // Conservative formula based on general guidelines:
      // - Don't exceed CPU cores
      // - Respect user's memory allocation preference
      // - Let the system resources determine the limit
      workerCount = Math.min(
        cpuCount, // Don't exceed CPU cores
        Math.floor(totalMemoryGB / memoryPerWorkerGB) // User-configurable memory per worker
      );

      this.logger.info(
        `Auto-calculated worker count: ${workerCount} (CPU: ${cpuCount}, RAM: ${totalMemoryGB.toFixed(1)}GB, ${memoryPerWorkerGB}GB per worker)`,
        'Cluster'
      );
    } else if (typeof workerCount === 'number') {
      // User specified a number - respect their choice
      this.logger.info(`Using user-specified worker count: ${workerCount}`, 'Cluster');
    }

    if (cluster.isPrimary) {
      this.logger.info(`Starting ${workerCount} workers`, 'Cluster');

      // Optimize cluster scheduling for high concurrency
      // Round-robin is the default on all platforms except Windows (Node.js docs)
      // Provides better load distribution than shared socket approach
      cluster.schedulingPolicy = cluster.SCHED_RR;

      // Set cluster settings for better performance
      cluster.setupMaster({
        exec: process.argv[1] || process.execPath,
        args: process.argv.slice(2),
        silent: false,
      });

      // IPC Optimization: Reduce communication overhead between master and workers
      // Research shows excessive IPC can create bottlenecks in clustered applications
      // (Source: BetterStack - Node.js Clustering Guide)
      process.env.NODE_CLUSTER_SCHED_POLICY = 'rr'; // Ensure round-robin
      process.env.NODE_DISABLE_COLORS = '1'; // Reduce IPC message size by disabling color codes

      // Graceful shutdown handler
      const gracefulShutdown = () => {
        this.logger.info('Gracefully shutting down cluster...', 'Cluster');

        // Clean up all workers
        for (const [pid, worker] of this.clusterWorkers) {
          worker.removeAllListeners();
          worker.kill('SIGTERM');
        }

        // Clean up cluster listeners
        cluster.removeAllListeners();
        process.exit(0);
      };

      // Handle process signals for graceful shutdown
      process.on('SIGINT', gracefulShutdown);
      process.on('SIGTERM', gracefulShutdown);

      // Fork workers with basic tracking
      for (let i = 0; i < workerCount; i++) {
        const worker = cluster.fork();
        this.clusterWorkers.set(worker.process.pid!, worker);
        this.logger.info(`Worker ${worker.process.pid} started`, 'Cluster');

        // Handle individual worker messages
        worker.on('message', this.handleWorkerMessage.bind(this));
      }

      // Simple worker exit handling
      cluster.on('exit', (worker: any, code: number, signal: string) => {
        const pid = worker.process.pid;
        this.clusterWorkers.delete(pid);

        if (code !== 0 && !worker.exitedAfterDisconnect) {
          this.logger.warn(
            `Worker ${pid} died unexpectedly (${signal || code}). Restarting...`,
            'Cluster'
          );

          // Simple restart
          const newWorker = cluster.fork();
          this.clusterWorkers.set(newWorker.process.pid!, newWorker);
          this.logger.info(`Worker ${newWorker.process.pid} restarted`, 'Cluster');
        }
      });

      // Master process callback
      if (callback) callback();
    } else {
      // Worker process - start the actual server with proper cleanup
      this.logger.info(`Worker ${process.pid} initializing`, 'Worker');

      // Worker-specific optimizations for high concurrency
      process.env.UV_THREADPOOL_SIZE = '64';

      // Reduce logging contention in workers (major bottleneck)
      // Multiple workers writing to same log files creates I/O contention
      // ONLY reduce log level if user didn't explicitly set one
      if (!this.userSetLogger) {
        // Workers log less frequently to reduce I/O contention (only if not explicitly configured)
        applyLoggingConfiguration(undefined, { level: 'warn' }); // Only warnings and errors
      }

      // Research-based memory optimization for workers
      const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
      const workerCount = Object.keys(cluster.workers || {}).length || 1;

      // Conservative memory allocation
      const heapSizePerWorkerMB = Math.min(
        Math.floor(((totalMemoryGB * 1024) / workerCount) * 0.8), // 80% of available memory
        1536 // Cap at 1.5GB (GC efficiency threshold from research)
      );

      process.env.NODE_OPTIONS = `--max-old-space-size=${heapSizePerWorkerMB}`;

      this.logger.debug(
        `Worker memory allocated: ${heapSizePerWorkerMB}MB heap (${workerCount} workers, ${totalMemoryGB.toFixed(1)}GB total)`,
        'Worker'
      );

      // Optimize V8 flags for better performance
      if (process.env.NODE_ENV === 'production') {
        // Aggressive V8 optimizations for maximum performance
        const v8Flags = [
          '--optimize-for-size', // Trade memory for speed
          '--always-opt', // Always optimize functions
          '--turbo-fast-api-calls', // Optimize API calls
          '--turbo-escape-analysis', // Escape analysis optimization
          '--turbo-inline-api-calls', // Inline API calls
          '--max-old-space-size=1024', // Limit memory to prevent GC pressure
        ];
        process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' ' + v8Flags.join(' ');
      }

      // Optimize garbage collection for workers
      // eslint-disable-next-line no-undef
      if ((global as any).gc) {
        setInterval(() => {
          // eslint-disable-next-line no-undef
          if ((global as any).gc) (global as any).gc();
        }, 60000); // GC every 60 seconds (less frequent)
      }

      // Graceful shutdown for worker
      const workerShutdown = () => {
        this.logger.info(`Worker ${process.pid} shutting down gracefully...`, 'Worker');

        // Clean up event listeners
        this.eventBus.removeAllListeners();
        this.removeAllListeners();

        // Close server gracefully
        if (this.coreFramework) {
          const server = (this.coreFramework as any).server;
          if (server) {
            server.close(() => {
              process.exit(0);
            });
          }
        }
      };

      // Handle worker shutdown signals
      process.on('SIGTERM', workerShutdown);
      process.on('SIGINT', workerShutdown);

      // Continue with normal server startup for this worker
      this.eventBus.emit('server:starting', {
        port,
        runtime: this.runtimeType,
        worker: process.pid,
      });

      // Add documentation middleware first (if enabled)
      try {
        const docsMiddleware = this.documentation.getDocsMiddleware();
        this.coreFramework.addMiddleware(docsMiddleware);
      } catch (error) {
        // Documentation not enabled, that's fine
      }

      // Add unified routing middleware (handles both chainable and direct routes)
      // Optimized: call router without extra async wrapper when possible
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

      // Register legacy direct routes with the HTTP server (for backward compatibility)
      if (this.routes.length > 0) {
        this.registerDirectRoutes();
      }

      const workerCallback = () => {
        const displayHost = host || 'localhost';
        this.logger.info(`Worker ${process.pid} ready on ${displayHost}:${port}`, 'Worker');
        this.eventBus.emit('server:started', {
          port,
          runtime: this.runtimeType,
          worker: process.pid,
        });
      };

      // Ensure WebSocket setup is complete before starting worker
      this.processQueuedWebSocketRegistrations()
        .then(() => {
          if (host) {
            this.coreFramework.listen(port, host, workerCallback);
          } else {
            this.coreFramework.listen(port, workerCallback);
          }
        })
        .catch(error => {
          this.logger.error('WebSocket initialization failed in worker', 'Worker', {
            error: error instanceof Error ? error.message : String(error),
          });
          // For WebSocket failures with queued registrations, error will propagate
          if (
            error instanceof Error &&
            error.message.includes('WebSocket features require a WebSocket adapter')
          ) {
            throw error;
          }
          // Start anyway for other errors
          if (host) {
            this.coreFramework.listen(port, host, workerCallback);
          } else {
            this.coreFramework.listen(port, workerCallback);
          }
        });
    }
  }

  // Simple worker message handler
  private handleWorkerMessage(message: any): void {
    // Handle inter-worker communication if needed
    if (message.type === 'health-check') {
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
  async close(): Promise<void> {
    this.logger.debug('Closing Moro application...');

    // Flush logger buffer before shutdown
    try {
      // Use flushBuffer for immediate synchronous flush
      this.logger.flushBuffer();
    } catch (error) {
      // Ignore flush errors during shutdown
    }

    // Close the core framework with timeout
    if (this.coreFramework && (this.coreFramework as any).httpServer) {
      try {
        await Promise.race([
          new Promise<void>(resolve => {
            (this.coreFramework as any).httpServer.close(() => {
              resolve();
            });
          }),
          new Promise<void>(resolve => setTimeout(resolve, 2000)), // 2 second timeout
        ]);
      } catch (error) {
        // Force close if graceful close fails
        this.logger.warn('Force closing HTTP server due to timeout');
      }
    }

    // Clean up module discovery watchers
    if (this.moduleDiscovery && typeof this.moduleDiscovery.cleanup === 'function') {
      try {
        this.moduleDiscovery.cleanup();
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    // Clean up event listeners
    try {
      this.eventBus.removeAllListeners();
      this.removeAllListeners();
    } catch (error) {
      // Ignore cleanup errors
    }

    this.logger.debug('Moro application closed successfully');
  }
}

// Export convenience function
export function createApp(options?: MoroOptions): Moro {
  return new Moro(options);
}

// Runtime-specific convenience functions
export function createAppNode(options?: Omit<MoroOptions, 'runtime'>): Moro {
  return new Moro({
    ...options,
    runtime: { type: 'node' },
  });
}

export function createAppEdge(options?: Omit<MoroOptions, 'runtime'>): Moro {
  return new Moro({
    ...options,
    runtime: { type: 'vercel-edge' },
  });
}

export function createAppLambda(options?: Omit<MoroOptions, 'runtime'>): Moro {
  return new Moro({
    ...options,
    runtime: { type: 'aws-lambda' },
  });
}

export function createAppWorker(options?: Omit<MoroOptions, 'runtime'>): Moro {
  return new Moro({
    ...options,
    runtime: { type: 'cloudflare-workers' },
  });
}
