/**
 * Standardized API Response Helpers
 *
 * These helpers ensure consistent response formats across your API.
 * They are zero-overhead (just return plain objects) and optimized
 * for the framework's fast-path JSON serialization.
 *
 * @module ResponseHelpers
 */

/**
 * Standard success response with data
 */
export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
}

/**
 * Standard error response
 */
export interface ApiErrorResponse {
  success: false;
  error: string;
  code?: string;
  message?: string;
  details?: any;
}

/**
 * Union type for all API responses
 */
export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Validation error detail
 */
export interface ValidationErrorDetail {
  field: string;
  message: string;
  code?: string;
}

/**
 * Create a standardized success response
 *
 * @example
 * ```typescript
 * app.get('/users', async (req, res) => {
 *   const users = await getUsers();
 *   return success(users);
 * });
 *
 * // With message
 * app.post('/users', async (req, res) => {
 *   const user = await createUser(req.body);
 *   return success(user, 'User created successfully');
 * });
 * ```
 */
export function success<T = any>(data: T, message?: string): ApiSuccessResponse<T> {
  const response: ApiSuccessResponse<T> = {
    success: true,
    data,
  };

  if (message !== undefined) {
    response.message = message;
  }

  return response;
}

/**
 * Create a standardized error response
 *
 * @example
 * ```typescript
 * app.get('/users/:id', async (req, res) => {
 *   const user = await getUser(req.params.id);
 *   if (!user) {
 *     return res.status(404).json(
 *       error('User not found', 'USER_NOT_FOUND')
 *     );
 *   }
 *   return success(user);
 * });
 * ```
 */
export function error(errorMessage: string, code?: string, message?: string): ApiErrorResponse {
  const response: ApiErrorResponse = {
    success: false,
    error: errorMessage,
  };

  if (code !== undefined) {
    response.code = code;
  }

  if (message !== undefined) {
    response.message = message;
  }

  return response;
}

/**
 * Create a validation error response
 *
 * @example
 * ```typescript
 * app.post('/users', async (req, res) => {
 *   const validationErrors = validateUser(req.body);
 *   if (validationErrors.length > 0) {
 *     return res.status(400).json(
 *       validationError(validationErrors)
 *     );
 *   }
 *   // ... create user
 * });
 * ```
 */
export function validationError(
  details: ValidationErrorDetail[],
  message?: string
): ApiErrorResponse {
  return {
    success: false,
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    message: message || 'One or more fields failed validation',
    details,
  };
}

/**
 * Create an unauthorized error response
 *
 * @example
 * ```typescript
 * app.get('/admin', async (req, res) => {
 *   if (!req.user) {
 *     return res.status(401).json(unauthorized());
 *   }
 *   return success(adminData);
 * });
 * ```
 */
export function unauthorized(message: string = 'Authentication required'): ApiErrorResponse {
  return {
    success: false,
    error: 'Unauthorized',
    code: 'UNAUTHORIZED',
    message,
  };
}

/**
 * Create a forbidden error response
 *
 * @example
 * ```typescript
 * app.delete('/users/:id', async (req, res) => {
 *   if (!req.user.roles.includes('admin')) {
 *     return res.status(403).json(forbidden());
 *   }
 *   await deleteUser(req.params.id);
 *   return success({ deleted: true });
 * });
 * ```
 */
export function forbidden(message: string = 'Insufficient permissions'): ApiErrorResponse {
  return {
    success: false,
    error: 'Forbidden',
    code: 'FORBIDDEN',
    message,
  };
}

/**
 * Create a not found error response
 *
 * @example
 * ```typescript
 * app.get('/users/:id', async (req, res) => {
 *   const user = await getUser(req.params.id);
 *   if (!user) {
 *     return res.status(404).json(notFound('User'));
 *   }
 *   return success(user);
 * });
 * ```
 */
export function notFound(resource: string = 'Resource'): ApiErrorResponse {
  return {
    success: false,
    error: 'Not Found',
    code: 'NOT_FOUND',
    message: `${resource} not found`,
  };
}

/**
 * Create a conflict error response (e.g., duplicate entry)
 *
 * @example
 * ```typescript
 * app.post('/users', async (req, res) => {
 *   const existing = await getUserByEmail(req.body.email);
 *   if (existing) {
 *     return res.status(409).json(
 *       conflict('Email already in use')
 *     );
 *   }
 *   const user = await createUser(req.body);
 *   return success(user);
 * });
 * ```
 */
