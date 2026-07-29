// Prometheus Middleware - Centralized Exports
export { PrometheusCore } from './core.js';
export type { PrometheusOptions } from './core.js';
export { createPrometheusMiddleware } from './middleware.js';

import { createPrometheusMiddleware } from './middleware.js';

export const prometheus = createPrometheusMiddleware;
