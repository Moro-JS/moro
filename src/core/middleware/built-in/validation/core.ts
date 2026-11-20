// Validation Core - Reusable validation logic
import { createFrameworkLogger } from '../../../logger/index.js';
import { HttpRequest, HttpResponse } from '../../../../types/http.js';
import {
  ValidationSchema,
  normalizeValidationError,
} from '../../../validation/schema-interface.js';
import { handleValidationError, normalizeErrors } from '../../../validation/error-handler.js';
import { configForRequest } from '../../../config/config-manager.js';
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

type SchemaRunResult = { success: boolean; data?: any; error?: any };

// Schemas that threw from safeParse (async refinements) - always use parseAsync for these
const asyncOnlySchemas = new WeakSet<object>();

/**
 * Run a schema against data, preferring the synchronous safeParse fast path
 * (no promise, no exception-based control flow) when the library supports it.
 * Falls back to parseAsync for libraries without safeParse (Joi/Yup adapters)
 * and for schemas with async refinements.
 */
function runSchema(
  schema: ValidationSchema,
  data: unknown
): SchemaRunResult | Promise<SchemaRunResult> {
  const s: any = schema;
  if (typeof s.safeParse === 'function' && !asyncOnlySchemas.has(s)) {
    try {
      const r = s.safeParse(data);
      return r.success ? { success: true, data: r.data } : { success: false, error: r.error };
    } catch {
      // safeParse throws (rather than failing) only when the schema requires
      // async parsing (e.g. zod async refinements) - remember and fall through
      asyncOnlySchemas.add(s);
    }
  }
  return s.parseAsync(data).then(
    (d: any) => ({ success: true, data: d }),
    (e: any) => ({ success: false, error: e })
  );
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
      // Order by likelihood and cost: params > query > body > headers
      // Params are fastest (already parsed, small) and most common in REST APIs
      // A declared schema always runs, on an empty object too: that is where a
      // required field is missing.
      if (config.params !== undefined && req.params !== undefined) {
        let result = runSchema(config.params, req.params);
        if (typeof (result as any).then === 'function') result = await result;
        if ((result as SchemaRunResult).success) {
          (req as any).validatedParams = (result as SchemaRunResult).data;
          req.params = (req as any).validatedParams;
        } else {
          this.handleValidationError(
            (result as SchemaRunResult).error,
            'params',
            req,
            res,
            config.onValidationError
          );
          return false;
        }
      }

      // Query is second (common on GET requests, already parsed)
      if (config.query !== undefined && req.query !== undefined) {
        let result = runSchema(config.query, req.query);
        if (typeof (result as any).then === 'function') result = await result;
        if ((result as SchemaRunResult).success) {
          (req as any).validatedQuery = (result as SchemaRunResult).data;
          req.query = (req as any).validatedQuery;
        } else {
          this.handleValidationError(
            (result as SchemaRunResult).error,
            'query',
            req,
            res,
            config.onValidationError
          );
          return false;
        }
      }

      // Body is expensive (POST/PUT/PATCH only, requires parsing)
      if (config.body !== undefined && req.body !== undefined) {
        let result = runSchema(config.body, req.body);
        if (typeof (result as any).then === 'function') result = await result;
        if ((result as SchemaRunResult).success) {
          (req as any).validatedBody = (result as SchemaRunResult).data;
          req.body = (req as any).validatedBody;
        } else {
          this.handleValidationError(
            (result as SchemaRunResult).error,
            'body',
            req,
            res,
            config.onValidationError
          );
          return false;
        }
      }

      // Headers are rarely validated
      if (config.headers !== undefined && req.headers !== undefined) {
        let result = runSchema(config.headers, req.headers);
        if (typeof (result as any).then === 'function') result = await result;
        if ((result as SchemaRunResult).success) {
          (req as any).validatedHeaders = (result as SchemaRunResult).data;
        } else {
          this.handleValidationError(
            (result as SchemaRunResult).error,
            'headers',
            req,
            res,
            config.onValidationError
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
    customHandler?: ValidationErrorHandler
  ): void {
    // Don't send error if headers already sent
    if (res.headersSent) {
      return;
    }

    // Resolve the app's handler (modules.validation.onError of the app that
    // is handling this request) on the error path only - the success path
    // (the overwhelming majority of requests) never touches config
    const globalHandler: ValidationErrorHandler | undefined =
      configForRequest(req)?.modules?.validation?.onError;

    const normalizedError = normalizeValidationError(error);
    const errors = normalizeErrors(normalizedError.issues, field);

    handleValidationError(errors, field, req, res, customHandler, globalHandler);
  }
}

// Shared instance for route-based validation
export const sharedValidationCore = new ValidationCore();
