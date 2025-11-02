// Enhanced Functional Dependency Injection Container
import { EventEmitter } from 'events';

// Service lifecycle states
export enum ServiceLifecycle {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  DISPOSING = 'disposing',
  DISPOSED = 'disposed',
  ERROR = 'error',
}

// Service scopes
export enum ServiceScope {
  SINGLETON = 'singleton', // One instance per container
  TRANSIENT = 'transient', // New instance every time
  REQUEST = 'request', // One instance per request context
  MODULE = 'module', // One instance per module
}

// Service metadata and configuration
export interface ServiceMetadata {
  name: string;
  scope: ServiceScope;
  tags: string[];
  dependencies: string[];
  optional: string[];
  lifecycle?: {
    init?: () => Promise<void> | void;
    dispose?: () => Promise<void> | void;
    healthCheck?: () => Promise<boolean> | boolean;
  };
  fallback?: () => any;
  timeout?: number;
}

// Service definition with functional patterns
export interface ServiceDefinition<T = any> {
  factory: ServiceFactory<T>;
  metadata: ServiceMetadata;
  interceptors: ServiceInterceptor[];
  decorators: ServiceDecorator<T>[];
}

// Functional factory type
export type ServiceFactory<T> = (
  dependencies: Record<string, any>,
  context?: ServiceContext
) => T | Promise<T>;

// Service interceptor for AOP patterns
export type ServiceInterceptor = (
  serviceName: string,
  dependencies: Record<string, any>,
  context: ServiceContext,
  next: () => any
) => any | Promise<any>;

// Service decorator for functional composition
export type ServiceDecorator<T> = (instance: T, context: ServiceContext) => T | Promise<T>;

// Service context for request-scoped services
export interface ServiceContext {
  requestId?: string;
  moduleId?: string;
  metadata: Record<string, any>;
  timestamp: number;
}

// Service instance wrapper
interface ServiceInstance<T = any> {
  value: T;
  metadata: ServiceMetadata;
  lifecycle: ServiceLifecycle;
  lastAccessed: number;
  accessCount: number;
  context?: ServiceContext;
}

// Higher-order functions for service composition
export const withLogging =
  <T>(logger: any) =>
  (factory: ServiceFactory<T>): ServiceFactory<T> =>
  (deps, ctx) => {
    logger.debug(`Creating service with dependencies: ${Object.keys(deps).join(', ')}`);
    const start = Date.now();
    const result = factory(deps, ctx);
    logger.debug(`Service created in ${Date.now() - start}ms`);
    return result;
  };

export const withCaching =
  <T>(ttl = 300000) =>
  (factory: ServiceFactory<T>): ServiceFactory<T> => {
    const cache = new Map<string, { value: T; expires: number }>();
    return async (deps, ctx) => {
      const key = `${ctx?.requestId || 'global'}_${JSON.stringify(deps)}`;
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) {
        return cached.value;
      }
      const result = await factory(deps, ctx);
      cache.set(key, { value: result, expires: Date.now() + ttl });
      return result;
    };
  };

export const withRetry =
  <T>(maxRetries = 3, delay = 1000) =>
  (factory: ServiceFactory<T>): ServiceFactory<T> =>
  async (deps, ctx) => {
    let lastError: Error | null = null;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await factory(deps, ctx);
      } catch (error) {
        lastError = error as Error;
        if (i < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
      }
    }
    throw lastError;
  };

