// Range Requests Middleware - Centralized Exports
export { RangeCore } from './core.js';
export type { RangeOptions } from './core.js';
export { createRangeMiddleware } from './middleware.js';
export { registerRangeHooks } from './hook.js';

import { createRangeMiddleware } from './middleware.js';

export const range = createRangeMiddleware;
