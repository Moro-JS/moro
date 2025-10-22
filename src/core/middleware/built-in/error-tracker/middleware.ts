// Error Tracker Middleware
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('ErrorTracker');

/**
 * Error tracking middleware
 * Captures and logs errors that occur during request processing
 *
 * @example
 * ```ts
 * import { errorTracker } from '@/middleware/built-in/error-tracker';
 *
 * app.use(errorTracker);
 * ```
 */
export const errorTracker = async (context: any): Promise<void> => {
  context.onError = (error: Error) => {
    logger.error('Request error', 'ErrorTracking', {
      error: error.message,
      stack: error.stack,
      url: context.request?.url,
      method: context.request?.method,
      timestamp: new Date().toISOString(),
    });
  };
};
