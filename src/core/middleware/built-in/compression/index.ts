// Compression Middleware - Centralized Exports
export { CompressionCore } from './core.js';
export type { CompressionOptions } from './core.js';
export { createCompressionMiddleware } from './middleware.js';
export { registerCompressionHooks } from './hook.js';

import { createCompressionMiddleware } from './middleware.js';

export const compression = createCompressionMiddleware;
