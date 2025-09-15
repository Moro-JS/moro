// Universal Validation Schema Interface for Moro Framework
// Allows Zod, Joi, Yup, and other validation libraries to work seamlessly

/**
 * Standard validation error structure
 */
export interface ValidationIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

/**
 * Standard validation error class
 * Compatible with ZodError structure
 */
export class ValidationError extends Error {
  public readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const message = `Validation failed: ${issues.map(i => i.message).join(', ')}`;
    super(message);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Universal validation schema interface
 * This is what Zod naturally implements! No breaking changes needed.
 */
export interface ValidationSchema<T = any> {
  /**
   * Parse data asynchronously and return validated result
   * Throws ValidationError on validation failure
   */
  parseAsync(data: unknown): Promise<T>;
}

/**
 * Check if an object implements the ValidationSchema interface
 */
export function isValidationSchema(obj: any): obj is ValidationSchema {
  return obj && typeof obj.parseAsync === 'function';
}

/**
 * Convert various error formats to our standard ValidationError
 */
export function normalizeValidationError(error: any): ValidationError {
  // Already our format
  if (error instanceof ValidationError) {
    return error;
  }

  // Zod error format
  if (error && error.issues && Array.isArray(error.issues)) {
    return new ValidationError(
      error.issues.map((issue: any) => ({
        path: issue.path || [],
        message: issue.message || 'Validation failed',
        code: issue.code || 'invalid',
      }))
    );
  }

  // Joi error format
  if (error && error.details && Array.isArray(error.details)) {
    return new ValidationError(
      error.details.map((detail: any) => ({
        path: detail.path || [],
        message: detail.message || 'Validation failed',
        code: detail.type || 'invalid',
      }))
    );
  }

  // Yup error format
  if (error && error.errors && Array.isArray(error.errors)) {
    return new ValidationError(
      error.errors.map((msg: string, index: number) => ({
        path: error.path ? [error.path] : [index],
        message: msg,
        code: error.type || 'invalid',
      }))
    );
  }

  // Generic error
  return new ValidationError([
    {
      path: [],
      message: error.message || String(error),
      code: 'unknown',
    },
  ]);
}

// Type helper for inferring types from validation schemas
export type InferSchemaType<T> = T extends ValidationSchema<infer U> ? U : never;
