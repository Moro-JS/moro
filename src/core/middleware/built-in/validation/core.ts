// Validation Core - Reusable validation logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import {
  ValidationSchema,
  normalizeValidationError,
} from '../../../validation/schema-interface.js';
import { handleValidationError, normalizeErrors } from '../../../validation/error-handler.js';
import { getGlobalConfig } from '../../../config/index.js';
import type { ValidationErrorHandler } from '../../../../types/config.js';

const logger = createFrameworkLogger('ValidationCore');

// ===== Types =====

export interface ValidationConfig {
  body?: ValidationSchema;
  query?: ValidationSchema;
  params?: ValidationSchema;
  headers?: ValidationSchema;
  onValidationError?: ValidationErrorHandler;
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

    // Get global validation config
    let globalHandler: ValidationErrorHandler | undefined;
    try {
      const globalConfig = getGlobalConfig();
      globalHandler = globalConfig.modules.validation.onError;
    } catch {
      // Config not initialized yet, use default handler
      globalHandler = undefined;
    }

    try {
      // Order by likelihood and cost: params > query > body > headers
      // Params are fastest (already parsed, small) and most common in REST APIs
      if (config.params !== undefined && req.params !== undefined) {
        // Skip empty params objects for better performance
        let hasParams = false;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const key in req.params) {
          hasParams = true;
          break;
        }
        if (hasParams) {
          try {
            (req as any).validatedParams = await config.params.parseAsync(req.params);
            req.params = (req as any).validatedParams;
          } catch (error: any) {
            this.handleValidationError(
              error,
              'params',
              req,
              res,
              config.onValidationError,
              globalHandler
            );
            return false;
          }
        }
      }

      // Query is second (common on GET requests, already parsed)
      if (config.query !== undefined && req.query !== undefined) {
        // Skip empty query objects for better performance
        let hasQuery = false;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const key in req.query) {
          hasQuery = true;
          break;
        }
        if (hasQuery) {
          try {
            (req as any).validatedQuery = await config.query.parseAsync(req.query);
            req.query = (req as any).validatedQuery;
          } catch (error: any) {
            this.handleValidationError(
              error,
              'query',
              req,
              res,
              config.onValidationError,
              globalHandler
            );
            return false;
          }
        }
      }

      // Body is expensive (POST/PUT/PATCH only, requires parsing)
      if (config.body !== undefined && req.body !== undefined) {
        try {
          (req as any).validatedBody = await config.body.parseAsync(req.body);
          req.body = (req as any).validatedBody;
        } catch (error: any) {
          this.handleValidationError(
            error,
            'body',
            req,
            res,
            config.onValidationError,
            globalHandler
          );
          return false;
        }
      }

      // Headers are rarely validated
      if (config.headers !== undefined && req.headers !== undefined) {
        try {
          (req as any).validatedHeaders = await config.headers.parseAsync(req.headers);
        } catch (error: any) {
          this.handleValidationError(
            error,
            'headers',
            req,
            res,
            config.onValidationError,
            globalHandler
          );
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
    res: HttpResponse,
    customHandler?: ValidationErrorHandler,
    globalHandler?: ValidationErrorHandler
  ): void {
    // Don't send error if headers already sent
    if (res.headersSent) {
      return;
    }

    const normalizedError = normalizeValidationError(error);
    const errors = normalizeErrors(normalizedError.issues, field);

    handleValidationError(errors, field, req, res, customHandler, globalHandler);
  }
}

// Shared instance for route-based validation
export const sharedValidationCore = new ValidationCore();
