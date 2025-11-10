// HTTP/2 Middleware - Centralized Exports
export { Http2PushCore } from './core.js';
export type { Http2PushOptions, Http2PushResult } from './core.js';
export { createHttp2PushMiddleware } from './middleware.js';
export { registerHttp2Hooks } from './hook.js';

// Convenience exports
import { createHttp2PushMiddleware } from './middleware.js';

export const http2 = {
  push: createHttp2PushMiddleware,
};
