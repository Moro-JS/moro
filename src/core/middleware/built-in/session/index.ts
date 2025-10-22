// Session - Main entry point
// Re-exports all public APIs for the session built-in

// Core (for direct use by router and custom implementations)
export { Session, SessionCore, type SessionOptions, type SessionData } from './core.js';

// Middleware (for middleware chains)
export { createSessionMiddleware } from './middleware.js';

// Hook (for global registration)
export { session } from './hook.js';
