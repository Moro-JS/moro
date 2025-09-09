// Performance monitoring middleware
import { createFrameworkLogger } from '../../logger';

const logger = createFrameworkLogger('PerformanceMonitor');

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
