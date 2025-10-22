// Request Logger Middleware
import { createFrameworkLogger } from '../../../logger/index.js';

const logger = createFrameworkLogger('RequestLogger');

/**
 * Simple request logging middleware
 * Logs incoming requests and their completion time
 *
 * @example
 * ```ts
 * import { requestLogger } from '@/middleware/built-in/request-logger';
 *
 * app.use(requestLogger);
 * ```
 */
export const requestLogger = async (context: any): Promise<void> => {
  const startTime = Date.now();

  logger.info(`${context.request?.method} ${context.request?.path}`, 'RequestLogger');

  // Log completion after response
  context.onComplete = () => {
    const duration = Date.now() - startTime;
    logger.info(`Request completed in ${duration}ms`, 'RequestLogger');
  };
};
