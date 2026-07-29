// CloudWatch Middleware - Centralized Exports
export { createCloudWatchMiddleware, buildEmfRecord } from './middleware.js';
export type { CloudWatchOptions } from './middleware.js';

import { createCloudWatchMiddleware } from './middleware.js';

export const cloudWatch = createCloudWatchMiddleware;