export const withTimeout =
  <T>(timeoutMs = 5000) =>
  (factory: ServiceFactory<T>): ServiceFactory<T> =>
  async (deps, ctx) => {
    return Promise.race([
      factory(deps, ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Service creation timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  };

// Enhanced Functional Container
export class FunctionalContainer extends EventEmitter {
  private services = new Map<string, ServiceDefinition>();
  private instances = new Map<string, ServiceInstance>();
  private requestScopes = new Map<string, Map<string, ServiceInstance>>();
  private moduleScopes = new Map<string, Map<string, ServiceInstance>>();
  private globalInterceptors: ServiceInterceptor[] = [];
  private cleanupInterval?: NodeJS.Timeout;

  constructor() {
    super();
    this.setupCleanup();
  }

  // Fluent registration API
  register<T>(name: string): ServiceRegistrationBuilder<T> {
    return new ServiceRegistrationBuilder<T>(this, name);
  }

  // Direct registration for simple cases
  singleton<T>(name: string, factory: ServiceFactory<T>): this {
    this.register<T>(name).singleton().factory(factory).build();
    return this;
  }

  transient<T>(name: string, factory: ServiceFactory<T>): this {
    this.register<T>(name).transient().factory(factory).build();
    return this;
  }

  // Functional service registration with HOFs
  compose<T>(
    name: string,
    ...compositionFns: Array<(factory: ServiceFactory<T>) => ServiceFactory<T>>
  ): ServiceRegistrationBuilder<T> {
    const builder = this.register<T>(name);
    return builder.compose(...compositionFns);
  }

  // Enhanced resolution with context
  async resolve<T>(name: string, context?: ServiceContext): Promise<T> {
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
  resolveSync<T>(name: string, context?: ServiceContext): T {
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
  addInterceptor(interceptor: ServiceInterceptor): this {
    this.globalInterceptors.push(interceptor);
    return this;
  }

  // Service health checks
  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, instance] of this.instances) {
      const service = this.services.get(name);
      if (service?.metadata.lifecycle?.healthCheck) {
        try {
          results[name] = await service.metadata.lifecycle.healthCheck();
        } catch {
          results[name] = false;
        }
      } else {
        results[name] = instance.lifecycle === ServiceLifecycle.INITIALIZED;
      }
    }

    return results;
  }

  // Clear request-scoped services
  clearRequestScope(requestId: string): void {
    const requestScope = this.requestScopes.get(requestId);
    if (requestScope) {
      requestScope.clear();
      this.requestScopes.delete(requestId);
    }
  }

  // Clear module-scoped services
  clearModuleScope(moduleId: string): void {
    const moduleScope = this.moduleScopes.get(moduleId);
    if (moduleScope) {
      moduleScope.clear();
      this.moduleScopes.delete(moduleId);
    }
  }

  // Service introspection
  getServiceInfo(): Record<string, any> {
    const info: Record<string, any> = {};

    for (const [name, service] of this.services) {
      const instance = this.instances.get(name);
      info[name] = {
        scope: service.metadata.scope,
        dependencies: service.metadata.dependencies,
        tags: service.metadata.tags,
        lifecycle: instance?.lifecycle || ServiceLifecycle.UNINITIALIZED,
        accessCount: instance?.accessCount || 0,
        lastAccessed: instance?.lastAccessed ? new Date(instance.lastAccessed).toISOString() : null,
      };
    }

    return info;
  }

  // Dispose all services
  async dispose(): Promise<void> {
    for (const [name, instance] of this.instances) {
      const service = this.services.get(name);
      if (
        service?.metadata.lifecycle?.dispose &&
        instance.lifecycle === ServiceLifecycle.INITIALIZED
      ) {
        try {
          instance.lifecycle = ServiceLifecycle.DISPOSING;
          await service.metadata.lifecycle.dispose();
          instance.lifecycle = ServiceLifecycle.DISPOSED;
        } catch (error) {
          instance.lifecycle = ServiceLifecycle.ERROR;
          this.emit('disposeError', { name, error });
        }
      }
    }

    this.instances.clear();
    this.requestScopes.clear();
    this.moduleScopes.clear();
  }

  // Internal implementation methods
  private async createInstance<T>(
    name: string,
    service: ServiceDefinition<T>,
    context?: ServiceContext
  ): Promise<ServiceInstance<T>> {
    const instance: ServiceInstance<T> = {
      value: undefined as any,
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
      const interceptedFactory = this.applyInterceptors(
        name,
        service.factory,
        dependencies,
        context
      );

      // Create instance
      instance.value = await interceptedFactory();

      // Apply decorators
      instance.value = await this.applyDecorators(instance.value, service.decorators, context);

      // Run initialization lifecycle
      if (service.metadata.lifecycle?.init) {
        await service.metadata.lifecycle.init();
      }

      instance.lifecycle = ServiceLifecycle.INITIALIZED;
      this.emit('serviceCreated', { name, instance });
    } catch (error) {
      instance.lifecycle = ServiceLifecycle.ERROR;
      this.emit('serviceError', { name, error });

      // Try fallback if available
      if (service.metadata.fallback) {
        instance.value = service.metadata.fallback();
        instance.lifecycle = ServiceLifecycle.INITIALIZED;
      } else {
        throw error;
      }
    }

    return instance;
  }

  private createInstanceSync<T>(
    name: string,
    service: ServiceDefinition<T>,
    context?: ServiceContext
  ): T {
    // Simplified sync version - no async dependencies or lifecycle
    const dependencies = this.resolveDependenciesSync(service.metadata, context);
    return service.factory(dependencies, context) as T;
  }

  private async resolveDependencies(
    metadata: ServiceMetadata,
    context?: ServiceContext
  ): Promise<Record<string, any>> {
    const dependencies: Record<string, any> = {};

    for (const dep of metadata.dependencies) {
      dependencies[dep] = await this.resolve(dep, context);
    }

    for (const optDep of metadata.optional) {
      try {
        dependencies[optDep] = await this.resolve(optDep, context);
      } catch {
        // Optional dependency - continue without it
      }
    }

    return dependencies;
  }

  private resolveDependenciesSync(
    metadata: ServiceMetadata,
    context?: ServiceContext
  ): Record<string, any> {
    const dependencies: Record<string, any> = {};

    for (const dep of metadata.dependencies) {
      dependencies[dep] = this.resolveSync(dep, context);
    }

    for (const optDep of metadata.optional) {
      try {
        dependencies[optDep] = this.resolveSync(optDep, context);
      } catch {
        // Optional dependency - continue without it
      }
    }

    return dependencies;
  }

  private applyInterceptors(
    name: string,
    factory: ServiceFactory<any>,
    dependencies: Record<string, any>,
    context?: ServiceContext
  ): () => any {
    return [...this.globalInterceptors].reduceRight(
      (next: () => any, interceptor: ServiceInterceptor) => () =>
        interceptor(name, dependencies, context || this.createDefaultContext(), next),
      () => factory(dependencies, context)
    );
  }

  private async applyDecorators<T>(
    instance: T,
    decorators: ServiceDecorator<T>[],
    context?: ServiceContext
  ): Promise<T> {
    let result = instance;
    for (const decorator of decorators) {
      result = await decorator(result, context || this.createDefaultContext());
    }
    return result;
  }

  private getScopeKey(serviceName: string, scope: ServiceScope, context?: ServiceContext): string {
    switch (scope) {
      case ServiceScope.REQUEST:
        return `${serviceName}:${context?.requestId || 'default-request'}`;
      case ServiceScope.MODULE:
        return `${serviceName}:${context?.moduleId || 'default-module'}`;
      default:
        return serviceName; // Each singleton service gets its own key
    }
  }

  private getInstanceMap(
    scope: ServiceScope,
    context?: ServiceContext
  ): Map<string, ServiceInstance> {
    switch (scope) {
      case ServiceScope.REQUEST: {
        const requestId = context?.requestId || 'default-request';
        if (!this.requestScopes.has(requestId)) {
          this.requestScopes.set(requestId, new Map());
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.requestScopes.get(requestId)!;
      }

      case ServiceScope.MODULE: {
        const moduleId = context?.moduleId || 'default-module';
        if (!this.moduleScopes.has(moduleId)) {
          this.moduleScopes.set(moduleId, new Map());
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.moduleScopes.get(moduleId)!;
      }

      default:
        return this.instances;
    }
  }

  private shouldRecreate(instance: ServiceInstance, metadata: ServiceMetadata): boolean {
    return (
      metadata.scope === ServiceScope.TRANSIENT ||
      instance.lifecycle === ServiceLifecycle.ERROR ||
      instance.lifecycle === ServiceLifecycle.DISPOSED
    );
  }

  private createDefaultContext(): ServiceContext {
    return {
      metadata: {},
      timestamp: Date.now(),
    };
  }

  private setupCleanup(): void {
    // Cleanup request scopes after timeout
    this.cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        const timeout = 30 * 60 * 1000; // 30 minutes

        for (const [requestId, scope] of this.requestScopes) {
          const hasRecentActivity = Array.from(scope.values()).some(
            instance => now - instance.lastAccessed < timeout
          );

          if (!hasRecentActivity) {
            this.clearRequestScope(requestId);
          }
        }
      },
      5 * 60 * 1000
    ); // Check every 5 minutes

    // Unref the interval so it doesn't keep the process alive during testing
    this.cleanupInterval.unref();
  }

  // Cleanup and destroy the container
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    // Clear all scopes
    this.requestScopes.clear();
    this.moduleScopes.clear();
    this.instances.clear();
    this.services.clear();

    this.emit('containerDestroyed');
  }

  // Internal registration method
  _registerService<T>(name: string, definition: ServiceDefinition<T>): this {
    this.services.set(name, definition);
    this.emit('serviceRegistered', { name, metadata: definition.metadata });
    return this;
  }

  // Check if service exists
  has(name: string): boolean {
    return this.services.has(name);
  }
}

// Fluent registration builder
export class ServiceRegistrationBuilder<T> {
  private metadata: Partial<ServiceMetadata> = {
    scope: ServiceScope.SINGLETON,
    tags: [],
    dependencies: [],
    optional: [],
  };
  private _factory?: ServiceFactory<T>;
  private interceptors: ServiceInterceptor[] = [];
  private decorators: ServiceDecorator<T>[] = [];

  constructor(
    private container: FunctionalContainer,
    private name: string
  ) {}

  // Scope configuration
  singleton(): this {
    this.metadata.scope = ServiceScope.SINGLETON;
    return this;
  }

  transient(): this {
    this.metadata.scope = ServiceScope.TRANSIENT;
    return this;
  }

  requestScoped(): this {
    this.metadata.scope = ServiceScope.REQUEST;
    return this;
  }

  moduleScoped(): this {
    this.metadata.scope = ServiceScope.MODULE;
    return this;
  }

  // Dependencies
  dependsOn(...deps: string[]): this {
    this.metadata.dependencies = [...(this.metadata.dependencies || []), ...deps];
    return this;
  }

  optionalDependsOn(...deps: string[]): this {
    this.metadata.optional = [...(this.metadata.optional || []), ...deps];
    return this;
  }

  // Metadata
  tags(...tags: string[]): this {
    this.metadata.tags = [...(this.metadata.tags || []), ...tags];
    return this;
  }

  // Lifecycle
  onInit(initFn: () => Promise<void> | void): this {
    this.metadata.lifecycle = { ...this.metadata.lifecycle, init: initFn };
    return this;
  }

  onDispose(disposeFn: () => Promise<void> | void): this {
    this.metadata.lifecycle = {
      ...this.metadata.lifecycle,
      dispose: disposeFn,
    };
    return this;
  }

  healthCheck(healthFn: () => Promise<boolean> | boolean): this {
    this.metadata.lifecycle = {
      ...this.metadata.lifecycle,
      healthCheck: healthFn,
    };
    return this;
  }

  fallback(fallbackFn: () => T): this {
    this.metadata.fallback = fallbackFn;
    return this;
  }

  timeout(ms: number): this {
    this.metadata.timeout = ms;
    return this;
  }

  // Factory and composition
  factory(factory: ServiceFactory<T>): this {
    this._factory = factory;
    return this;
  }

  compose(...compositionFns: Array<(factory: ServiceFactory<T>) => ServiceFactory<T>>): this {
    if (!this._factory) {
      throw new Error('Factory must be set before composition');
    }

    this._factory = compositionFns.reduce((acc, fn) => fn(acc), this._factory);
    return this;
  }

  // Interceptors and decorators
  intercept(interceptor: ServiceInterceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  decorate(decorator: ServiceDecorator<T>): this {
    this.decorators.push(decorator);
    return this;
  }

  // Build and register
  build(): FunctionalContainer {
    if (!this._factory) {
      throw new Error(`Factory not provided for service '${this.name}'`);
    }

    const definition: ServiceDefinition<T> = {
      factory: this._factory,
      metadata: {
        name: this.name,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        scope: this.metadata.scope!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        tags: this.metadata.tags!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        dependencies: this.metadata.dependencies!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        optional: this.metadata.optional!,
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

// Standard Container class
export class Container {
  private functionalContainer = new FunctionalContainer();
  private resolutionCache = new Map<string, any>();

  register<T>(name: string, factory: () => T, singleton = false): void {
    this.functionalContainer
      .register<T>(name)
      .factory(() => factory())
      [singleton ? 'singleton' : 'transient']()
      .build();
  }

  resolve<T>(name: string): T {
    // Fast path for cached resolutions
    if (this.resolutionCache.has(name)) {
      return this.resolutionCache.get(name);
    }

    const resolved = this.functionalContainer.resolveSync<T>(name);

    // Cache result (limit cache size)
    if (this.resolutionCache.size < 50) {
      this.resolutionCache.set(name, resolved);
    }

    return resolved;
  }

  has(name: string): boolean {
    return this.functionalContainer.has(name);
  }

  // Expose enhanced container for migration
  getEnhanced(): FunctionalContainer {
    return this.functionalContainer;
  }
}
