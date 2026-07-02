// Performance Monitor Middleware
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';

const logger = createFrameworkLogger('PerformanceMonitor');

/**
 * Performance monitoring middleware
 * Tracks request duration and logs warnings for slow requests
 *
 * @example
 * ```ts
 * import { performanceMonitor } from '@/middleware/built-in/performance-monitor';
 *
 * app.use(performanceMonitor);
 * ```
 */
export const performanceMonitor = (req: HttpRequest, res: HttpResponse, next: () => void): void => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;

    // Log slow requests
    if (duration > 1000) {
      logger.warn(`Slow request detected: ${req.path} took ${duration}ms`, 'SlowRequest', {
        path: req.path,
        method: req.method,
        duration,
      });
    }
  });

  next();
};
