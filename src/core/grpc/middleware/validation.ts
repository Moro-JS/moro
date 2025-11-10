// gRPC Middleware - Validation Integration
// Integrate Moro's validation system with gRPC

import type { GrpcCall, GrpcCallback } from '../types.js';
import { normalizeValidationError } from '../../validation/schema-interface.js';
import { createFrameworkLogger } from '../../logger/index.js';

const logger = createFrameworkLogger('GRPC_VALIDATION');

/**
 * gRPC request validation middleware
 * Validates incoming gRPC requests using Zod, Joi, Yup, or any validation library
 */
export function grpcValidate(options: {
  request?: any; // Validation schema for request
  response?: any; // Validation schema for response
  stripUnknown?: boolean;
}) {
  return async (call: GrpcCall, callback?: GrpcCallback) => {
    try {
      // Validate request
      if (options.request && call.request) {
        try {
          // Try to validate with the schema
          if (typeof options.request.parse === 'function') {
            // Zod-like schema
            call.request = options.request.parse(call.request);
          } else if (typeof options.request.validate === 'function') {
            // Joi-like schema
            const result = options.request.validate(call.request, {
              stripUnknown: options.stripUnknown,
            });

            if (result.error) {
              throw result.error;
            }

            call.request = result.value;
          } else if (typeof options.request.validateSync === 'function') {
            // Yup-like schema
            call.request = options.request.validateSync(call.request, {
              stripUnknown: options.stripUnknown,
            });
          }
        } catch (error) {
          const normalizedError = normalizeValidationError(error);

          logger.error(`Request validation failed: ${normalizedError.message}`, 'Validation');

          const grpcError: any = new Error(`Invalid request: ${normalizedError.message}`);
          grpcError.code = 3; // INVALID_ARGUMENT
          grpcError.details = (normalizedError as any).errors || normalizedError.message;

          if (callback) {
            callback(grpcError);
            return;
          }

          throw grpcError;
        }
      }

      // Note: Response validation would happen in a wrapper around the handler
      // since we need to intercept the response before it's sent
    } catch (error) {
      logger.error(`Validation error: ${error}`, 'Validation');

      if (callback) {
        callback(error as any);
        return;
      }

      throw error;
    }
  };
}

/**
 * Wrap a handler to validate both request and response
 */
export function grpcValidateHandler<TRequest = any, TResponse = any>(
  handler: (call: GrpcCall<TRequest>, callback: GrpcCallback<TResponse>) => void | Promise<void>,
  options: {
    request?: any;
    response?: any;
    stripUnknown?: boolean;
  }
) {
  return async (call: GrpcCall<TRequest>, callback: GrpcCallback<TResponse>) => {
    // Validate request
    if (options.request) {
      const validator = grpcValidate({
        request: options.request,
        stripUnknown: options.stripUnknown,
      });
      await validator(call, callback);
    }

    // Wrap callback to validate response
    const wrappedCallback: GrpcCallback<TResponse> = (error, response) => {
      if (error || !response) {
        callback(error, response);
        return;
      }

      // Validate response
      if (options.response) {
        try {
          let validatedResponse = response;

          if (typeof options.response.parse === 'function') {
            // Zod-like schema
            validatedResponse = options.response.parse(response);
          } else if (typeof options.response.validate === 'function') {
            // Joi-like schema
            const result = options.response.validate(response, {
              stripUnknown: options.stripUnknown,
            });

            if (result.error) {
              throw result.error;
            }

            validatedResponse = result.value;
          } else if (typeof options.response.validateSync === 'function') {
            // Yup-like schema
            validatedResponse = options.response.validateSync(response, {
              stripUnknown: options.stripUnknown,
            });
          }

          callback(null, validatedResponse);
        } catch (validationError) {
          const normalizedError = normalizeValidationError(validationError);

          logger.error(`Response validation failed: ${normalizedError.message}`, 'Validation');

          const grpcError: any = new Error(`Invalid response: ${normalizedError.message}`);
          grpcError.code = 13; // INTERNAL
          grpcError.details = (normalizedError as any).errors || normalizedError.message;

          callback(grpcError);
        }
      } else {
        callback(null, response);
      }
    };

    // Execute handler
    await handler(call, wrappedCallback);
  };
}
