// Request Logger Middleware
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('RequestLogger');

/**
 * Request logging middleware
 * Logs incoming requests and their completion time
 *
 * @example
 * ```ts
 * import { middleware } from '@morojs/moro';
 *
 * app.use(middleware.requestLogger());
 * ```
 */
export function createRequestLoggerMiddleware() {
  return (req: HttpRequest, res: HttpResponse, next: () => void): void => {
    const startTime = Date.now();

    logger.info(`${req.method} ${req.path}`, 'RequestLogger');

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.info(`Request completed in ${duration}ms`, 'RequestLogger');
    });

    next();
  };
}
