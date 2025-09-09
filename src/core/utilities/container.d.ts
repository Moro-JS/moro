import { EventEmitter } from 'events';
export declare enum ServiceLifecycle {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  DISPOSING = 'disposing',
  DISPOSED = 'disposed',
  ERROR = 'error',
}
export declare enum ServiceScope {
  SINGLETON = 'singleton', // One instance per container
  TRANSIENT = 'transient', // New instance every time
  REQUEST = 'request', // One instance per request context
  MODULE = 'module',
}
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
export interface ServiceDefinition<T = any> {
  factory: ServiceFactory<T>;
  metadata: ServiceMetadata;
  interceptors: ServiceInterceptor[];
  decorators: ServiceDecorator<T>[];
}
export type ServiceFactory<T> = (
  dependencies: Record<string, any>,
  context?: ServiceContext
) => T | Promise<T>;
export type ServiceInterceptor = (
  serviceName: string,
  dependencies: Record<string, any>,
  context: ServiceContext,
  next: () => any
) => any | Promise<any>;
export type ServiceDecorator<T> = (instance: T, context: ServiceContext) => T | Promise<T>;
export interface ServiceContext {
  requestId?: string;
  moduleId?: string;
  metadata: Record<string, any>;
  timestamp: number;
}
export declare const withLogging: <T>(
  logger: any
) => (factory: ServiceFactory<T>) => ServiceFactory<T>;
export declare const withCaching: <T>(
  ttl?: number
) => (factory: ServiceFactory<T>) => ServiceFactory<T>;
export declare const withRetry: <T>(
  maxRetries?: number,
  delay?: number
) => (factory: ServiceFactory<T>) => ServiceFactory<T>;
export declare const withTimeout: <T>(
  timeoutMs?: number
) => (factory: ServiceFactory<T>) => ServiceFactory<T>;
export declare class FunctionalContainer extends EventEmitter {
  private services;
  private instances;
  private requestScopes;
  private moduleScopes;
  private globalInterceptors;
  private cleanupInterval?;
  constructor();
  register<T>(name: string): ServiceRegistrationBuilder<T>;
  singleton<T>(name: string, factory: ServiceFactory<T>): this;
  transient<T>(name: string, factory: ServiceFactory<T>): this;
  compose<T>(
    name: string,
    ...compositionFns: Array<(factory: ServiceFactory<T>) => ServiceFactory<T>>
  ): ServiceRegistrationBuilder<T>;
  resolve<T>(name: string, context?: ServiceContext): Promise<T>;
  resolveSync<T>(name: string, context?: ServiceContext): T;
  addInterceptor(interceptor: ServiceInterceptor): this;
  healthCheck(): Promise<Record<string, boolean>>;
  clearRequestScope(requestId: string): void;
  clearModuleScope(moduleId: string): void;
  getServiceInfo(): Record<string, any>;
  dispose(): Promise<void>;
  private createInstance;
  private createInstanceSync;
  private resolveDependencies;
  private resolveDependenciesSync;
  private applyInterceptors;
  private applyDecorators;
  private getScopeKey;
  private getInstanceMap;
  private shouldRecreate;
  private createDefaultContext;
  private setupCleanup;
  destroy(): void;
  _registerService<T>(name: string, definition: ServiceDefinition<T>): this;
  has(name: string): boolean;
}
export declare class ServiceRegistrationBuilder<T> {
  private container;
  private name;
  private metadata;
  private _factory?;
  private interceptors;
  private decorators;
  constructor(container: FunctionalContainer, name: string);
  singleton(): this;
  transient(): this;
  requestScoped(): this;
  moduleScoped(): this;
  dependsOn(...deps: string[]): this;
  optionalDependsOn(...deps: string[]): this;
  tags(...tags: string[]): this;
  onInit(initFn: () => Promise<void> | void): this;
  onDispose(disposeFn: () => Promise<void> | void): this;
  healthCheck(healthFn: () => Promise<boolean> | boolean): this;
  fallback(fallbackFn: () => T): this;
  timeout(ms: number): this;
  factory(factory: ServiceFactory<T>): this;
  compose(...compositionFns: Array<(factory: ServiceFactory<T>) => ServiceFactory<T>>): this;
  intercept(interceptor: ServiceInterceptor): this;
  decorate(decorator: ServiceDecorator<T>): this;
  build(): FunctionalContainer;
}
export declare class Container {
  private functionalContainer;
  register<T>(name: string, factory: () => T, singleton?: boolean): void;
  resolve<T>(name: string): T;
  has(name: string): boolean;
  getEnhanced(): FunctionalContainer;
}
