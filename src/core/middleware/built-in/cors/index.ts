// CORS - Main entry point
// Re-exports all public APIs for the CORS built-in

// Core (for direct use by router and custom implementations)
export { CORSCore, type CORSOptions } from './core.js';

// Middleware (for middleware chains)
export { createCORSMiddleware } from './middleware.js';

// Hook (for global registration)
export { cors as corsHook } from './hook.js';

// Default export for framework use
import { createCORSMiddleware } from './middleware.js';

export const cors = createCORSMiddleware;
