// Performance Monitor Middleware
import { createFrameworkLogger } from '../../../logger/index.js';

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
export const performanceMonitor = async (context: any): Promise<void> => {
  const startTime = Date.now();

  context.onComplete = () => {
    const duration = Date.now() - startTime;

    // Log slow requests
    if (duration > 1000) {
      logger.warn(
        `Slow request detected: ${context.request?.path} took ${duration}ms`,
        'SlowRequest',
        {
          path: context.request?.path,
          method: context.request?.method,
          duration,
        }
      );
    }
  };
};
