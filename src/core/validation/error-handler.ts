// Validation Error Handler Utility
import type { HttpRequest, HttpResponse } from '../../types/http.js';
import type {
  ValidationErrorDetail,
  ValidationErrorContext,
  ValidationErrorResponse,
  ValidationErrorHandler,
} from '../../types/config.js';
import { logger } from '../logger/index.js';

/**
 * Default validation error handler
 * Returns a consistent error response format
 */
export const defaultValidationErrorHandler: ValidationErrorHandler = (
  errors: ValidationErrorDetail[],
  context: ValidationErrorContext
): ValidationErrorResponse => {
  return {
    status: 400,
    body: {
      success: false,
      error: `Validation failed for ${context.field}`,
      details: errors,
      requestId: (context.request as any).requestId,
    },
  };
};

/**
 * Handle validation errors using the configured error handler
 * This is the central function that all validation error handling should go through
 */
export function handleValidationError(
  errors: ValidationErrorDetail[],
  field: 'body' | 'query' | 'params' | 'headers',
  req: HttpRequest,
  res: HttpResponse,
  customHandler?: ValidationErrorHandler,
  globalHandler?: ValidationErrorHandler
): void {
  // Don't send error if headers already sent
  if (res.headersSent) {
    logger.warn('Attempted to send validation error after headers sent', 'ValidationError', {
      field,
      path: req.path,
      method: req.method,
    });
    return;
  }

  // Build context for error handler
  const context: ValidationErrorContext = {
    request: {
      method: req.method || 'UNKNOWN',
      path: req.path || req.url || '',
      url: req.url || '',
      headers: req.headers || {},
    },
    field,
  };

  // Use custom handler (route-level) > global handler > default handler
  const handler = customHandler || globalHandler || defaultValidationErrorHandler;

  logger.debug('Handling validation error', 'ValidationError', {
    field,
    errorCount: errors.length,
    path: req.path,
    method: req.method,
    hasCustomHandler: !!customHandler,
    hasGlobalHandler: !!globalHandler,
  });

  try {
    // Execute the error handler
    const errorResponse = handler(errors, context);

    // Apply headers if provided
    if (errorResponse.headers) {
      Object.entries(errorResponse.headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
    }

    // Send the response
    res.status(errorResponse.status).json(errorResponse.body);
  } catch (error) {
    logger.error('Error in validation error handler', 'ValidationError', {
      error: error instanceof Error ? error.message : String(error),
      field,
      path: req.path,
    });

    // Fallback to default error response if handler throws
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Internal error while handling validation error',
        requestId: req.requestId,
      });
    }
  }
}

/**
 * Normalize errors from different validation libraries into a consistent format
 */
export function normalizeErrors(errors: any[], field: string): ValidationErrorDetail[] {
  return errors.map((err: any) => ({
    field: err.path && err.path.length > 0 ? err.path.join('.') : field,
    message: err.message || 'Validation failed',
    code: err.code,
    value: err.input,
    path: err.path || [],
  }));
}
