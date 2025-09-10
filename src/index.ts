// MoroJS Framework - Main Entry Point
export {
  Moro,
  Moro as MoroCore,
  createApp,
  createAppNode,
  createAppEdge,
  createAppLambda,
  createAppWorker,
} from './moro';

export type { MoroOptions } from './core/framework';

// Runtime system exports
export type {
  RuntimeType,
  RuntimeAdapter,
  RuntimeConfig,
  RuntimeHttpResponse,
} from './types/runtime';

export {
  NodeRuntimeAdapter,
  VercelEdgeAdapter,
  AWSLambdaAdapter,
  CloudflareWorkersAdapter,
  createRuntimeAdapter,
  createNodeHandler,
  createEdgeHandler,
  createLambdaHandler,
  createWorkerHandler,
} from './core/runtime';

// Runtime-specific types
export type { LambdaEvent, LambdaContext, LambdaResponse } from './core/runtime/aws-lambda-adapter';
export type { WorkersEnv, WorkersContext } from './core/runtime/cloudflare-workers-adapter';

// Core exports
export { MoroHttpServer, middleware as httpMiddleware } from './core/http';
export { builtInMiddleware, simpleMiddleware } from './core/middleware/built-in';

// Networking System
export {
  WebSocketManager,
  ServiceRegistry,
  ServiceInfo,
  ServiceDiscoveryOptions,
} from './core/networking';

// Utilities and Container System
export {
  Container,
  FunctionalContainer,
  ServiceScope,
  ServiceLifecycle,
  withLogging,
  withCaching,
  withRetry,
  withTimeout,
  CircuitBreaker,
  HookManager,
  HOOK_EVENTS,
  middleware,
} from './core/utilities';

// Event System
export { MoroEventBus } from './core/events';
export type {
  EventContext,
  EventPayload,
  EventBusOptions,
  ModuleEventBus,
  GlobalEventBus,
  EventMetrics,
  SystemEvents,
  EventHandler,
} from './types/events';

// Logger System
export { createFrameworkLogger, logger } from './core/logger';

// Validation System (Zod-based)
export { validate, body, query, params, combineSchemas, z } from './core/validation';
export type {
  ValidationConfig,
  ValidationResult,
  ValidationError,
  ValidatedRequest,
} from './core/validation';

// Module System
export {
  defineModule,
  ModuleLoader,
  ModuleDiscovery,
  autoDiscoverModuleDirectories,
} from './core/modules';
export type { ModuleDefinition, ModuleRoute, ModuleSocket, ModuleConfig } from './types/module';

// Intelligent Routing System
export { createRoute, defineRoute, EXECUTION_PHASES } from './core/routing';
export { IntelligentRoutingManager, RouteRegistry } from './core/routing/app-integration';
export type {
  RouteBuilder,
  RouteSchema,
  CompiledRoute,
  HttpMethod,
  AuthConfig,
  RateLimitConfig,
  CacheConfig,
  MiddlewarePhases,
  ExecutionPhase,
} from './core/routing';

// Documentation System
export {
  DocumentationSystem,
  AppDocumentationManager,
  createDocumentationSystem,
  generateDocsFromIntelligentRoutes,
} from './core/docs';
export type { DocsConfig } from './core/docs';

// Configuration utilities
export {
  getConfig,
  createModuleConfig,
  getEnvVar,
  getEnvArray,
  getEnvJson,
  isDevelopment,
  isProduction,
  isStaging,
  requireEnvVars,
  envVar,
  getConfigValue,
} from './core/config/utils';

export { initializeConfig, getGlobalConfig, isConfigInitialized } from './core/config';

// Middleware System
export { MiddlewareManager } from './core/middleware';
export type { MiddlewareInterface, MoroMiddleware } from './core/middleware';

// Types
export type * from './types/core';
export type * from './types/http';
export type * from './types/hooks';
export type * from './types/cache';
export type * from './types/cdn';
export type * from './types/database';
export type * from './types/logger';
export type * from './types/session';
export type * from './types/discovery';

// Adapters
export * from './core/middleware/built-in/adapters';
export * from './core/database/adapters';

// Re-export commonly used types for convenience
export type { CacheAdapter, CacheOptions, CacheStrategy } from './types/cache';
export type { CDNAdapter, CDNOptions } from './types/cdn';
export type { DatabaseAdapter, DatabaseTransaction, DatabaseConfig } from './types/database';
export type { CookieOptions } from './types/http';
