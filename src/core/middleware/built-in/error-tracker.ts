// Error tracking middleware
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('ErrorTracker');

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
