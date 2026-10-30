// OpenTelemetry Middleware - Centralized Exports
export { OpenTelemetryCore, isOpenTelemetryAvailable, loadOpenTelemetryApi } from './core.js';
export type {
  OpenTelemetryOptions,
  OpenTelemetryApi,
  RequestTelemetry,
  TracerLike,
  MeterLike,
} from './core.js';
export { createOpenTelemetryMiddleware } from './middleware.js';

import { createOpenTelemetryMiddleware } from './middleware.js';

export const openTelemetry = createOpenTelemetryMiddleware;
