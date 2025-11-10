// gRPC Middleware - Logging Integration
// Integrate Moro's logging system with gRPC

import type { GrpcCall, GrpcCallback } from '../types.js';
import { createFrameworkLogger } from '../../logger/index.js';

/**
 * gRPC request logging middleware
 * Logs all gRPC calls with timing and status
 */
export function grpcLogger(
  options: {
    logger?: any;
    logMetadata?: boolean;
    logRequest?: boolean;
    logResponse?: boolean;
  } = {}
) {
  const logger = options.logger || createFrameworkLogger('GRPC_REQUEST');

  return async (call: GrpcCall, callback?: GrpcCallback, next?: CallableFunction) => {
    const startTime = Date.now();
    const peer = call.getPeer?.() || 'unknown';
    const methodPath = (call as any).methodPath || 'unknown';

    // Log request
    logger.info(`→ gRPC call: ${methodPath} from ${peer}`, 'Request');

    if (options.logMetadata && call.metadata) {
      logger.debug(`Metadata: ${JSON.stringify(call.metadata.getMap())}`, 'Request');
    }

    if (options.logRequest && call.request) {
      logger.debug(`Request: ${JSON.stringify(call.request)}`, 'Request');
    }

    try {
      // Execute handler
      if (next) {
        await next(call, callback);
      }

      const duration = Date.now() - startTime;
      logger.info(`✓ gRPC call completed: ${methodPath} in ${duration}ms`, 'Response');
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`✗ gRPC call failed: ${methodPath} in ${duration}ms - ${error}`, 'Response');
      throw error;
    }
  };
}

/**
 * Simple request logger that just logs method and timing
 */
export function grpcSimpleLogger() {
  return grpcLogger({
    logMetadata: false,
    logRequest: false,
    logResponse: false,
  });
}

/**
 * Detailed request logger that logs everything
 */
export function grpcDetailedLogger() {
  return grpcLogger({
    logMetadata: true,
    logRequest: true,
    logResponse: true,
  });
}
