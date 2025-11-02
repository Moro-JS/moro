// Universal Validation System for Moro Framework
// Works with Zod, Joi, Yup, and any validation library via adapters

import { HttpRequest, HttpResponse } from '../http/index.js';
import { createFrameworkLogger } from '../logger/index.js';
import { createUserRequire, isPackageAvailable } from '../utilities/package-utils.js';
import { ValidationSchema, normalizeValidationError } from './schema-interface.js';

const logger = createFrameworkLogger('Validation');

// Convenience re-export of Zod (optional - only works if zod is installed)
// Lazy-loads Zod synchronously on first access
// If zod is not installed, z will throw a helpful error
let zodModule: any = null;
let zodLoadAttempted = false;

function loadZodSync() {
  if (zodLoadAttempted) {
    return zodModule;
  }

  zodLoadAttempted = true;

  try {
    if (!isPackageAvailable('zod')) {
      zodModule = null;
      return zodModule;
    }

    // Use synchronous require for immediate availability
    const userRequire = createUserRequire();
    zodModule = userRequire('zod');
  } catch {
    // Zod not installed or failed to load
    zodModule = null;
  }

  return zodModule;
}

export const z = new Proxy({} as any, {
  get(_target, prop) {
    const zod = loadZodSync();

    if (!zod) {
      throw new Error(
        'Zod is not installed. Please install it with: npm install zod\n' +
          'Or use an alternative validation library (joi, yup, class-validator) via adapters.'
      );
    }

    if (!zod.z) {
      throw new Error(
        'Zod module loaded but z export not found. This may be a version compatibility issue.'
      );
    }

    return zod.z[prop];
  },
  apply(_target, thisArg, args) {
    const zod = loadZodSync();

    if (!zod?.z) {
      throw new Error('Zod is not installed. Please install it with: npm install zod');
    }

    return zod.z.apply(thisArg, args);
  },
});

// Universal validation configuration interface
export interface ValidationConfig {
  body?: ValidationSchema;
  query?: ValidationSchema;
  params?: ValidationSchema;
  headers?: ValidationSchema;
}

// Validation result types
export interface ValidationResult<T = any> {
  success: boolean;
  data?: T;
  errors?: ValidationErrorDetail[];
}

export interface ValidationErrorDetail {
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validate<TBody = any, TQuery = any, TParams = any>(
  config: ValidationConfig,
  handler: (req: ValidatedRequest<TBody>, res: HttpResponse) => any | Promise<any>
) {
  return async (req: HttpRequest, res: HttpResponse): Promise<any> => {
    try {
      const validatedReq = req as ValidatedRequest<TBody>;

      // Validate body
      if (config.body) {
        const result = await validateField(config.body, req.body, 'body');
        if (!result.success) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          return sendValidationError(res, result.errors!, 'body');
        }
        validatedReq.validatedBody = result.data;
        validatedReq.body = result.data; // Also update original body for compatibility
      }

      // Validate query parameters
      if (config.query) {
        const result = await validateField(config.query, req.query, 'query');
        if (!result.success) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          return sendValidationError(res, result.errors!, 'query');
        }
        validatedReq.validatedQuery = result.data;
        validatedReq.query = result.data; // Also update original query for compatibility
      }

      // Validate path parameters
      if (config.params) {
        const result = await validateField(config.params, req.params, 'params');
        if (!result.success) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          return sendValidationError(res, result.errors!, 'params');
        }
        validatedReq.validatedParams = result.data;
        validatedReq.params = result.data; // Also update original params for compatibility
      }

      // Validate headers
      if (config.headers) {
        const result = await validateField(config.headers, req.headers, 'headers');
        if (!result.success) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          return sendValidationError(res, result.errors!, 'headers');
        }
        validatedReq.validatedHeaders = result.data;
      }

      logger.debug('Request validation passed', 'ValidationSuccess', {
        path: req.path,
        method: req.method,
        validatedFields: Object.keys(config),
      });

      // Execute the handler with validated request
      return await handler(validatedReq, res);
    } catch (error) {
      logger.error('Validation wrapper error', 'ValidationError', {
        error: error instanceof Error ? error.message : String(error),
        path: req.path,
        method: req.method,
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Internal validation error',
          requestId: req.requestId,
        });
      }
    }
  };
}

// Validate individual field using universal schema interface
async function validateField(
  schema: ValidationSchema,
  data: any,
  fieldName: string
): Promise<ValidationResult> {
  try {
    const validated = await schema.parseAsync(data);
    return {
      success: true,
      data: validated,
    };
  } catch (error) {
    const normalizedError = normalizeValidationError(error);
    const errors: ValidationErrorDetail[] = normalizedError.issues.map(issue => ({
      field: issue.path.length > 0 ? issue.path.join('.') : fieldName,
      message: issue.message,
      code: issue.code,
    }));

    logger.debug('Field validation failed', 'ValidationFailed', {
      field: fieldName,
      errors: errors.length,
      details: errors,
    });

    return {
      success: false,
      errors,
    };
  }
}

// Send validation error response
function sendValidationError(
  res: HttpResponse,
  errors: ValidationErrorDetail[],
  field: string
): void {
  logger.debug('Sending validation error response', 'ValidationResponse', {
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
export function body<T>(schema: ValidationSchema<T>) {
  return (handler: (req: ValidatedRequest<T>, res: HttpResponse) => any | Promise<any>) => {
    return validate({ body: schema }, handler);
  };
}

export function query<T>(schema: ValidationSchema<T>) {
  return (handler: (req: ValidatedRequest<any>, res: HttpResponse) => any | Promise<any>) => {
    return validate({ query: schema }, handler);
  };
}

export function params<T>(schema: ValidationSchema<T>) {
  return (handler: (req: ValidatedRequest<any>, res: HttpResponse) => any | Promise<any>) => {
    return validate({ params: schema }, handler);
  };
}

// Schema composition helpers
export function combineSchemas(schemas: ValidationConfig): ValidationConfig {
  return schemas;
}

// Re-export common validation tools
export { ValidationError, normalizeValidationError } from './schema-interface.js';
export type { ValidationSchema, InferSchemaType } from './schema-interface.js';
export { joi, yup, fn as customValidator, classValidator } from './adapters.js';
