"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Container = exports.ServiceRegistrationBuilder = exports.FunctionalContainer = exports.withTimeout = exports.withRetry = exports.withCaching = exports.withLogging = exports.ServiceScope = exports.ServiceLifecycle = void 0;
// Enhanced Functional Dependency Injection Container
const events_1 = require("events");
// Service lifecycle states
var ServiceLifecycle;
(function (ServiceLifecycle) {
    ServiceLifecycle["UNINITIALIZED"] = "uninitialized";
    ServiceLifecycle["INITIALIZING"] = "initializing";
    ServiceLifecycle["INITIALIZED"] = "initialized";
    ServiceLifecycle["DISPOSING"] = "disposing";
    ServiceLifecycle["DISPOSED"] = "disposed";
    ServiceLifecycle["ERROR"] = "error";
})(ServiceLifecycle || (exports.ServiceLifecycle = ServiceLifecycle = {}));
// Service scopes
var ServiceScope;
(function (ServiceScope) {
    ServiceScope["SINGLETON"] = "singleton";
    ServiceScope["TRANSIENT"] = "transient";
    ServiceScope["REQUEST"] = "request";
    ServiceScope["MODULE"] = "module";
})(ServiceScope || (exports.ServiceScope = ServiceScope = {}));
// Higher-order functions for service composition
const withLogging = (logger) => (factory) => (deps, ctx) => {
    logger.debug(`Creating service with dependencies: ${Object.keys(deps).join(", ")}`);
    const start = Date.now();
    const result = factory(deps, ctx);
    logger.debug(`Service created in ${Date.now() - start}ms`);
    return result;
};
exports.withLogging = withLogging;
const withCaching = (ttl = 300000) => (factory) => {
    const cache = new Map();
    return async (deps, ctx) => {
        const key = `${ctx?.requestId || "global"}_${JSON.stringify(deps)}`;
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) {
            return cached.value;
        }
        const result = await factory(deps, ctx);
        cache.set(key, { value: result, expires: Date.now() + ttl });
        return result;
    };
};
exports.withCaching = withCaching;
const withRetry = (maxRetries = 3, delay = 1000) => (factory) => async (deps, ctx) => {
    let lastError = null;
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await factory(deps, ctx);
        }
        catch (error) {
            lastError = error;
            if (i < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, delay * Math.pow(2, i)));
            }
        }
    }
    throw lastError;
};
exports.withRetry = withRetry;
const withTimeout = (timeoutMs = 5000) => (factory) => async (deps, ctx) => {
    return Promise.race([
        factory(deps, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Service creation timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
};
exports.withTimeout = withTimeout;
// Enhanced Functional Container
class FunctionalContainer extends events_1.EventEmitter {
    services = new Map();
    instances = new Map();
    requestScopes = new Map();
    moduleScopes = new Map();
    globalInterceptors = [];
    cleanupInterval;
    constructor() {
        super();
        this.setupCleanup();
    }
    // Fluent registration API
    register(name) {
        return new ServiceRegistrationBuilder(this, name);
    }
    // Direct registration for simple cases
    singleton(name, factory) {
        this.register(name).singleton().factory(factory).build();
        return this;
    }
    transient(name, factory) {
        this.register(name).transient().factory(factory).build();
        return this;
    }
    // Functional service registration with HOFs
    compose(name, ...compositionFns) {
        const builder = this.register(name);
        return builder.compose(...compositionFns);
    }
    // Enhanced resolution with context
    async resolve(name, context) {
        const service = this.services.get(name);
        if (!service) {
            throw new Error(`Service '${name}' not registered`);
        }
        const scopeKey = this.getScopeKey(name, service.metadata.scope, context);
        const instanceMap = this.getInstanceMap(service.metadata.scope, context);
        let instance = instanceMap.get(scopeKey);
        if (!instance || this.shouldRecreate(instance, service.metadata)) {
            instance = await this.createInstance(name, service, context);
            instanceMap.set(scopeKey, instance);
        }
        instance.lastAccessed = Date.now();
        instance.accessCount++;
        return instance.value;
    }
    // Synchronous resolution for non-async services
    resolveSync(name, context) {
        const service = this.services.get(name);
        if (!service) {
            throw new Error(`Service '${name}' not registered`);
        }
        const scopeKey = this.getScopeKey(name, service.metadata.scope, context);
        const instanceMap = this.getInstanceMap(service.metadata.scope, context);
        let instance = instanceMap.get(scopeKey);
        if (!instance || this.shouldRecreate(instance, service.metadata)) {
            const result = this.createInstanceSync(name, service, context);
            instance = {
                value: result,
                metadata: service.metadata,
                lifecycle: ServiceLifecycle.INITIALIZED,
                lastAccessed: Date.now(),
                accessCount: 1,
                context,
            };
            instanceMap.set(scopeKey, instance);
        }
        instance.lastAccessed = Date.now();
        instance.accessCount++;
        return instance.value;
    }
    // Add global interceptors
    addInterceptor(interceptor) {
        this.globalInterceptors.push(interceptor);
        return this;
    }
    // Service health checks
    async healthCheck() {
        const results = {};
        for (const [name, instance] of this.instances) {
            const service = this.services.get(name);
            if (service?.metadata.lifecycle?.healthCheck) {
                try {
                    results[name] = await service.metadata.lifecycle.healthCheck();
                }
                catch {
                    results[name] = false;
                }
            }
            else {
                results[name] = instance.lifecycle === ServiceLifecycle.INITIALIZED;
            }
        }
        return results;
    }
    // Clear request-scoped services
    clearRequestScope(requestId) {
        const requestScope = this.requestScopes.get(requestId);
        if (requestScope) {
            requestScope.clear();
            this.requestScopes.delete(requestId);
        }
    }
    // Clear module-scoped services
    clearModuleScope(moduleId) {
        const moduleScope = this.moduleScopes.get(moduleId);
        if (moduleScope) {
            moduleScope.clear();
            this.moduleScopes.delete(moduleId);
        }
    }
    // Service introspection
    getServiceInfo() {
        const info = {};
        for (const [name, service] of this.services) {
            const instance = this.instances.get(name);
            info[name] = {
                scope: service.metadata.scope,
                dependencies: service.metadata.dependencies,
                tags: service.metadata.tags,
                lifecycle: instance?.lifecycle || ServiceLifecycle.UNINITIALIZED,
                accessCount: instance?.accessCount || 0,
                lastAccessed: instance?.lastAccessed
                    ? new Date(instance.lastAccessed).toISOString()
                    : null,
            };
        }
        return info;
    }
    // Dispose all services
    async dispose() {
        for (const [name, instance] of this.instances) {
            const service = this.services.get(name);
            if (service?.metadata.lifecycle?.dispose &&
                instance.lifecycle === ServiceLifecycle.INITIALIZED) {
                try {
                    instance.lifecycle = ServiceLifecycle.DISPOSING;
                    await service.metadata.lifecycle.dispose();
                    instance.lifecycle = ServiceLifecycle.DISPOSED;
                }
                catch (error) {
                    instance.lifecycle = ServiceLifecycle.ERROR;
                    this.emit("disposeError", { name, error });
                }
            }
        }
        this.instances.clear();
        this.requestScopes.clear();
        this.moduleScopes.clear();
    }
    // Internal implementation methods
    async createInstance(name, service, context) {
        const instance = {
            value: undefined,
            metadata: service.metadata,
            lifecycle: ServiceLifecycle.INITIALIZING,
            lastAccessed: Date.now(),
            accessCount: 0,
            context,
        };
        try {
            // Resolve dependencies
            const dependencies = await this.resolveDependencies(service.metadata, context);
            // Apply interceptors
            const interceptedFactory = this.applyInterceptors(name, service.factory, dependencies, context);
            // Create instance
            instance.value = await interceptedFactory();
            // Apply decorators
            instance.value = await this.applyDecorators(instance.value, service.decorators, context);
            // Run initialization lifecycle
            if (service.metadata.lifecycle?.init) {
                await service.metadata.lifecycle.init();
            }
            instance.lifecycle = ServiceLifecycle.INITIALIZED;
            this.emit("serviceCreated", { name, instance });
        }
        catch (error) {
            instance.lifecycle = ServiceLifecycle.ERROR;
            this.emit("serviceError", { name, error });
            // Try fallback if available
            if (service.metadata.fallback) {
                instance.value = service.metadata.fallback();
                instance.lifecycle = ServiceLifecycle.INITIALIZED;
            }
            else {
                throw error;
            }
        }
        return instance;
    }
    createInstanceSync(name, service, context) {
        // Simplified sync version - no async dependencies or lifecycle
        const dependencies = this.resolveDependenciesSync(service.metadata, context);
        return service.factory(dependencies, context);
    }
    async resolveDependencies(metadata, context) {
        const dependencies = {};
        for (const dep of metadata.dependencies) {
            dependencies[dep] = await this.resolve(dep, context);
        }
        for (const optDep of metadata.optional) {
            try {
                dependencies[optDep] = await this.resolve(optDep, context);
            }
            catch {
                // Optional dependency - continue without it
            }
        }
        return dependencies;
    }
    resolveDependenciesSync(metadata, context) {
        const dependencies = {};
        for (const dep of metadata.dependencies) {
            dependencies[dep] = this.resolveSync(dep, context);
        }
        for (const optDep of metadata.optional) {
            try {
                dependencies[optDep] = this.resolveSync(optDep, context);
            }
            catch {
                // Optional dependency - continue without it
            }
        }
        return dependencies;
    }
    applyInterceptors(name, factory, dependencies, context) {
        return [...this.globalInterceptors].reduceRight((next, interceptor) => () => interceptor(name, dependencies, context || this.createDefaultContext(), next), () => factory(dependencies, context));
    }
    async applyDecorators(instance, decorators, context) {
        let result = instance;
        for (const decorator of decorators) {
            result = await decorator(result, context || this.createDefaultContext());
        }
        return result;
    }
    getScopeKey(serviceName, scope, context) {
        switch (scope) {
            case ServiceScope.REQUEST:
                return `${serviceName}:${context?.requestId || "default-request"}`;
            case ServiceScope.MODULE:
                return `${serviceName}:${context?.moduleId || "default-module"}`;
            default:
                return serviceName; // Each singleton service gets its own key
        }
    }
    getInstanceMap(scope, context) {
        switch (scope) {
            case ServiceScope.REQUEST: {
                const requestId = context?.requestId || "default-request";
                if (!this.requestScopes.has(requestId)) {
                    this.requestScopes.set(requestId, new Map());
                }
                return this.requestScopes.get(requestId);
            }
            case ServiceScope.MODULE: {
                const moduleId = context?.moduleId || "default-module";
                if (!this.moduleScopes.has(moduleId)) {
                    this.moduleScopes.set(moduleId, new Map());
                }
                return this.moduleScopes.get(moduleId);
            }
            default:
                return this.instances;
        }
    }
    shouldRecreate(instance, metadata) {
        return (metadata.scope === ServiceScope.TRANSIENT ||
            instance.lifecycle === ServiceLifecycle.ERROR ||
            instance.lifecycle === ServiceLifecycle.DISPOSED);
    }
    createDefaultContext() {
        return {
            metadata: {},
            timestamp: Date.now(),
        };
    }
    setupCleanup() {
        // Cleanup request scopes after timeout
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            const timeout = 30 * 60 * 1000; // 30 minutes
            for (const [requestId, scope] of this.requestScopes) {
                const hasRecentActivity = Array.from(scope.values()).some((instance) => now - instance.lastAccessed < timeout);
                if (!hasRecentActivity) {
                    this.clearRequestScope(requestId);
                }
            }
        }, 5 * 60 * 1000); // Check every 5 minutes
        // Unref the interval so it doesn't keep the process alive during testing
        this.cleanupInterval.unref();
    }
    // Cleanup and destroy the container
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
        // Clear all scopes
        this.requestScopes.clear();
        this.moduleScopes.clear();
        this.instances.clear();
        this.services.clear();
        this.emit("containerDestroyed");
    }
    // Internal registration method
    _registerService(name, definition) {
        this.services.set(name, definition);
        this.emit("serviceRegistered", { name, metadata: definition.metadata });
        return this;
    }
    // Check if service exists
    has(name) {
        return this.services.has(name);
    }
}
exports.FunctionalContainer = FunctionalContainer;
// Fluent registration builder
class ServiceRegistrationBuilder {
    container;
    name;
    metadata = {
        scope: ServiceScope.SINGLETON,
        tags: [],
        dependencies: [],
        optional: [],
    };
    _factory;
    interceptors = [];
    decorators = [];
    constructor(container, name) {
        this.container = container;
        this.name = name;
    }
    // Scope configuration
    singleton() {
        this.metadata.scope = ServiceScope.SINGLETON;
        return this;
    }
    transient() {
        this.metadata.scope = ServiceScope.TRANSIENT;
        return this;
    }
    requestScoped() {
        this.metadata.scope = ServiceScope.REQUEST;
        return this;
    }
    moduleScoped() {
        this.metadata.scope = ServiceScope.MODULE;
        return this;
    }
    // Dependencies
    dependsOn(...deps) {
        this.metadata.dependencies = [
            ...(this.metadata.dependencies || []),
            ...deps,
        ];
        return this;
    }
    optionalDependsOn(...deps) {
        this.metadata.optional = [...(this.metadata.optional || []), ...deps];
        return this;
    }
    // Metadata
    tags(...tags) {
        this.metadata.tags = [...(this.metadata.tags || []), ...tags];
        return this;
    }
    // Lifecycle
    onInit(initFn) {
        this.metadata.lifecycle = { ...this.metadata.lifecycle, init: initFn };
        return this;
    }
    onDispose(disposeFn) {
        this.metadata.lifecycle = {
            ...this.metadata.lifecycle,
            dispose: disposeFn,
        };
        return this;
    }
    healthCheck(healthFn) {
        this.metadata.lifecycle = {
            ...this.metadata.lifecycle,
            healthCheck: healthFn,
        };
        return this;
    }
    fallback(fallbackFn) {
        this.metadata.fallback = fallbackFn;
        return this;
    }
    timeout(ms) {
        this.metadata.timeout = ms;
        return this;
    }
    // Factory and composition
    factory(factory) {
        this._factory = factory;
        return this;
    }
    compose(...compositionFns) {
        if (!this._factory) {
            throw new Error("Factory must be set before composition");
        }
        this._factory = compositionFns.reduce((acc, fn) => fn(acc), this._factory);
        return this;
    }
    // Interceptors and decorators
    intercept(interceptor) {
        this.interceptors.push(interceptor);
        return this;
    }
    decorate(decorator) {
        this.decorators.push(decorator);
        return this;
    }
    // Build and register
    build() {
        if (!this._factory) {
            throw new Error(`Factory not provided for service '${this.name}'`);
        }
        const definition = {
            factory: this._factory,
            metadata: {
                name: this.name,
                scope: this.metadata.scope,
                tags: this.metadata.tags,
                dependencies: this.metadata.dependencies,
                optional: this.metadata.optional,
                lifecycle: this.metadata.lifecycle,
                fallback: this.metadata.fallback,
                timeout: this.metadata.timeout,
            },
            interceptors: this.interceptors,
            decorators: this.decorators,
        };
        return this.container._registerService(this.name, definition);
    }
}
exports.ServiceRegistrationBuilder = ServiceRegistrationBuilder;
// Standard Container class
class Container {
    functionalContainer = new FunctionalContainer();
    register(name, factory, singleton = false) {
        this.functionalContainer
            .register(name)
            .factory(() => factory())[singleton ? "singleton" : "transient"]()
            .build();
    }
    resolve(name) {
        return this.functionalContainer.resolveSync(name);
    }
    has(name) {
        return this.functionalContainer.has(name);
    }
    // Expose enhanced container for migration
    getEnhanced() {
        return this.functionalContainer;
    }
}
exports.Container = Container;
