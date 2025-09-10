"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Moro = void 0;
const http2_1 = require("http2");
const socket_io_1 = require("socket.io");
const events_1 = require("events");
const http_1 = require("./http");
const http_2 = require("./http");
const utilities_1 = require("./utilities");
const modules_1 = require("./modules");
const networking_1 = require("./networking");
const utilities_2 = require("./utilities");
const events_2 = require("./events");
const logger_1 = require("./logger");
class Moro extends events_1.EventEmitter {
    httpServer;
    server; // HTTP/2 server type
    io;
    container;
    moduleLoader;
    websocketManager;
    circuitBreakers = new Map();
    rateLimiters = new Map();
    ioInstance;
    // Enterprise-grade event system
    eventBus;
    // Framework logger
    logger;
    options;
    constructor(options = {}) {
        super();
        this.options = options;
        // Configure global logger based on options
        if (options.logger !== undefined) {
            if (options.logger === false) {
                // Disable logging by setting level to fatal (highest level)
                logger_1.logger.setLevel('fatal');
            }
            else if (typeof options.logger === 'object') {
                // Configure logger with provided options
                if (options.logger.level) {
                    logger_1.logger.setLevel(options.logger.level);
                }
                // Additional logger options can be configured here in the future
                // For now, we focus on the level setting which is the most common need
            }
        }
        // Initialize framework logger after global configuration
        this.logger = (0, logger_1.createFrameworkLogger)('Core');
        this.httpServer = new http_1.MoroHttpServer();
        // Create HTTP/2 or HTTP/1.1 server based on options
        if (options.http2) {
            if (options.https) {
                this.server = (0, http2_1.createSecureServer)(options.https);
            }
            else {
                this.server = (0, http2_1.createServer)();
            }
            // Handle HTTP/2 streams manually
            this.server.on('stream', (stream, headers) => {
                // Convert HTTP/2 stream to HTTP/1.1-like request/response
                const req = stream;
                const res = stream;
                req.url = headers[':path'];
                req.method = headers[':method'];
                req.headers = headers;
                this.httpServer['handleRequest'](req, res);
            });
            this.logger.info('HTTP/2 server created', 'ServerInit');
        }
        else {
            this.server = this.httpServer.getServer();
        }
        this.io = new socket_io_1.Server(this.server, {
            cors: { origin: '*' },
            path: '/socket.io/',
        });
        this.ioInstance = this.io;
        this.container = new utilities_1.Container();
        this.moduleLoader = new modules_1.ModuleLoader(this.container);
        this.websocketManager = new networking_1.WebSocketManager(this.io, this.container);
        // Configure WebSocket advanced features
        if (options.websocket?.customIdGenerator) {
            this.websocketManager.setCustomIdGenerator(options.websocket.customIdGenerator);
        }
        if (options.websocket?.compression) {
            this.websocketManager.enableCompression();
        }
        // Initialize enterprise event bus
        this.eventBus = new events_2.MoroEventBus({
            maxListeners: 200,
            enableMetrics: true,
            isolation: 'module',
        });
        // Register event bus in DI container as factory
        this.container.register('eventBus', () => this.eventBus);
        this.setupCore();
    }
    // Middleware support
    use(middleware) {
        this.httpServer.use(middleware);
        return this;
    }
    setupCore() {
        // Security middleware
        this.httpServer.use(http_1.middleware.helmet());
        this.httpServer.use(http_1.middleware.cors());
        // Performance middleware
        this.httpServer.use(http_1.middleware.compression());
        this.httpServer.use(http_1.middleware.bodySize({ limit: '10mb' }));
        // Request tracking middleware
        this.httpServer.use(this.requestTrackingMiddleware());
        // Error boundary middleware
        this.httpServer.use(this.errorBoundaryMiddleware());
    }
    requestTrackingMiddleware() {
        return (req, res, next) => {
            const startTime = Date.now();
            res.on('finish', () => {
                const duration = Date.now() - startTime;
                this.logger.info(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms [${req.requestId}]`);
            });
            next();
        };
    }
    errorBoundaryMiddleware() {
        return async (req, res, next) => {
            try {
                next();
            }
            catch (error) {
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
    addMiddleware(middleware) {
        this.httpServer.use(middleware);
        this.emit('middleware:added', { middleware });
        return this;
    }
    // Public API for database registration
    registerDatabase(adapter) {
        this.container.register('database', () => adapter, true);
        this.emit('database:registered', { adapter });
        return this;
    }
    // Public API for accessing HTTP server
    getHttpServer() {
        return this.httpServer;
    }
    // Public API for accessing Socket.IO server
    getIOServer() {
        return this.io;
    }
    async loadModule(moduleConfig) {
        this.logger.info(`Loading module: ${moduleConfig.name}@${moduleConfig.version}`, 'ModuleLoader');
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
    registerServices(config) {
        if (!config.services)
            return;
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
    async createModuleRouter(config, moduleEventBus) {
        const router = new http_2.Router();
        this.logger.debug(`Creating router for module: ${config.name}`, 'Router');
        this.logger.debug(`Module has ${config.routes?.length || 0} routes`, 'Router');
        if (!config.routes)
            return router;
        for (const route of config.routes) {
            this.logger.debug(`Adding route: ${route.method} ${route.path} -> ${route.handler}`, 'Router');
            const handler = await this.createResilientHandler(route, config, moduleEventBus);
            const method = route.method.toLowerCase();
            // Add route to router
            router[method](route.path, handler);
        }
        this.logger.debug(`Router created with ${router.getRoutes().length} total routes`, 'Router');
        return router;
    }
    async createResilientHandler(route, config, moduleEventBus) {
        const handlerKey = `${config.name}.${route.handler}`;
        return async (req, res) => {
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
                }
                else if (this.container.has(config.name)) {
                    // Old service-based handler
                    const service = this.container.resolve(config.name);
                    handler = service[route.handler];
                    this.logger.debug(`Using service handler: ${config.name}.${route.handler}`, 'Handler');
                }
                else {
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
                    }
                    catch (validationError) {
                        if (validationError.issues) {
                            this.logger.debug('Module route validation failed', 'ModuleValidation', {
                                route: `${route.method} ${route.path}`,
                                module: config.name,
                                errors: validationError.issues.length,
                            });
                            res.status(400).json({
                                success: false,
                                error: 'Validation failed',
                                details: validationError.issues.map((issue) => ({
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
                let requestToUse = req;
                if (useEnhancedReq) {
                    // Use the pre-created module event bus
                    requestToUse = {
                        ...req,
                        database: this.container.has('database')
                            ? this.container.resolve('database')
                            : undefined,
                        events: moduleEventBus, // Use pre-created event bus
                        app: {
                            get: (key) => (key === 'io' ? this.ioInstance : undefined),
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
            }
            catch (error) {
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
    mountRouter(basePath, router) {
        this.logger.debug(`Mounting router for basePath: ${basePath}`, 'Router');
        // Enterprise-grade middleware integration with performance optimization
        this.httpServer.use(async (req, res, next) => {
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
                }
                catch (error) {
                    this.logger.error('Router error', 'Router', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                    if (!res.headersSent) {
                        res.status(500).json({ success: false, error: 'Internal server error' });
                    }
                }
            }
            else {
                next();
            }
        });
        this.logger.info(`Router mounted for ${basePath}`, 'Router');
    }
    async setupWebSocketHandlers(config) {
        const namespace = this.io.of(`/${config.name}`);
        for (const wsConfig of config.websockets || []) {
            await this.websocketManager.registerHandler(namespace, wsConfig, config);
        }
    }
    checkRateLimit(identifier, rateLimit) {
        if (!this.rateLimiters.has(identifier)) {
            this.rateLimiters.set(identifier, new Map());
        }
        const handlerLimiter = this.rateLimiters.get(identifier);
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
    getCircuitBreaker(key) {
        if (!this.circuitBreakers.has(key)) {
            this.circuitBreakers.set(key, new utilities_2.CircuitBreaker({
                failureThreshold: 5,
                resetTimeout: 30000,
                monitoringPeriod: 10000,
            }));
        }
        return this.circuitBreakers.get(key);
    }
    listen(port, host, callback) {
        if (typeof host === 'function') {
            this.httpServer.listen(port, host);
        }
        else if (host) {
            this.httpServer.listen(port, host, callback);
        }
        else {
            this.httpServer.listen(port, callback);
        }
    }
    // Compatibility method for existing controllers
    set(key, value) {
        if (key === 'io') {
            this.ioInstance = value;
        }
    }
    get(key) {
        if (key === 'io') {
            return this.ioInstance;
        }
        return undefined;
    }
}
exports.Moro = Moro;
