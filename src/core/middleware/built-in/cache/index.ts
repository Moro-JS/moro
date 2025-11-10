// Cache - Main entry point
// Re-exports all public APIs for the cache built-in

// Core (for direct use by router and custom implementations)
export { CacheCore, sharedCacheCore, type CacheConfig } from './core.js';

// Middleware (for middleware chains)
export { createCacheMiddleware } from './middleware.js';

// Hook (for global registration with server-side + HTTP caching)
export { cache } from './hook.js';
