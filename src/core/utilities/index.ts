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
