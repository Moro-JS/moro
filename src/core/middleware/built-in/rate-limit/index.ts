// Rate Limit - Main entry point
// Re-exports all public APIs for the rate limit built-in

// Core (for direct use by router and custom implementations)
export { RateLimitCore, sharedRateLimitCore, type RateLimitConfig } from './core.js';

// Middleware (for middleware chains)
export { createRateLimitMiddleware } from './middleware.js';

// Hook (for global registration)
export { rateLimit } from './hook.js';
