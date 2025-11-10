// Template Rendering Middleware - Centralized Exports
export { TemplateCore } from './core.js';
export type { TemplateOptions } from './core.js';
export { createTemplateMiddleware } from './middleware.js';
export { registerTemplateHooks } from './hook.js';

import { createTemplateMiddleware } from './middleware.js';

export const template = createTemplateMiddleware;
