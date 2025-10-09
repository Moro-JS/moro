// Adapters Index
export * from './cache/index.js';
export * from './cdn/index.js';

// Re-export factory functions for convenience
export { createCacheAdapter } from './cache/index.js';
export { createCDNAdapter } from './cdn/index.js';
