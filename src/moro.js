"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Moro = void 0;
exports.createApp = createApp;
exports.createAppNode = createAppNode;
exports.createAppEdge = createAppEdge;
exports.createAppLambda = createAppLambda;
exports.createAppWorker = createAppWorker;
// Moro Framework - Modern TypeScript API Framework
// Built for developers who demand performance, elegance, and zero compromises
// Event-driven • Modular • Enterprise-ready • Developer-first
const framework_1 = require("./core/framework");
const http_1 = require("./core/http");
const logger_1 = require("./core/logger");
const app_integration_1 = require("./core/routing/app-integration");
const docs_1 = require("./core/docs");
const fs_1 = require("fs");
const path_1 = require("path");
const events_1 = require("events");
// Configuration System Integration
const config_1 = require("./core/config");
// Runtime System Integration
const runtime_1 = require("./core/runtime");
class Moro extends events_1.EventEmitter {
    coreFramework;
    routes = [];
    moduleCounter = 0;
    loadedModules = new Set();
    routeHandlers = {};
    // Enterprise event system integration
    eventBus;
    // Application logger
    logger = (0, logger_1.createFrameworkLogger)("App");
    // Intelligent routing system
    intelligentRouting = new app_integration_1.IntelligentRoutingManager();
    // Documentation system
    documentation = new docs_1.AppDocumentationManager();
    // Configuration system
    config;
    // Runtime system
    runtimeAdapter;
    runtimeType;
    constructor(options = {}) {
        super(); // Call EventEmitter constructor
        // Configure logger from environment variables BEFORE config system initialization
        // This ensures the config loading process respects the log level
        const envLogLevel = process.env.LOG_LEVEL || process.env.MORO_LOG_LEVEL;
        if (envLogLevel) {
            (0, logger_1.applyLoggingConfiguration)({ level: envLogLevel }, undefined);
        }
        // Initialize configuration system
        this.config = (0, config_1.initializeConfig)();
        // Apply additional logging configuration from createApp options (takes precedence)
        if (options.logger !== undefined) {
            (0, logger_1.applyLoggingConfiguration)(undefined, options.logger);
        }
        this.logger.info(`Configuration system initialized: ${this.config.server.environment}:${this.config.server.port}`);
        // Initialize runtime system
        this.runtimeType = options.runtime?.type || "node";
        this.runtimeAdapter =
            options.runtime?.adapter || (0, runtime_1.createRuntimeAdapter)(this.runtimeType);
        this.logger.info(`Runtime system initialized: ${this.runtimeType}`, "Runtime");
        this.coreFramework = new framework_1.Moro();
        // Access enterprise event bus from core framework
        this.eventBus = this.coreFramework.eventBus;
        // Setup default middleware if enabled - use config defaults with options override
        this.setupDefaultMiddleware({
            ...this.getDefaultOptionsFromConfig(),
            ...options,
        });
        // Auto-discover modules if enabled
        if (options.autoDiscover !== false) {
            this.autoDiscoverModules(options.modulesPath || "./modules");
        }
        // Emit initialization event through enterprise event bus
        this.eventBus.emit("framework:initialized", {
            options,
            config: this.config,
            runtime: this.runtimeType,
        });
    }
    /**
     * Get configuration object
     */
    getConfig() {
        return this.config;
    }
    /**
     * Get runtime adapter
     */
    getRuntime() {
        return this.runtimeAdapter;
    }
    /**
     * Get runtime type
     */
    getRuntimeType() {
        return this.runtimeType;
    }
    /**
     * Extract default options from configuration
     */
    getDefaultOptionsFromConfig() {
        return {
            cors: this.config.security.cors.enabled,
            compression: this.config.performance.compression.enabled,
            helmet: this.config.security.helmet.enabled,
        };
    }
    get(path, handler, options) {
        if (handler) {
            // Direct route registration
            return this.addRoute("GET", path, handler, options);
        }
        // Chainable route builder
        return this.intelligentRouting.get(path);
    }
    post(path, handler, options) {
        if (handler) {
            // Direct route registration
            return this.addRoute("POST", path, handler, options);
        }
        // Chainable route builder
        return this.intelligentRouting.post(path);
    }
    put(path, handler, options) {
        if (handler) {
            // Direct route registration
            return this.addRoute("PUT", path, handler, options);
        }
        // Chainable route builder
        return this.intelligentRouting.put(path);
    }
    delete(path, handler, options) {
        if (handler) {
            // Direct route registration
            return this.addRoute("DELETE", path, handler, options);
        }
        // Chainable route builder
        return this.intelligentRouting.delete(path);
    }
    patch(path, handler, options) {
        if (handler) {
            // Direct route registration
            return this.addRoute("PATCH", path, handler, options);
        }
        // Chainable route builder
        return this.intelligentRouting.patch(path);
    }
    // Schema-first route method
    route(schema) {
        return this.intelligentRouting.route(schema);
    }
    // Enable automatic API documentation
    enableDocs(config) {
        this.documentation.enableDocs(config, this.intelligentRouting);
        this.logger.info(`API Documentation enabled at ${config.basePath || "/docs"}`, "Documentation");
        this.eventBus.emit("docs:enabled", { config });
    }
    // Get OpenAPI specification
    getOpenAPISpec() {
        return this.documentation.getOpenAPISpec();
    }
    // Get documentation as JSON
    getDocsJSON() {
        return this.documentation.getDocsJSON();
    }
    // Get documentation as YAML
    getDocsYAML() {
        return this.documentation.getDocsYAML();
    }
    // Refresh documentation (useful after adding routes dynamically)
    refreshDocs() {
        this.documentation.refreshDocs();
    }
    // Universal middleware system - seamlessly handles standard and advanced middleware
    async use(middlewareOrFunction, config) {
        // Standard middleware integration (req, res, next pattern)
        if (typeof middlewareOrFunction === "function" &&
            middlewareOrFunction.length >= 3) {
            this.coreFramework.addMiddleware(middlewareOrFunction);
            this.eventBus.emit("middleware:registered", {
                type: "standard",
                middleware: middlewareOrFunction,
            });
            return this;
        }
        // Function-style middleware execution
        if (typeof middlewareOrFunction === "function" &&
            middlewareOrFunction.length <= 1) {
            await middlewareOrFunction(this);
            this.eventBus.emit("middleware:executed", {
                type: "function",
                middleware: middlewareOrFunction,
            });
            return this;
        }
        // Advanced middleware pipeline integration
        this.eventBus.emit("middleware:advanced", {
            middleware: middlewareOrFunction,
            config,
        });
        this.logger.debug("Advanced middleware integration - enhanced capabilities loading...", "Middleware");
        return this;
    }
    // Plugin compatibility layer - unified middleware interface
    async plugin(middleware, options) {
        return this.use(middleware, options);
    }
    // Module loading with events
    async loadModule(moduleOrPath) {
        this.eventBus.emit("module:loading", {
            moduleId: typeof moduleOrPath === "string" ? moduleOrPath : moduleOrPath.name,
        });
        if (typeof moduleOrPath === "string") {
            const module = await this.importModule(moduleOrPath);
            await this.coreFramework.loadModule(module);
            this.loadedModules.add(moduleOrPath);
            this.eventBus.emit("module:loaded", {
                moduleId: module.name,
                version: module.version || "1.0.0",
            });
        }
        else {
            await this.coreFramework.loadModule(moduleOrPath);
            this.loadedModules.add(moduleOrPath.name);
            this.eventBus.emit("module:loaded", {
                moduleId: moduleOrPath.name,
                version: moduleOrPath.version || "1.0.0",
            });
        }
        return this;
    }
    // Database helper with events
    database(adapter) {
        this.eventBus.emit("database:connected", {
            adapter: adapter.constructor.name,
            config: "hidden",
        });
        this.coreFramework.registerDatabase(adapter);
        return this;
    }
    // WebSocket helper with events
    websocket(namespace, handlers) {
        this.emit("websocket:registering", { namespace, handlers });
        const io = this.coreFramework.getIOServer();
        const ns = io.of(namespace);
        Object.entries(handlers).forEach(([event, handler]) => {
            ns.on("connection", (socket) => {
                this.emit("websocket:connection", { namespace, event, socket });
                socket.on(event, (data, callback) => {
                    this.emit("websocket:event", { namespace, event, data });
                    Promise.resolve(handler(socket, data))
                        .then((result) => {
                        this.emit("websocket:response", { namespace, event, result });
                        if (callback)
                            callback(result);
                        else if (result)
                            socket.emit(`${event}:response`, result);
                    })
                        .catch((error) => {
                        this.emit("websocket:error", { namespace, event, error });
                        const errorResponse = { success: false, error: error.message };
                        if (callback)
                            callback(errorResponse);
                        else
                            socket.emit("error", errorResponse);
                    });
                });
            });
        });
        this.emit("websocket:registered", { namespace, handlers });
        return this;
    }
    listen(port, host, callback) {
        // Only available for Node.js runtime
        if (this.runtimeType !== "node") {
            throw new Error(`listen() is only available for Node.js runtime. Current runtime: ${this.runtimeType}. Use getHandler() for other runtimes.`);
        }
        // Handle overloaded parameters (port, callback) or (port, host, callback)
        if (typeof host === "function") {
            callback = host;
            host = undefined;
        }
        this.eventBus.emit("server:starting", { port, runtime: this.runtimeType });
        // Add documentation middleware first (if enabled)
        try {
            const docsMiddleware = this.documentation.getDocsMiddleware();
            this.coreFramework.addMiddleware(docsMiddleware);
            this.logger.debug("Documentation middleware added", "Documentation");
        }
        catch (error) {
            // Documentation not enabled, that's fine
            this.logger.debug("Documentation not enabled", "Documentation");
        }
        // Add intelligent routing middleware to handle chainable routes
        this.coreFramework.addMiddleware(async (req, res, next) => {
            // Try intelligent routing first
            const handled = await this.intelligentRouting.handleIntelligentRoute(req, res);
            if (!handled) {
                next(); // Fall back to direct routes
            }
        });
        // Register direct routes with the HTTP server
        if (this.routes.length > 0) {
            this.registerDirectRoutes();
        }
        const actualCallback = () => {
            const displayHost = host || "localhost";
            this.logger.info("Moro Server Started", "Server");
            this.logger.info(`Runtime: ${this.runtimeType}`, "Server");
            this.logger.info(`HTTP API: http://${displayHost}:${port}`, "Server");
            this.logger.info(`WebSocket: ws://${displayHost}:${port}`, "Server");
            this.logger.info("Native Node.js HTTP • Zero Dependencies • Maximum Performance", "Server");
            this.logger.info("Learn more at https://morojs.com", "Server");
            // Log intelligent routes info
            const intelligentRoutes = this.intelligentRouting.getIntelligentRoutes();
            if (intelligentRoutes.length > 0) {
                this.logger.info(`Intelligent Routes: ${intelligentRoutes.length} registered`, "Server");
            }
            this.eventBus.emit("server:started", { port, runtime: this.runtimeType });
            if (callback)
                callback();
        };
        if (host && typeof host === "string") {
            this.coreFramework.listen(port, host, actualCallback);
        }
        else {
            this.coreFramework.listen(port, actualCallback);
        }
    }
    // Get handler for non-Node.js runtimes
    getHandler() {
        // Create a unified request handler that works with the runtime adapter
        const handler = async (req, res) => {
            // Add documentation middleware first (if enabled)
            try {
                const docsMiddleware = this.documentation.getDocsMiddleware();
                await docsMiddleware(req, res, () => { });
                if (res.headersSent)
                    return;
            }
            catch (error) {
                // Documentation not enabled, that's fine
            }
            // Try intelligent routing first
            const handled = await this.intelligentRouting.handleIntelligentRoute(req, res);
            if (handled)
                return;
            // Handle direct routes
            if (this.routes.length > 0) {
                await this.handleDirectRoutes(req, res);
            }
        };
        // Use the runtime adapter to create the appropriate handler
        return this.runtimeAdapter.createServer(handler);
    }
    // Handle direct routes for runtime adapters
    async handleDirectRoutes(req, res) {
        // Find matching route
        const route = this.findMatchingRoute(req.method, req.path);
        if (!route) {
            res.status(404).json({ success: false, error: "Not found" });
            return;
        }
        try {
            // Extract path parameters
            const matches = req.path.match(route.pattern);
            if (matches) {
                req.params = {};
                route.paramNames.forEach((name, index) => {
                    req.params[name] = matches[index + 1];
                });
            }
            // Get handler function
            const handler = this.routeHandlers[route.handler];
            if (!handler) {
                res
                    .status(500)
                    .json({ success: false, error: "Handler not found" });
                return;
            }
            // Execute validation if present
            if (route.validation) {
                try {
                    const validated = route.validation.parse(req.body);
                    req.body = validated;
                }
                catch (error) {
                    if (error.issues) {
                        res.status(400).json({
                            success: false,
                            error: "Validation failed",
                            details: error.issues.map((issue) => ({
                                field: issue.path.length > 0 ? issue.path.join(".") : "body",
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
                const clientId = req.ip || "unknown";
                const key = `${route.method}:${route.path}:${clientId}`;
                if (!this.checkRateLimit(key, route.rateLimit)) {
                    res.status(429).json({
                        success: false,
                        error: "Rate limit exceeded",
                        retryAfter: Math.ceil(route.rateLimit.window / 1000),
                    });
                    return;
                }
            }
            // Execute the handler
            const result = await handler(req, res);
            if (result && !res.headersSent) {
                res.json(result);
            }
        }
        catch (error) {
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    error: error instanceof Error ? error.message : "Internal server error",
                });
            }
        }
    }
    // Find matching route
    findMatchingRoute(method, path) {
        for (const route of this.routes) {
            if (route.method === method) {
                const pattern = this.pathToRegex(route.path);
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
    pathToRegex(path) {
        const paramNames = [];
        const regexPath = path
            .replace(/\//g, "\\/")
            .replace(/:([^/]+)/g, (match, paramName) => {
            paramNames.push(paramName);
            return "([^/]+)";
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
    // Private methods
    addRoute(method, path, handler, options = {}) {
        const handlerName = `handler_${this.routes.length}`;
        this.routes.push({
            method: method,
            path,
            handler: handlerName,
            validation: options.validation,
            rateLimit: options.rateLimit,
            cache: options.cache,
            middleware: options.middleware,
        });
        // Store handler for later module creation
        this.routeHandlers[handlerName] = handler;
        return this;
    }
    registerDirectRoutes() {
        // Register routes directly with the HTTP server for optimal performance
        // This provides the intuitive developer experience users expect
        for (const route of this.routes) {
            const handler = this.routeHandlers[route.handler];
            // Get direct access to the HTTP server through the core framework
            const httpServer = this.coreFramework.httpServer;
            // Create a wrapper handler that handles validation, rate limiting, and return values
            const wrappedHandler = async (req, res) => {
                try {
                    // Enhance request with events property for direct routes
                    req.events = this.eventBus;
                    // Validation middleware (Zod-only)
                    if (route.validation) {
                        try {
                            const validated = route.validation.parse(req.body);
                            req.body = validated;
                        }
                        catch (error) {
                            if (error.issues) {
                                res.status(400).json({
                                    success: false,
                                    error: "Validation failed",
                                    details: error.issues.map((issue) => ({
                                        field: issue.path.length > 0 ? issue.path.join(".") : "body",
                                        message: issue.message,
                                        code: issue.code,
                                    })),
                                });
                                return;
                            }
                            throw error;
                        }
                    }
                    // Rate limiting middleware
                    if (route.rateLimit) {
                        const clientId = req.ip || req.connection.remoteAddress || "unknown";
                        const key = `${route.method}:${route.path}:${clientId}`;
                        if (!this.checkRateLimit(key, route.rateLimit)) {
                            res.status(429).json({
                                success: false,
                                error: "Rate limit exceeded",
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
                }
                catch (error) {
                    if (!res.headersSent) {
                        res.status(500).json({
                            success: false,
                            error: error instanceof Error
                                ? error.message
                                : "Internal server error",
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
    rateLimitStore = new Map();
    checkRateLimit(key, config) {
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
    setupDefaultMiddleware(options) {
        // CORS
        if (options.cors !== false) {
            const corsOptions = typeof options.cors === "object" ? options.cors : {};
            this.use(http_1.middleware.cors(corsOptions));
        }
        // Helmet
        if (options.helmet !== false) {
            this.use(http_1.middleware.helmet());
        }
        // Compression
        if (options.compression !== false) {
            const compressionOptions = typeof options.compression === "object" ? options.compression : {};
            this.use(http_1.middleware.compression(compressionOptions));
        }
        // Body size limiting
        this.use(http_1.middleware.bodySize({ limit: "10mb" }));
    }
    autoDiscoverModules(modulesPath) {
        try {
            if (!(0, fs_1.statSync)(modulesPath).isDirectory())
                return;
            const items = (0, fs_1.readdirSync)(modulesPath);
            items.forEach((item) => {
                const fullPath = (0, path_1.join)(modulesPath, item);
                if ((0, fs_1.statSync)(fullPath).isDirectory()) {
                    const indexPath = (0, path_1.join)(fullPath, "index.ts");
                    try {
                        (0, fs_1.statSync)(indexPath);
                        // Module directory found, will be loaded later
                        this.logger.debug(`Discovered module: ${item}`, "ModuleDiscovery");
                    }
                    catch {
                        // No index.ts, skip
                    }
                }
            });
        }
        catch {
            // Modules directory doesn't exist, that's fine
        }
    }
    async importModule(modulePath) {
        const module = await Promise.resolve(`${modulePath}`).then(s => __importStar(require(s)));
        return module.default || module;
    }
}
exports.Moro = Moro;
// Export convenience function
function createApp(options) {
    return new Moro(options);
}
// Runtime-specific convenience functions
function createAppNode(options) {
    return new Moro({
        ...options,
        runtime: { type: "node" },
    });
}
function createAppEdge(options) {
    return new Moro({
        ...options,
        runtime: { type: "vercel-edge" },
    });
}
function createAppLambda(options) {
    return new Moro({
        ...options,
        runtime: { type: "aws-lambda" },
    });
}
function createAppWorker(options) {
    return new Moro({
        ...options,
        runtime: { type: "cloudflare-workers" },
    });
}
