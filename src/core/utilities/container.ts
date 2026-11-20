// Enhanced Functional Dependency Injection Container
import { EventEmitter } from 'events';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('Container');

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
// Interceptor can return either a wrapped factory or call next(). Which of the
// two an interceptor is, is read from what it does (see applyInterceptors).
export type ServiceInterceptor =
  // Pattern 1: Return a wrapped factory (as shown in docs)
  | ((
      serviceName: string,
      factory: () => any | Promise<any>,
      dependencies: Record<string, any>,
      context: ServiceContext
    ) => () => any | Promise<any>)
  // Pattern 2: Use next() callback pattern (middleware-style)
  | ((
      serviceName: string,
      dependencies: Record<string, any>,
      context: ServiceContext,
      next: () => any | Promise<any>
    ) => any | Promise<any>);

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

// How a service came to be asked for while another one was being created
const EDGE_EXPLICIT = 0; // a resolve() call made by a factory, interceptor, decorator or init hook
const EDGE_REQUIRED = 1; // listed in dependsOn()
const EDGE_OPTIONAL = 2; // listed in optionalDependsOn()
type DependencyEdge = typeof EDGE_EXPLICIT | typeof EDGE_REQUIRED | typeof EDGE_OPTIONAL;

// One creation in progress. `parent` is the creation that asked for it, so the
// chain of parents is the path of services being built on top of each other.
interface PendingCreation {
  name: string;
  scopeKey: string;
  parent: PendingCreation | undefined;
  edge: DependencyEdge;
  // A failure of this creation does not reach its parent: fallback() replaces it
  recovers: boolean;
  // Listed in its scope, where concurrent first callers find it
  listed: boolean;
  next: PendingCreation | undefined;
  // The creation this one is waiting on for a declared dependency
  waitingFor: PendingCreation | undefined;
  // Concurrent first callers of the same scoped instance
  waiters: PendingWaiter[] | undefined;
}

interface PendingWaiter {
  resolve: (instance: ServiceInstance) => void;
  reject: (error: unknown) => void;
}

// The instances of one scope (the container, one request, one module) and the
// creations of singleton, request- and module-scoped instances that have not
// stored theirs yet. Concurrent first callers wait on the listed creation
// instead of running the factory again.
class ScopeInstances extends Map<string, ServiceInstance> {
  pending: PendingCreation | undefined = undefined;
}

// Calling convention of each interceptor seen so far: true when it takes
// (name, factory, deps, context) and returns a factory, false when it takes
// (name, deps, context, next) and returns the instance.
const interceptorWrapsFactory = new WeakMap<ServiceInterceptor, boolean>();

// Upper bound on the entries one withCaching() factory keeps
const WITH_CACHING_MAX_ENTRIES = 1000;

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
    const cache = new Map<string, { value: T; expires: number; used: boolean }>();
    return async (deps, ctx) => {
      // Use stable key without JSON.stringify
      const depsKeys = Object.keys(deps).sort();
      const key = `${ctx?.requestId || 'global'}_${depsKeys.join('_')}`;
      const cached = cache.get(key);
      if (cached) {
        if (cached.expires > Date.now()) {
          cached.used = true;
          return cached.value;
        }
        cache.delete(key);
      }
      const result = await factory(deps, ctx);
      const now = Date.now();
      // Re-insert rather than overwrite, so the map stays ordered oldest first
      cache.delete(key);
      cache.set(key, { value: result, expires: now + ttl, used: false });
      // Every entry has the same ttl, so the oldest entries are the ones that
      // expire first: drop the expired ones from the front, then hold the map
      // to its bound. An entry read since it was stored is moved to the back
      // once instead of being dropped.
      for (const [oldestKey, oldest] of cache) {
        if (oldest.expires <= now) {
          cache.delete(oldestKey);
        } else if (cache.size <= WITH_CACHING_MAX_ENTRIES) {
          break;
        } else {
          cache.delete(oldestKey);
          if (oldest.used) {
            oldest.used = false;
            cache.set(oldestKey, oldest);
          }
        }
      }
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
    const creation = factory(deps, ctx);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Service creation timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([creation, timeout]);
    } finally {
      // The factory settled (or the timeout fired): nothing is left to time
      clearTimeout(timer);
    }
  };

