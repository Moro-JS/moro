// Static File Serving Middleware - Centralized Exports
export { StaticCore } from './core.js';
export type { StaticOptions } from './core.js';
export { createStaticMiddleware } from './middleware.js';
export { registerStaticHooks } from './hook.js';

import { createStaticMiddleware } from './middleware.js';

export const staticFiles = createStaticMiddleware;
