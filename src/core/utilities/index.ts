// Core Utilities - Centralized Exports
export {
  Container,
  FunctionalContainer,
  ServiceScope,
  ServiceLifecycle,
  withLogging,
  withCaching,
  withRetry,
  withTimeout,
} from './container.js';
export { CircuitBreaker } from './circuit-breaker.js';
export { HookManager, HOOK_EVENTS } from './hooks.js';
export { isPackageAvailable, resolveUserPackage, createUserRequire } from './package-utils.js';

// Re-export middleware from hooks
export { middleware } from './hooks.js';

// Standardized Response Helpers (namespace object only to avoid polluting global exports)
export { response, ResponseBuilder } from './response-helpers.js';

export type {
  ApiSuccessResponse,
  ApiErrorResponse,
  ApiResponse,
  ValidationErrorDetail as ResponseValidationErrorDetail,
} from './response-helpers.js';