// Typed service reference - holds the service name and type information
export class TypedServiceReference<T> {
  constructor(
    private container: FunctionalContainer,
    private serviceName: string
  ) {}

  // Resolve the service with full type safety
  async resolve(contextOrOptions?: ServiceContext | { context?: ServiceContext }): Promise<T> {
    return this.container.resolve<T>(this.serviceName, contextOrOptions);
  }

  // Synchronous resolution
  resolveSync(contextOrOptions?: ServiceContext | { context?: ServiceContext }): T {
    return this.container.resolveSync<T>(this.serviceName, contextOrOptions);
  }

  // Get the service name
  getName(): string {
    return this.serviceName;
  }
}

// Enhanced Functional Container
export class FunctionalContainer extends EventEmitter {
  private services = new Map<string, ServiceDefinition>();
  private instances = new ScopeInstances();
  private requestScopes = new Map<string, ScopeInstances>();
  private moduleScopes = new Map<string, ScopeInstances>();
  private globalInterceptors: ServiceInterceptor[] = [];
  private cleanupInterval?: NodeJS.Timeout | undefined;

  // The creation whose dependencies or own code (factory, interceptors,
  // decorators, init hook) are running synchronously right now, and how the
  // next resolve call relates to it. Set only for the duration of such a call.
  private activeCreation: PendingCreation | undefined = undefined;
  private activeEdge: DependencyEdge = EDGE_EXPLICIT;
  // What has been warned about once: request-scoped services resolved without
  // a request id, and dependency cycles that are left to run
  private warnedSharedRequestScope = new Set<string>();
  private warnedCycles = new Set<string>();
  // Changes whenever a name is registered again or the container is destroyed
  private registrationEpoch = 0;

  /**
   * @internal Called when stored instances stop being current: with a name
   * when that name is registered again, without one after dispose() and
   * destroy(). Container uses it to drop what it has cached.
   */
  _onInstancesDropped: ((name?: string) => void) | undefined = undefined;

  /** @internal The scope a name is registered with; undefined when it is not registered. */
  _scopeOf(name: string): ServiceScope | undefined {
    return this.services.get(name)?.metadata.scope;
  }

  constructor() {
    super();
    this.setupCleanup();
  }

  // Fluent registration API - returns a builder that captures the type
  register<T = any>(name: string): ServiceRegistrationBuilder<T> {
    return new ServiceRegistrationBuilder<T>(this, name);
  }

  // Direct registration for simple cases
  singleton<T>(name: string, factory: ServiceFactory<T>): TypedServiceReference<T> {
    this.register<T>(name).singleton().factory(factory).build();
    return new TypedServiceReference<T>(this, name);
  }

  transient<T>(name: string, factory: ServiceFactory<T>): TypedServiceReference<T> {
    this.register<T>(name).transient().factory(factory).build();
    return new TypedServiceReference<T>(this, name);
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
  async resolve<T = any>(
    name: string,
    optionsOrContext?: ServiceContext | { context?: ServiceContext }
  ): Promise<T> {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service '${name}' not registered`);
    }

    // Support both direct context and options object with context
    const context: ServiceContext | undefined =
      optionsOrContext && typeof optionsOrContext === 'object' && 'context' in optionsOrContext
        ? optionsOrContext.context
        : (optionsOrContext as ServiceContext | undefined);

    const scopeKey = this.getScopeKey(name, service.metadata.scope, context);
    const instanceMap = this.getInstanceMap(service.metadata.scope, context);

    let instance = instanceMap.get(scopeKey);

    if (!instance || this.shouldRecreate(instance, service.metadata)) {
      instance = await this.acquireInstance(name, service, context, instanceMap, scopeKey);
    }

    instance.lastAccessed = Date.now();
    instance.accessCount++;

    return instance.value;
  }

  // Synchronous resolution for non-async services
  resolveSync<T = any>(
    name: string,
    optionsOrContext?: ServiceContext | { context?: ServiceContext }
  ): T {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service '${name}' not registered`);
    }

    // Support both direct context and options object with context
    const context: ServiceContext | undefined =
      optionsOrContext && typeof optionsOrContext === 'object' && 'context' in optionsOrContext
        ? optionsOrContext.context
        : (optionsOrContext as ServiceContext | undefined);

