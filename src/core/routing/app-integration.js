"use strict";
// Integration layer for intelligent routing system with main Moro app
// Provides both chainable and schema-first APIs
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntelligentRoutingManager = exports.RouteRegistry = void 0;
const index_1 = require("./index");
const logger_1 = require("../logger");
const logger = (0, logger_1.createFrameworkLogger)('AppIntegration');
// Route registry for managing compiled routes
class RouteRegistry {
    routes = new Map();
    routePatterns = [];
    register(route) {
        const key = `${route.schema.method}:${route.schema.path}`;
        this.routes.set(key, route);
        // Convert path to regex pattern for matching
        const { pattern, paramNames } = this.pathToRegex(route.schema.path);
        this.routePatterns.push({
            pattern,
            route,
            method: route.schema.method,
            paramNames,
        });
        logger.debug(`Registered route: ${key}`, 'RouteRegistry', {
            path: route.schema.path,
            hasValidation: !!route.schema.validation,
            hasAuth: !!route.schema.auth,
            hasRateLimit: !!route.schema.rateLimit,
        });
    }
    async handleRequest(req, res) {
        const method = req.method?.toUpperCase();
        const path = req.path;
        // Find matching route
        for (const routePattern of this.routePatterns) {
            if (routePattern.method === method && routePattern.pattern.test(path)) {
                // Extract path parameters
                const matches = path.match(routePattern.pattern);
                if (matches) {
                    req.params = {};
                    routePattern.paramNames.forEach((name, index) => {
                        req.params[name] = matches[index + 1];
                    });
                }
                // Execute the route
                await routePattern.route.execute(req, res);
                return true; // Route handled
            }
        }
        return false; // No route matched
    }
    getRoutes() {
        return Array.from(this.routes.values());
    }
    pathToRegex(path) {
        const paramNames = [];
        // Convert path parameters like :id to regex groups
        const regexPath = path
            .replace(/\//g, '\\/') // Escape forward slashes
            .replace(/:([^/]+)/g, (match, paramName) => {
            paramNames.push(paramName);
            return '([^/]+)'; // Match parameter value
        });
        return {
            pattern: new RegExp(`^${regexPath}$`),
            paramNames,
        };
    }
}
exports.RouteRegistry = RouteRegistry;
// Intelligent routing manager class
class IntelligentRoutingManager {
    routeRegistry = new RouteRegistry();
    // Chainable route methods
    get(path) {
        return this.createChainableRoute('GET', path);
    }
    post(path) {
        return this.createChainableRoute('POST', path);
    }
    put(path) {
        return this.createChainableRoute('PUT', path);
    }
    delete(path) {
        return this.createChainableRoute('DELETE', path);
    }
    patch(path) {
        return this.createChainableRoute('PATCH', path);
    }
    head(path) {
        return this.createChainableRoute('HEAD', path);
    }
    options(path) {
        return this.createChainableRoute('OPTIONS', path);
    }
    // Schema-first route method
    route(schema) {
        const compiledRoute = (0, index_1.defineRoute)(schema);
        this.register(compiledRoute);
        return compiledRoute;
    }
    // Register compiled route
    register(route) {
        this.routeRegistry.register(route);
    }
    // Handle incoming requests with intelligent routing
    async handleIntelligentRoute(req, res) {
        return await this.routeRegistry.handleRequest(req, res);
    }
    // Get all registered routes (useful for debugging/docs)
    getIntelligentRoutes() {
        return this.routeRegistry.getRoutes();
    }
    // Direct route method (deprecated)
    directRoute(method, path, handler, options) {
        logger.warn('Using deprecated direct route method', 'DirectRoute', {
            method,
            path,
            suggestion: 'Use chainable or schema-first API instead',
        });
        // Convert direct options to new schema format
        const schema = {
            method: method.toUpperCase(),
            path,
            handler: handler,
        };
        if (options?.validation) {
            schema.validation = { body: options.validation };
        }
        if (options?.rateLimit) {
            schema.rateLimit = options.rateLimit;
        }
        this.route(schema);
    }
    createChainableRoute(method, path) {
        const builder = (0, index_1.createRoute)(method, path);
        // Override the handler method to auto-register the route
        const originalHandler = builder.handler.bind(builder);
        builder.handler = (handler) => {
            const compiledRoute = originalHandler(handler);
            this.register(compiledRoute);
            return compiledRoute;
        };
        return builder;
    }
}
exports.IntelligentRoutingManager = IntelligentRoutingManager;
