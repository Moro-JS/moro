// Simple request logging middleware
import { createFrameworkLogger } from '../../logger';

const logger = createFrameworkLogger('RequestLogger');

export const requestLogger = async (context: any): Promise<void> => {
  const startTime = Date.now();

  logger.info(`${context.request?.method} ${context.request?.path}`, 'RequestLogger');

  // Log completion after response
  context.onComplete = () => {
    const duration = Date.now() - startTime;
    logger.info(`Request completed in ${duration}ms`, 'RequestLogger');
  };
};
