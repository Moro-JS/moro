// CDN - Main entry point
// Re-exports all public APIs for the CDN built-in

// Core (for direct use by router and custom implementations)
export { CDNCore } from './core.js';

// Middleware (for middleware chains)
export { createCDNMiddleware } from './middleware.js';

// Hook (for global registration)
export { cdn } from './hook.js';

// Re-export adapters for convenience
export {
  CloudflareCDNAdapter,
  CloudFrontCDNAdapter,
  AzureCDNAdapter,
  createCDNAdapter,
} from '../cdn/adapters/cdn/index.js';

// Re-export types from shared types
export type { CDNAdapter, CDNOptions, CDNStats } from '../../../../types/cdn.js';