export function conflict(message: string): ApiErrorResponse {
  return {
    success: false,
    error: 'Conflict',
    code: 'CONFLICT',
    message,
  };
}

/**
 * Create a bad request error response
 *
 * @example
 * ```typescript
 * app.post('/upload', async (req, res) => {
 *   if (!req.files?.file) {
 *     return res.status(400).json(
 *       badRequest('File is required')
 *     );
 *   }
 *   // ... process file
 * });
 * ```
 */
export function badRequest(message: string = 'Invalid request'): ApiErrorResponse {
  return {
    success: false,
    error: 'Bad Request',
    code: 'BAD_REQUEST',
    message,
  };
}

/**
 * Create an internal server error response
 *
 * @example
 * ```typescript
 * app.get('/data', async (req, res) => {
 *   try {
 *     const data = await fetchData();
 *     return success(data);
 *   } catch (err) {
 *     return res.status(500).json(
 *       internalError('Failed to fetch data')
 *     );
 *   }
 * });
 * ```
 */
export function internalError(message: string = 'Internal server error'): ApiErrorResponse {
  return {
    success: false,
    error: 'Internal Server Error',
    code: 'INTERNAL_ERROR',
    message,
  };
}

/**
 * Create a rate limit exceeded error response
 *
 * @example
 * ```typescript
 * app.post('/api/send', async (req, res) => {
 *   const limited = await checkRateLimit(req.ip);
 *   if (limited) {
 *     return res.status(429).json(
 *       rateLimited(60) // 60 seconds retry
 *     );
 *   }
 *   // ... process request
 * });
 * ```
 */
export function rateLimited(retryAfter?: number): ApiErrorResponse {
  const response: ApiErrorResponse = {
    success: false,
    error: 'Too Many Requests',
    code: 'RATE_LIMITED',
    message: 'Rate limit exceeded',
  };

  if (retryAfter !== undefined) {
    response.details = { retryAfter };
  }

  return response;
}

/**
 * Standardized response helper object for convenient imports
 *
 * @example
 * ```typescript
 * import { response } from '@morojs/moro';
 *
 * app.get('/users', async (req, res) => {
 *   const users = await getUsers();
 *   return response.success(users);
 * });
 *
 * app.get('/users/:id', async (req, res) => {
 *   const user = await getUser(req.params.id);
 *   if (!user) {
 *     return res.status(404).json(response.notFound('User'));
 *   }
 *   return response.success(user);
 * });
 * ```
 */
export const response = {
  success,
  error,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  badRequest,
  internalError,
  rateLimited,
} as const;

/**
 * Type-safe response builder for complex scenarios
 *
 * @example
 * ```typescript
 * import { ResponseBuilder } from '@morojs/moro';
 *
 * app.get('/users', async (req, res) => {
 *   const users = await getUsers();
 *   return ResponseBuilder.success(users)
 *     .message('Successfully retrieved users')
 *     .build();
 * });
 * ```
 */
export class ResponseBuilder<T = any> {
  private response: Partial<ApiResponse<T>> = {};

  private constructor() {}

  /**
   * Start building a success response
   */
  static success<T>(data: T): ResponseBuilder<T> {
    const builder = new ResponseBuilder<T>();
    builder.response = {
      success: true,
      data,
    };
    return builder;
  }

  /**
   * Start building an error response
   */
  static error(errorMessage: string, code?: string): ResponseBuilder<never> {
    const builder = new ResponseBuilder<never>();
    builder.response = {
      success: false,
      error: errorMessage,
      code,
    };
    return builder;
  }

  /**
   * Add a message to the response
   */
  message(msg: string): this {
    this.response.message = msg;
    return this;
  }

  /**
   * Add details to the response
   */
  details(details: any): this {
    (this.response as ApiErrorResponse).details = details;
    return this;
  }

  /**
   * Add a code to error response
   */
  code(code: string): this {
    (this.response as ApiErrorResponse).code = code;
    return this;
  }

  /**
   * Build and return the final response
   */
  build(): ApiResponse<T> {
    return this.response as ApiResponse<T>;
  }
}