    const scopeKey = this.getScopeKey(name, service.metadata.scope, context);
    const instanceMap = this.getInstanceMap(service.metadata.scope, context);

    let instance = instanceMap.get(scopeKey);

    if (!instance || this.shouldRecreate(instance, service.metadata)) {
      if (service.metadata.scope === ServiceScope.REQUEST && !context?.requestId) {
        this.warnSharedRequestScope(name);
      }
      const result = this.createInstanceSync(name, service, context);
      instance =
        context !== undefined
          ? {
              value: result,
              metadata: service.metadata,
              lifecycle: ServiceLifecycle.INITIALIZED,
              lastAccessed: Date.now(),
              accessCount: 1,
              context,
            }
          : {
              value: result,
              metadata: service.metadata,
              lifecycle: ServiceLifecycle.INITIALIZED,
              lastAccessed: Date.now(),
              accessCount: 1,
            };
      instanceMap.set(scopeKey, instance);
    }

    instance.lastAccessed = Date.now();
    instance.accessCount++;

    return instance.value;
  }

  // Resolve all services with a specific tag
  async resolveByTag(tag: string): Promise<any[]> {
    const services: any[] = [];

    for (const [name, service] of this.services) {
      if (service.metadata.tags?.includes(tag)) {
        const resolved = await this.resolve(name);
        services.push(resolved);
      }
    }

    return services;
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
    this._onInstancesDropped?.();
  }

  // Internal implementation methods

  // Get the instance for a scope key that has none stored: wait for the
  // creation another caller already started, or start one.
  private acquireInstance<T>(
    name: string,
    service: ServiceDefinition<T>,
    context: ServiceContext | undefined,
    instanceMap: ScopeInstances,
    scopeKey: string
  ): Promise<ServiceInstance<T>> {
    const metadata = service.metadata;
    const requester = this.activeCreation;
    const edge = requester !== undefined ? this.activeEdge : EDGE_EXPLICIT;
    const hasDependencies = metadata.dependencies.length > 0 || metadata.optional.length > 0;

    if (requester !== undefined && edge !== EDGE_EXPLICIT && hasDependencies) {
      this.checkDependencyCycle(name, requester, edge);
    }
    if (metadata.scope === ServiceScope.REQUEST && !context?.requestId) {
      this.warnSharedRequestScope(name);
    }

    const shared = metadata.scope !== ServiceScope.TRANSIENT;
    if (!shared && !hasDependencies) {
      // Nothing can wait on it and it cannot be part of a cycle: no bookkeeping
      return this.createInstance(name, service, context, instanceMap, scopeKey, undefined);
    }

    let listed = shared;
    if (shared) {
      let pending = instanceMap.pending;
      while (pending !== undefined && pending.scopeKey !== scopeKey) pending = pending.next;
      if (pending !== undefined) {
        if (this.canWaitFor(pending, requester)) {
          if (requester !== undefined && edge !== EDGE_EXPLICIT) {
            requester.waitingFor = pending;
          }
          const waiters = (pending.waiters ??= []);
          return new Promise<ServiceInstance<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        }
        // The creation in progress is the one asking (a service resolving
        // itself while it is being built) or already waits on the one asking:
        // waiting for it would never end, so build separately.
        listed = false;
      }
    }

    const creation: PendingCreation = {
      name,
      scopeKey,
      parent: requester,
      edge,
      recovers: metadata.fallback !== undefined,
      listed,
      next: listed ? instanceMap.pending : undefined,
      waitingFor: undefined,
      waiters: undefined,
    };
    if (listed) {
      instanceMap.pending = creation;
    }
    if (requester !== undefined && edge !== EDGE_EXPLICIT) {
      requester.waitingFor = creation;
    }
    return this.createInstance(name, service, context, instanceMap, scopeKey, creation);
  }

  // Whether `requester` can wait for `pending` to finish. It cannot when
  // `pending` is one of the creations `requester` is nested in, or is itself
  // waiting (through declared dependencies) on one of them.
  private canWaitFor(pending: PendingCreation, requester: PendingCreation | undefined): boolean {
    if (requester === undefined) return true;
    for (let waited: PendingCreation | undefined = pending; waited; waited = waited.waitingFor) {
      for (let nested: PendingCreation | undefined = requester; nested; nested = nested.parent) {
        if (nested === waited) return false;
      }
    }
    return true;
  }

  // Release the callers waiting on a creation and take it off its scope's list
  private settleCreation(
    creation: PendingCreation,
    instanceMap: ScopeInstances,
    failed: boolean,
    outcome: unknown
  ): void {
    if (creation.listed) {
      this.unlistCreation(creation, instanceMap);
    }
    const waiters = creation.waiters;
    if (waiters === undefined) return;
    creation.waiters = undefined;
    for (const waiter of waiters) {
      if (failed) waiter.reject(outcome);
      else waiter.resolve(outcome as ServiceInstance);
    }
  }

  private unlistCreation(creation: PendingCreation, instanceMap: ScopeInstances): void {
    creation.listed = false;
    if (instanceMap.pending === creation) {
      instanceMap.pending = creation.next;
    } else {
      for (let pending = instanceMap.pending; pending !== undefined; pending = pending.next) {
        if (pending.next === creation) {
          pending.next = creation.next;
          break;
        }
      }
    }
    creation.next = undefined;
  }

  // `requester` is about to resolve `name` as a declared dependency. When
  // `name` is already being created further up the same chain of declared
  // dependencies, the chain can never complete.
  private checkDependencyCycle(
    name: string,
    requester: PendingCreation,
    edge: DependencyEdge
  ): void {
    // A cycle that passes through an optional dependency, or through a
    // service with a fallback (async resolution), does not end in an error
    let recovers = edge === EDGE_OPTIONAL;
    let start: PendingCreation | undefined = requester;
    for (; start; start = start.parent) {
      if (start.recovers) recovers = true;
      if (start.name === name) break;
      if (start.edge === EDGE_EXPLICIT) return;
      if (start.edge === EDGE_OPTIONAL) recovers = true;
    }
    if (start === undefined) return;

    // The services from `name` down to the one asking for it again
    const members: string[] = [];
    for (
      let creation = requester;
      creation !== start;
      creation = creation.parent as PendingCreation
    ) {
      members.push(creation.name);
    }
    members.push(name);
    members.reverse();
    const cycle = `${members.join(' -> ')} -> ${name}`;
    if (!recovers) {
      throw new Error(`Circular dependency detected: ${cycle}`);
    }

    const key = members.sort().join(' ');
    if (this.warnedCycles.has(key)) return;
    this.warnedCycles.add(key);
    logger.warn(
      `Services depend on each other in a cycle (${cycle}) that passes through an optional ` +
        `dependency or a service with a fallback. Resolving it constructs each service ` +
        `repeatedly until the call stack runs out. Remove one of the dependencies to break ` +
        `the cycle.`,
      'Container'
    );
  }

  private warnSharedRequestScope(name: string): void {
    if (this.warnedSharedRequestScope.has(name)) return;
    this.warnedSharedRequestScope.add(name);
    logger.warn(
      `Request-scoped service '${name}' was resolved without a request id in its context, ` +
        `so the instance is shared by every caller that omits one. Pass ` +
        `{ context: { requestId, ... } } to resolve() to get one instance per request.`,
      'Container'
    );
  }

  // Run a factory, interceptor, decorator or init hook of `creation`: resolve
  // calls it makes before its first await are known to come from `creation`.
  private runFor<R>(creation: PendingCreation | undefined, fn: () => R): R {
    if (creation === undefined) return fn();
    const outerCreation = this.activeCreation;
    const outerEdge = this.activeEdge;
    this.activeCreation = creation;
    this.activeEdge = EDGE_EXPLICIT;
    try {
      return fn();
    } finally {
      this.activeCreation = outerCreation;
      this.activeEdge = outerEdge;
    }
  }

  private async createInstance<T>(
    name: string,
    service: ServiceDefinition<T>,
    context: ServiceContext | undefined,
    instanceMap: ScopeInstances,
    scopeKey: string,
    creation: PendingCreation | undefined
  ): Promise<ServiceInstance<T>> {
    // Code of this service runs on behalf of its own creation, or, when it
    // has none, of the creation that asked for it
    const owner = creation ?? this.activeCreation;
    const epoch = this.registrationEpoch;
    const instance: ServiceInstance<T> =
      context !== undefined
        ? {
            value: undefined as any,
            metadata: service.metadata,
            lifecycle: ServiceLifecycle.INITIALIZING,
            lastAccessed: Date.now(),
            accessCount: 0,
            context,
          }
        : {
            value: undefined as any,
            metadata: service.metadata,
            lifecycle: ServiceLifecycle.INITIALIZING,
            lastAccessed: Date.now(),
            accessCount: 0,
          };

    try {
      // Resolve dependencies
      const dependencies = await this.resolveDependencies(service.metadata, context, creation);

      // Apply interceptors (global + service-specific) and create the instance
      // by calling the intercepted factory (no params needed, already bound).
      // Resolve calls made by that code before its first await come from `owner`.
      let created: any;
      if (owner === undefined) {
        created = this.applyInterceptors(
          name,
          service.factory,
          service.interceptors || [],
          dependencies,
          context
        )();
      } else {
        const outerCreation = this.activeCreation;
        const outerEdge = this.activeEdge;
        this.activeCreation = owner;
        this.activeEdge = EDGE_EXPLICIT;
        try {
          created = this.applyInterceptors(
            name,
            service.factory,
            service.interceptors || [],
            dependencies,
            context
          )();
        } finally {
          this.activeCreation = outerCreation;
          this.activeEdge = outerEdge;
        }
      }
      instance.value = await created;

      // Apply decorators
      instance.value = await this.applyDecorators(
        instance.value,
        service.decorators,
        context,
        owner
      );

      // Mark as initialized and store in map BEFORE running lifecycle hooks
      // This prevents infinite loops when init callbacks resolve the same service
      instance.lifecycle = ServiceLifecycle.INITIALIZED;

      // A name registered again while this was being built keeps its new
      // registration: only the caller that asked for this instance gets it
      if (epoch === this.registrationEpoch || this.services.get(name) === service) {
        instanceMap.set(scopeKey, instance);
      }
      // The instance is available from here on, as it is to any later caller
      if (creation !== undefined) {
        this.settleCreation(creation, instanceMap, false, instance);
      }

      // Run initialization lifecycle
      const lifecycle = service.metadata.lifecycle;
      if (lifecycle?.init) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await this.runFor(owner, () => lifecycle.init!());
      }

      this.emit('serviceCreated', { name, instance });
    } catch (error) {
      instance.lifecycle = ServiceLifecycle.ERROR;
      try {
        this.emit('serviceError', { name, error });

        // Try fallback if available
        if (service.metadata.fallback) {
          instance.value = service.metadata.fallback();
          instance.lifecycle = ServiceLifecycle.INITIALIZED;
        } else {
          throw error;
        }
      } catch (failure) {
        // Not stored: the next resolve runs the factory again
        if (creation !== undefined) {
          this.settleCreation(creation, instanceMap, true, failure);
        }
        throw failure;
      }
      if (creation !== undefined) {
        this.settleCreation(creation, instanceMap, false, instance);
      }
    }

    return instance;
  }

  private createInstanceSync<T>(
    name: string,
    service: ServiceDefinition<T>,
    context?: ServiceContext
  ): T {
    const metadata = service.metadata;
    const requester = this.activeCreation;
    const outerEdge = this.activeEdge;
    let owner = requester;

    if (metadata.dependencies.length > 0 || metadata.optional.length > 0) {
      const edge = requester !== undefined ? outerEdge : EDGE_EXPLICIT;
      if (requester !== undefined && edge !== EDGE_EXPLICIT) {
        this.checkDependencyCycle(name, requester, edge);
      }
      // Synchronous creation has no fallback and nothing waits on it
      owner = {
        name,
        scopeKey: name,
        parent: requester,
        edge,
        recovers: false,
        listed: false,
        next: undefined,
        waitingFor: undefined,
        waiters: undefined,
      };
    }

    try {
      // Resolve dependencies synchronously
      const dependencies = this.resolveDependenciesSync(metadata, context, owner);

      // Code of this service runs on behalf of its own creation, or, when it
      // has none, of the creation that asked for it
      this.activeCreation = owner;
      this.activeEdge = EDGE_EXPLICIT;

      // Apply interceptors (global + service-specific)
      const interceptedFactory = this.applyInterceptors(
        name,
        service.factory,
        service.interceptors || [],
        dependencies,
        context
      );

      // Create instance (note: interceptors must be sync or this will fail)
      let instance = interceptedFactory() as T;

      // Apply decorators synchronously
      for (const decorator of service.decorators) {
        const result = decorator(instance, context || this.createDefaultContext());
        // If decorator returns a promise, we can't handle it in sync mode
        if (result && typeof (result as any).then === 'function') {
          throw new Error(
            `Cannot use async decorator with synchronous resolution for service '${name}'`
          );
        }
        instance = result as T;
      }

      return instance;
    } finally {
      this.activeCreation = requester;
      this.activeEdge = outerEdge;
    }
  }

  // Resolve one declared dependency of `creation`
  private requestDependency(
    creation: PendingCreation | undefined,
    edge: DependencyEdge,
    name: string,
    context: ServiceContext | undefined
  ): Promise<any> {
    const outerCreation = this.activeCreation;
    const outerEdge = this.activeEdge;
    if (creation !== undefined) creation.waitingFor = undefined;
    this.activeCreation = creation;
    this.activeEdge = edge;
    try {
      return this.resolve(name, context);
    } finally {
      this.activeCreation = outerCreation;
      this.activeEdge = outerEdge;
    }
  }

  private async resolveDependencies(
    metadata: ServiceMetadata,
    context: ServiceContext | undefined,
    creation: PendingCreation | undefined
  ): Promise<Record<string, any>> {
    const dependencies: Record<string, any> = {};

    for (const dep of metadata.dependencies) {
      dependencies[dep] = await this.requestDependency(creation, EDGE_REQUIRED, dep, context);
    }

    for (const optDep of metadata.optional) {
      try {
        dependencies[optDep] = await this.requestDependency(
          creation,
          EDGE_OPTIONAL,
          optDep,
          context
        );
      } catch {
        // Optional dependency - continue without it
      }
    }

    // No longer waiting on any of them
    if (creation !== undefined) creation.waitingFor = undefined;

    return dependencies;
  }

  private resolveDependenciesSync(
    metadata: ServiceMetadata,
    context: ServiceContext | undefined,
    creation: PendingCreation | undefined
  ): Record<string, any> {
    const dependencies: Record<string, any> = {};

    for (const dep of metadata.dependencies) {
      this.activeCreation = creation;
      this.activeEdge = EDGE_REQUIRED;
      dependencies[dep] = this.resolveSync(dep, context);
    }

    for (const optDep of metadata.optional) {
      try {
        this.activeCreation = creation;
        this.activeEdge = EDGE_OPTIONAL;
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
    serviceInterceptors: ServiceInterceptor[],
    dependencies: Record<string, any>,
    context?: ServiceContext
  ): () => any | Promise<any> {
    // Create a parameterless factory by binding deps and context
    const boundFactory = () => factory(dependencies, context);
    if (this.globalInterceptors.length === 0 && serviceInterceptors.length === 0) {
      return boundFactory;
    }

    // Combine global interceptors with service-specific interceptors
    const allInterceptors = [...this.globalInterceptors, ...serviceInterceptors];

    // Apply interceptors in order, each wrapping the previous factory
    return allInterceptors.reduce((wrappedFactory: () => any, interceptor: ServiceInterceptor) => {
      const wrapsFactory = interceptorWrapsFactory.get(interceptor);

      if (wrapsFactory === true) {
        // Pattern 1: (name, factory, deps, context) => wrappedFactory
        return (interceptor as any)(
          name,
          wrappedFactory,
          dependencies,
          context || this.createDefaultContext()
        );
      } else if (wrapsFactory === false) {
        // Pattern 2: (name, deps, context, next) => result (middleware-style)
        return () =>
          (interceptor as any)(
            name,
            dependencies,
            context || this.createDefaultContext(),
            wrappedFactory
          );
      }
      // Not seen before: find out which pattern it follows when it runs
      return () =>
        this.runUnclassifiedInterceptor(
          interceptor,
          name,
          wrappedFactory,
          dependencies,
          context || this.createDefaultContext()
        );
    }, boundFactory);
  }

  // Both patterns take four arguments, so which one an interceptor follows is
  // read from what it does, never from how its parameters are named. It is
  // called as pattern 2 first, the only order in which a pattern 2 interceptor
  // (which does its work during the call) runs once and with the right
  // arguments:
  // - it calls next(), or returns something that is not a function: pattern 2;
  // - it returns a function (or its second argument unchanged) without
  //   calling next(), or throws before calling it: it took the arguments for
  //   (name, factory, deps, context), so it is called again that way and the
  //   function it returns is the factory.
  private runUnclassifiedInterceptor(
    interceptor: ServiceInterceptor,
    name: string,
    wrappedFactory: () => any,
    dependencies: Record<string, any>,
    context: ServiceContext
  ): any {
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
      return wrappedFactory();
    };

    let result: any;
    let threw = false;
    let failure: unknown;
    try {
      result = (interceptor as any)(name, dependencies, context, next);
    } catch (error) {
      if (nextCalled) {
        interceptorWrapsFactory.set(interceptor, false);
        throw error;
      }
      threw = true;
      failure = error;
    }

    if (nextCalled || (!threw && typeof result !== 'function' && result !== dependencies)) {
      interceptorWrapsFactory.set(interceptor, false);
      return result;
    }

    let factory: any;
    try {
      factory = (interceptor as any)(name, wrappedFactory, dependencies, context);
    } catch (error) {
      // Failed both ways: report what it threw when called as pattern 2 if it
      // did, since that call had not been ruled out
      throw threw ? failure : error;
    }
    if (typeof factory !== 'function') {
      // Not a factory wrapper after all
      if (threw) throw failure;
      interceptorWrapsFactory.set(interceptor, false);
      return result;
    }
    interceptorWrapsFactory.set(interceptor, true);
    return factory();
  }

  private async applyDecorators<T>(
    instance: T,
    decorators: ServiceDecorator<T>[],
    context: ServiceContext | undefined,
    owner: PendingCreation | undefined
  ): Promise<T> {
    let result = instance;
    for (const decorator of decorators) {
      const current = result;
      result = await this.runFor(owner, () =>
        decorator(current, context || this.createDefaultContext())
      );
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

  private getInstanceMap(scope: ServiceScope, context?: ServiceContext): ScopeInstances {
    switch (scope) {
      case ServiceScope.REQUEST: {
        const requestId = context?.requestId || 'default-request';
        let requestScope = this.requestScopes.get(requestId);
        if (requestScope === undefined) {
          requestScope = new ScopeInstances();
          this.requestScopes.set(requestId, requestScope);
        }
        return requestScope;
      }

      case ServiceScope.MODULE: {
        const moduleId = context?.moduleId || 'default-module';
        let moduleScope = this.moduleScopes.get(moduleId);
        if (moduleScope === undefined) {
          moduleScope = new ScopeInstances();
          this.moduleScopes.set(moduleId, moduleScope);
        }
        return moduleScope;
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
    this.registrationEpoch++;
    this._onInstancesDropped?.();

    this.emit('containerDestroyed');
  }

  // Internal registration method
  _registerService<T>(name: string, definition: ServiceDefinition<T>): this {
    const previous = this.services.get(name);
    this.services.set(name, definition);
    if (previous !== undefined) {
      // Registered again: what the previous registration built is no longer
      // what this name resolves to
      this.registrationEpoch++;
      this.dropInstances(name, previous.metadata.scope);
    }
    this.emit('serviceRegistered', { name, metadata: definition.metadata });
    return this;
  }

  private dropInstances(name: string, scope: ServiceScope): void {
    if (scope === ServiceScope.REQUEST || scope === ServiceScope.MODULE) {
      const scopes = scope === ServiceScope.REQUEST ? this.requestScopes : this.moduleScopes;
      for (const [scopeId, instances] of scopes) {
        this.dropInstance(instances, `${name}:${scopeId}`);
      }
    } else {
      this.dropInstance(this.instances, name);
    }
    this._onInstancesDropped?.(name);
  }

  private dropInstance(instances: ScopeInstances, scopeKey: string): void {
    instances.delete(scopeKey);
    // A creation still in progress belongs to the previous registration: later
    // callers must not wait on it
    for (let pending = instances.pending; pending !== undefined; pending = pending.next) {
      if (pending.scopeKey === scopeKey) {
        this.unlistCreation(pending, instances);
        break;
      }
    }
  }

  // Check if service exists
  has(name: string): boolean {
    return this.services.has(name);
  }
}

// Fluent registration builder with type safety
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

  // Alias for intercept() to match documentation
  interceptor(interceptor: ServiceInterceptor): this {
    return this.intercept(interceptor);
  }

  decorate(decorator: ServiceDecorator<T>): this {
    this.decorators.push(decorator);
    return this;
  }

  // Alias for decorate() to match documentation
  decorator(decorator: ServiceDecorator<T>): this {
    return this.decorate(decorator);
  }

  // Build and register - returns a typed reference
  build(): TypedServiceReference<T> {
    if (!this._factory) {
      throw new Error(`Factory not provided for service '${String(this.name)}'`);
    }

    const definition: ServiceDefinition<T> = {
      factory: this._factory,
      metadata: {
        name: this.name as string,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        scope: this.metadata.scope!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        tags: this.metadata.tags!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        dependencies: this.metadata.dependencies!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        optional: this.metadata.optional!,
        ...(this.metadata.lifecycle !== undefined ? { lifecycle: this.metadata.lifecycle } : {}),
        ...(this.metadata.fallback !== undefined ? { fallback: this.metadata.fallback } : {}),
        ...(this.metadata.timeout !== undefined ? { timeout: this.metadata.timeout } : {}),
      },
      interceptors: this.interceptors,
      decorators: this.decorators,
    };

    this.container._registerService(this.name as string, definition);
    return new TypedServiceReference<T>(this.container, this.name);
  }
}

// What Container.register() takes as its third argument in place of a boolean
export interface ContainerRegisterOptions {
  /**
   * `'singleton'` (the default): the factory runs once and every resolve
   * returns that instance. `'transient'`: the factory runs on every resolve.
   */
  lifetime?: 'singleton' | 'transient' | ServiceScope.SINGLETON | ServiceScope.TRANSIENT;
}

// Standard Container class
export class Container {
  private functionalContainer = new FunctionalContainer();
  // What resolve() returned for each name whose instance is kept (every scope
  // but transient). It holds at most one entry per registered name.
  private resolutionCache = new Map<string, any>();
  private warnedFalseLifetime = false;

  constructor() {
    // A name registered again, or instances disposed: resolve them afresh
    this.functionalContainer._onInstancesDropped = name => {
      if (name === undefined) this.resolutionCache.clear();
      else this.resolutionCache.delete(name);
    };
  }

  /**
   * Register a service. It is a singleton: the factory runs once, on the first
   * resolve, and every later resolve returns that instance. Pass
   * `{ lifetime: 'transient' }` to run the factory on every resolve instead.
   *
   * The third argument may also be the boolean of earlier versions. `true`
   * registers a singleton, and so does `false`: a boolean never makes a
   * service transient.
   */
  register<T>(
    name: string,
    factory: () => T,
    singletonOrOptions?: boolean | ContainerRegisterOptions
  ): void {
    let transient = false;
    if (typeof singletonOrOptions === 'object' && singletonOrOptions !== null) {
      const lifetime = singletonOrOptions.lifetime;
      if (lifetime === ServiceScope.TRANSIENT) {
        transient = true;
      } else if (lifetime !== undefined && lifetime !== ServiceScope.SINGLETON) {
        throw new Error(
          `Unknown lifetime '${String(lifetime)}' for service '${name}': use 'singleton' or 'transient'`
        );
      }
    } else if (singletonOrOptions === false && !this.warnedFalseLifetime) {
      this.warnedFalseLifetime = true;
      logger.warn(
        `Service '${name}' is registered with false as its third argument. It is built once ` +
          `and shared, like a service registered without that argument. Pass ` +
          `{ lifetime: 'transient' } to build a new instance on every resolve, or leave the ` +
          `argument out.`,
        'Container'
      );
    }

    this.functionalContainer
      .register<T>(name)
      .factory(() => factory())
      [transient ? 'transient' : 'singleton']()
      .build();
  }

  resolve<T>(name: string): T {
    // Fast path: a name resolved before whose instance is still the current one
    if (this.resolutionCache.has(name)) {
      return this.resolutionCache.get(name);
    }

    const resolved = this.functionalContainer.resolveSync<T>(name);

    // A transient service is built on every resolve, so it is never kept
    const scope = this.functionalContainer._scopeOf(name);
    if (scope !== undefined && scope !== ServiceScope.TRANSIENT) {
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
