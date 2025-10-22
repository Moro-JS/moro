// Validation Core - Reusable validation logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import {
  ValidationSchema,
  normalizeValidationError,
} from '../../../validation/schema-interface.js';

const logger = createFrameworkLogger('ValidationCore');

// ===== Types =====

export interface ValidationConfig {
  body?: ValidationSchema;
  query?: ValidationSchema;
  params?: ValidationSchema;
  headers?: ValidationSchema;
}

export interface ValidationErrorDetail {
  field: string;
  message: string;
  code: string;
}

// ===== Core Logic =====

/**
 * ValidationCore - Core validation logic
 * Used directly by the router for route-based validation
 * Can be instantiated for use in middleware or hooks
 */
export class ValidationCore {
  async validate(req: HttpRequest, res: HttpResponse, config: ValidationConfig): Promise<boolean> {
    // Don't validate if headers already sent
    if (res.headersSent) {
      return false;
    }

    try {
      if (config.body && req.body !== undefined) {
        try {
          (req as any).validatedBody = await config.body.parseAsync(req.body);
          req.body = (req as any).validatedBody;
        } catch (error: any) {
          this.handleValidationError(error, 'body', req, res);
          return false;
        }
      }

      if (config.query && req.query !== undefined) {
        try {
          (req as any).validatedQuery = await config.query.parseAsync(req.query);
          req.query = (req as any).validatedQuery;
        } catch (error: any) {
          this.handleValidationError(error, 'query', req, res);
          return false;
        }
      }

      if (config.params && req.params !== undefined) {
        try {
          (req as any).validatedParams = await config.params.parseAsync(req.params);
          req.params = (req as any).validatedParams;
        } catch (error: any) {
          this.handleValidationError(error, 'params', req, res);
          return false;
        }
      }

      if (config.headers && req.headers !== undefined) {
        try {
          (req as any).validatedHeaders = await config.headers.parseAsync(req.headers);
        } catch (error: any) {
          this.handleValidationError(error, 'headers', req, res);
          return false;
        }
      }

      return true;
    } catch (error: any) {
      logger.error('Unexpected validation error', 'Validation', {
        error: error.message,
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Internal server error',
          requestId: req.requestId,
        });
      }
      return false;
    }
  }

  private handleValidationError(
    error: any,
    field: 'body' | 'query' | 'params' | 'headers',
    req: HttpRequest,
    res: HttpResponse
  ): void {
    // Don't send error if headers already sent
    if (res.headersSent) {
      return;
    }

    const normalizedError = normalizeValidationError(error);

    res.status(400).json({
      success: false,
      error: `Validation failed for ${field}`,
      details: normalizedError.issues.map((issue: any) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : field,
        message: issue.message,
        code: issue.code,
      })),
      requestId: req.requestId,
    });
  }
}

// Shared instance for route-based validation
export const sharedValidationCore = new ValidationCore();
