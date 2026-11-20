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

  // Yup error format, validated with `abortEarly: false`: one entry per failed
  // field in `inner`, each with its own path. The top-level error then has no
  // path of its own, only the list of messages.
  if (error && Array.isArray(error.inner) && error.inner.length > 0) {
    const issues: ValidationIssue[] = [];
    for (const inner of error.inner) {
      const path = parseYupPath(inner?.path);
      const messages: unknown[] =
        Array.isArray(inner?.errors) && inner.errors.length > 0 ? inner.errors : [inner?.message];
      for (const message of messages) {
        issues.push({
          path,
          message: typeof message === 'string' && message ? message : 'Validation failed',
          code: inner?.type || 'invalid',
        });
      }
    }
    return new ValidationError(issues);
  }

  // Yup error format, single error (`abortEarly: true`)
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

/**
 * Split a Yup error path ("user.email", "tags[1]", 'meta["a.b"]') into its
 * segments, the form the other libraries report: ['user', 'email'], ['tags', 1].
 */
function parseYupPath(path: unknown): (string | number)[] {
  if (typeof path !== 'string' || path === '') return [];
  const segments: (string | number)[] = [];
  const pattern = /\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|[^.[\]]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    if (match[1] !== undefined) segments.push(Number(match[1]));
    else if (match[2] !== undefined) segments.push(match[2]);
    else segments.push(match[0]);
  }
  return segments.length > 0 ? segments : [path];
}

// Type helper for inferring types from validation schemas
export type InferSchemaType<T> = T extends ValidationSchema<infer U> ? U : never;
