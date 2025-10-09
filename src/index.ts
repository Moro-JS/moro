// MoroJS Framework - Main Entry Point
export {
  Moro,
  Moro as MoroCore,
  createApp,
  createAppNode,
  createAppEdge,
  createAppLambda,
  createAppWorker,
} from './moro.js';

export type { MoroOptions } from './core/framework.js';

// Export auth types and middleware
export type {
  AuthOptions,
  AuthProvider,
  AuthUser,
  AuthSession,
  AuthRequest,
  AuthAccount,
  AuthJWT,
  AuthCallbacks,
  AuthEvents,
  AuthPages,
  AuthAdapter,
  OAuthProvider,
  CredentialsProvider,
  EmailProvider,
  SignInOptions,
  SignOutOptions,
} from './types/auth.js';

// Export native @auth/morojs adapter
export { createAuthMiddleware, MoroJSAuth } from './core/auth/morojs-adapter.js';

// Export Auth.js middleware and providers
export { auth, providers } from './core/middleware/built-in/auth.js';

// Runtime system exports
export type {
  RuntimeType,
  RuntimeAdapter,
  RuntimeConfig,
  RuntimeHttpResponse,
} from './types/runtime.js';

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
} from './core/runtime/index.js';

// Runtime-specific types
export type {
  LambdaEvent,
  LambdaContext,
  LambdaResponse,
} from './core/runtime/aws-lambda-adapter.js';
export type { WorkersEnv, WorkersContext } from './core/runtime/cloudflare-workers-adapter.js';

// Core exports
export {
  MoroHttpServer,
  UWebSocketsHttpServer,
  middleware as httpMiddleware,
} from './core/http/index.js';
export { builtInMiddleware, simpleMiddleware } from './core/middleware/built-in/index.js';

// Networking System
export { WebSocketManager, ServiceRegistry } from './core/networking/index.js';
export type { ServiceInfo, ServiceDiscoveryOptions } from './core/networking/service-discovery.js';

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
  isPackageAvailable,
  resolveUserPackage,
  createUserRequire,
} from './core/utilities/index.js';

// Event System
export { MoroEventBus } from './core/events/index.js';
export type {
  EventContext,
  EventPayload,
  EventBusOptions,
  ModuleEventBus,
  GlobalEventBus,
  EventMetrics,
  SystemEvents,
  EventHandler,
} from './types/events.js';

// Logger System
export { createFrameworkLogger, logger } from './core/logger/index.js';

// Universal Validation System
export { validate, body, query, params, combineSchemas, z } from './core/validation/index.js';

export type {
  ValidationConfig,
  ValidationResult,
  ValidationErrorDetail,
  ValidatedRequest,
} from './core/validation/index.js';

// Validation Interfaces and Adapters
export type {
  ValidationSchema,
  ValidationError,
  InferSchemaType,
} from './core/validation/schema-interface.js';
export { normalizeValidationError } from './core/validation/schema-interface.js';
export { joi, yup, fn as customValidator, classValidator } from './core/validation/adapters.js';

// Module System
export {
  defineModule,
  ModuleLoader,
  ModuleDiscovery,
  autoDiscoverModuleDirectories,
} from './core/modules/index.js';
export type { ModuleDefinition, ModuleRoute, ModuleSocket, ModuleConfig } from './types/module.js';

// WebSocket Adapter System
export type {
  WebSocketAdapter,
  WebSocketAdapterOptions,
  WebSocketNamespace,
  WebSocketConnection,
  WebSocketEmitter,
  WebSocketMiddleware,
  WebSocketEventHandler,
} from './core/networking/websocket-adapter.js';

// Built-in WebSocket Adapters
export {
  SocketIOAdapter,
  WSAdapter,
  UWebSocketsAdapter,
} from './core/networking/adapters/index.js';

// Intelligent Routing System
export { createRoute, defineRoute, EXECUTION_PHASES } from './core/routing/index.js';
export { IntelligentRoutingManager, RouteRegistry } from './core/routing/app-integration.js';
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
} from './core/routing/index.js';

// Documentation System
export {
  DocumentationSystem,
  AppDocumentationManager,
  createDocumentationSystem,
  generateDocsFromIntelligentRoutes,
} from './core/docs/index.js';
export type { DocsConfig } from './core/docs/index.js';

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
} from './core/config/utils.js';

export {
  initializeConfig,
  getGlobalConfig,
  isConfigInitialized,
  resetConfig,
} from './core/config/index.js';

// Export configuration types for TypeScript users
export type { AppConfig } from './core/config/index.js';

// Middleware System
export { MiddlewareManager } from './core/middleware/index.js';
export type { MiddlewareInterface, MoroMiddleware } from './core/middleware/index.js';

// Types
export type * from './types/core.js';
export type * from './types/http.js';
export type * from './types/hooks.js';
export type * from './types/cache.js';
export type * from './types/cdn.js';
export type * from './types/database.js';
export type * from './types/logger.js';
export type * from './types/session.js';
export type * from './types/discovery.js';

// Adapters
export * from './core/middleware/built-in/adapters/index.js';
export * from './core/database/adapters/index.js';

// Re-export commonly used types for convenience
export type { CacheAdapter, CacheOptions, CacheStrategy } from './types/cache.js';
export type { CDNAdapter, CDNOptions } from './types/cdn.js';
export type { DatabaseAdapter, DatabaseTransaction, DatabaseConfig } from './types/database.js';
export type { CookieOptions } from './types/http.js';
