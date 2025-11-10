// Body Size Middleware - Centralized Exports
export { BodySizeCore } from './core.js';
export type { BodySizeOptions } from './core.js';
export { createBodySizeMiddleware } from './middleware.js';
export { registerBodySizeHooks } from './hook.js';

import { createBodySizeMiddleware } from './middleware.js';

export const bodySize = createBodySizeMiddleware;
