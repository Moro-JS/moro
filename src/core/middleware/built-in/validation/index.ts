// Validation - Main entry point
// Re-exports all public APIs for the validation built-in

// Core (for direct use by router and custom implementations)
export {
  ValidationCore,
  sharedValidationCore,
  type ValidationConfig,
  type ValidationErrorDetail,
} from './core.js';

// Middleware (for middleware chains)
export { createValidationMiddleware } from './middleware.js';

// Hook (for global registration)
export { validation } from './hook.js';
