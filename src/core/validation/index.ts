// Functional Validation System for Moro Framework
// Elegant, type-safe validation using Zod with functional composition

import { z, ZodSchema, ZodError } from "zod";
import { HttpRequest, HttpResponse } from "../http";
import { createFrameworkLogger } from "../logger";

const logger = createFrameworkLogger("Validation");

// Validation configuration interface
export interface ValidationConfig {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
}

// Validation result types
export interface ValidationResult<T = any> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// Enhanced request type with validated data
export interface ValidatedRequest<T = any> extends HttpRequest {
  validatedBody?: T;
  validatedQuery?: any;
  validatedParams?: any;
  validatedHeaders?: any;
}

// Main validation wrapper function
export function validate<TBody = any, TQuery = any, TParams = any>(
  config: ValidationConfig,
  handler: (
    req: ValidatedRequest<TBody>,
    res: HttpResponse,
  ) => any | Promise<any>,
) {
  return async (req: HttpRequest, res: HttpResponse): Promise<any> => {
    try {
      const validatedReq = req as ValidatedRequest<TBody>;

      // Validate body
      if (config.body) {
        const result = await validateField(config.body, req.body, "body");
        if (!result.success) {
          return sendValidationError(res, result.errors!, "body");
        }
        validatedReq.validatedBody = result.data;
        validatedReq.body = result.data; // Also update original body for compatibility
      }

      // Validate query parameters
      if (config.query) {
        const result = await validateField(config.query, req.query, "query");
        if (!result.success) {
          return sendValidationError(res, result.errors!, "query");
        }
        validatedReq.validatedQuery = result.data;
        validatedReq.query = result.data; // Also update original query for compatibility
      }

      // Validate path parameters
      if (config.params) {
        const result = await validateField(config.params, req.params, "params");
        if (!result.success) {
          return sendValidationError(res, result.errors!, "params");
        }
        validatedReq.validatedParams = result.data;
        validatedReq.params = result.data; // Also update original params for compatibility
      }

      // Validate headers
      if (config.headers) {
        const result = await validateField(
          config.headers,
          req.headers,
          "headers",
        );
        if (!result.success) {
          return sendValidationError(res, result.errors!, "headers");
        }
        validatedReq.validatedHeaders = result.data;
      }

      logger.debug("Request validation passed", "ValidationSuccess", {
        path: req.path,
        method: req.method,
        validatedFields: Object.keys(config),
      });

      // Execute the handler with validated request
      return await handler(validatedReq, res);
    } catch (error) {
      logger.error("Validation wrapper error", "ValidationError", {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
        method: req.method,
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Internal validation error",
          requestId: req.requestId,
        });
      }
    }
  };
}

// Validate individual field
async function validateField(
  schema: ZodSchema,
  data: any,
  fieldName: string,
): Promise<ValidationResult> {
  try {
    const validated = await schema.parseAsync(data);
    return {
      success: true,
      data: validated,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      const errors: ValidationError[] = error.issues.map((err: any) => ({
        field: err.path.length > 0 ? err.path.join(".") : fieldName,
        message: err.message,
        code: err.code,
      }));

      logger.debug("Field validation failed", "ValidationFailed", {
        field: fieldName,
        errors: errors.length,
        details: errors,
      });

      return {
        success: false,
        errors,
      };
    }

    // Re-throw unexpected errors
    throw error;
  }
}

// Send validation error response
function sendValidationError(
  res: HttpResponse,
  errors: ValidationError[],
  field: string,
): void {
  logger.debug("Sending validation error response", "ValidationResponse", {
    field,
    errorCount: errors.length,
  });

  res.status(400).json({
    success: false,
    error: `Validation failed for ${field}`,
    details: errors,
    requestId: (res as any).req?.requestId,
  });
}

// Convenience functions for single-field validation
export function body<T>(schema: ZodSchema<T>) {
  return (
    handler: (
      req: ValidatedRequest<T>,
      res: HttpResponse,
    ) => any | Promise<any>,
  ) => {
    return validate({ body: schema }, handler);
  };
}

export function query<T>(schema: ZodSchema<T>) {
  return (
    handler: (
      req: ValidatedRequest<any>,
      res: HttpResponse,
    ) => any | Promise<any>,
  ) => {
    return validate({ query: schema }, handler);
  };
}

export function params<T>(schema: ZodSchema<T>) {
  return (
    handler: (
      req: ValidatedRequest<any>,
      res: HttpResponse,
    ) => any | Promise<any>,
  ) => {
    return validate({ params: schema }, handler);
  };
}

// Schema composition helpers
export function combineSchemas(schemas: ValidationConfig): ValidationConfig {
  return schemas;
}

// Re-export Zod for convenience
export { z } from "zod";
