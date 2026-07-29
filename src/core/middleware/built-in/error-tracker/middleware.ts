// Error Tracker Middleware
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('ErrorTracker');

/**
 * Error tracking middleware
 * Captures and logs errors that occur during request processing.
 * Errors are logged and re-thrown so the framework's error handling
 * (registered error handler / default 500) still applies.
 *
 * The returned middleware uses the 4-arg (err, req, res, next)
 * error-handler shape.
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.errorTracker());
 * ```
 */
export function createErrorTrackerMiddleware() {
  return (err: Error, req: HttpRequest, _res: HttpResponse, next: (err?: Error) => void): void => {
    logger.error('Request error', 'ErrorTracking', {
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method,
      timestamp: new Date().toISOString(),
    });
    // Pass the error along so downstream error handling still runs
    next(err);
  };
}
