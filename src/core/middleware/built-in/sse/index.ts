// SSE - Main entry point
// Re-exports all public APIs for the SSE built-in

// Core (for direct use by router and custom implementations)
export {
  SSECore,
  formatSSEEvent,
  formatSSEComment,
  formatSSERetry,
  type SSEOptions,
  type SSEConnection,
} from './core.js';

// Middleware (for middleware chains)
export { createSSEMiddleware } from './middleware.js';

// Hook (for global registration)
export { sse } from './hook.js';
