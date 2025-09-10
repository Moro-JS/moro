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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.simpleMiddleware = exports.builtInMiddleware = exports.MiddlewareManager = void 0;
// Middleware System for Moro
const events_1 = require("events");
const utilities_1 = require("../utilities");
const logger_1 = require("../logger");
class MiddlewareManager extends events_1.EventEmitter {
    middleware = new Map();
    simpleMiddleware = new Map();
    hooks;
    logger = (0, logger_1.createFrameworkLogger)('Middleware');
    constructor() {
        super();
        this.hooks = new utilities_1.HookManager();
    }
    // Register middleware without installing
    register(name, middleware) {
        if (this.middleware.has(name)) {
            throw new Error(`Middleware ${name} is already registered`);
        }
        this.middleware.set(name, middleware);
        this.logger.debug(`Registered middleware: ${name}`, 'Registration');
        this.emit('registered', { name, middleware });
    }
    // Install simple function-style middleware
    install(middleware, options = {}) {
        if (typeof middleware === 'function') {
            // Simple function-style middleware
            const simpleName = middleware.name || 'anonymous';
            this.logger.debug(`Installing simple middleware: ${simpleName}`, 'Installation');
            this.simpleMiddleware.set(simpleName, middleware);
            this.emit('installed', { name: simpleName, type: 'simple' });
            this.logger.info(`Simple middleware installed: ${simpleName}`, 'Installation');
            return;
        }
        // Advanced middleware with dependencies and lifecycle
        const name = middleware.metadata?.name || 'unknown';
        if (this.middleware.has(name)) {
            throw new Error(`Middleware ${name} is already installed`);
        }
        // Check dependencies
        if (middleware.metadata?.dependencies) {
            for (const dep of middleware.metadata.dependencies) {
                if (!this.middleware.has(dep)) {
                    throw new Error(`Dependency ${dep} not found for middleware ${name}`);
                }
            }
        }
        // Store middleware
        this.middleware.set(name, middleware);
        this.logger.debug(`Installing middleware: ${name}`, 'Installation');
        // Initialize middleware
        if (middleware.install) {
            middleware.install(this.hooks, options);
        }
        this.emit('installed', { name, middleware, options });
        this.logger.info(`Middleware installed: ${name}`, 'Installation');
    }
    // Uninstall middleware and clean up
    uninstall(name) {
        if (!this.middleware.has(name)) {
            throw new Error(`Middleware ${name} is not installed`);
        }
        const middleware = this.middleware.get(name);
        this.logger.debug(`Uninstalling middleware: ${name}`, 'Uninstallation');
        // Call cleanup if available
        if (middleware.uninstall) {
            middleware.uninstall(this.hooks);
        }
        this.middleware.delete(name);
        this.emit('uninstalled', { name, middleware });
        this.logger.info(`Middleware uninstalled: ${name}`, 'Uninstallation');
    }
    // Get installed middleware
    getInstalled() {
        return Array.from(this.middleware.keys());
    }
    // Get middleware configuration
    getConfig(name) {
        return this.middleware.get(name)?.metadata;
    }
    // Check if middleware is installed
    isInstalled(name) {
        return this.middleware.has(name);
    }
    // List all registered middleware
    list() {
        return Array.from(this.middleware.values());
    }
    // Dependency resolution with topological sorting for optimal middleware loading
    async installWithDependencies(middleware, options) {
        // Advanced topological sort for dependency resolution
        const resolved = this.topologicalSort(middleware);
        for (const middlewareItem of resolved) {
            const middlewareOptions = options?.[middlewareItem.name];
            await this.install(middlewareItem, middlewareOptions);
        }
    }
    // Optimized topological sort implementation for middleware dependencies
    topologicalSort(middleware) {
        const visited = new Set();
        const temp = new Set();
        const result = [];
        const visit = (middlewareItem) => {
            if (temp.has(middlewareItem.name)) {
                throw new Error(`Circular dependency detected: ${middlewareItem.name}`);
            }
            if (!visited.has(middlewareItem.name)) {
                temp.add(middlewareItem.name);
                // Visit dependencies first
                if (middlewareItem.dependencies) {
                    for (const depName of middlewareItem.dependencies) {
                        const dependency = middleware.find(m => m.name === depName);
                        if (dependency) {
                            visit(dependency);
                        }
                    }
                }
                temp.delete(middlewareItem.name);
                visited.add(middlewareItem.name);
                result.push(middlewareItem);
            }
        };
        for (const middlewareItem of middleware) {
            if (!visited.has(middlewareItem.name)) {
                visit(middlewareItem);
            }
        }
        return result;
    }
}
exports.MiddlewareManager = MiddlewareManager;
// Built-in middleware exports
var built_in_1 = require("./built-in");
Object.defineProperty(exports, "builtInMiddleware", { enumerable: true, get: function () { return built_in_1.builtInMiddleware; } });
Object.defineProperty(exports, "simpleMiddleware", { enumerable: true, get: function () { return built_in_1.simpleMiddleware; } });
__exportStar(require("./built-in"), exports);
