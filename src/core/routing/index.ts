// Intelligent Routing System for Moro Framework
// Schema-first with automatic middleware ordering and chainable API

import { ValidationSchema } from '../validation/schema-interface.js';
import { HttpRequest, HttpResponse } from '../http/index.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('IntelligentRouting');

// Core types
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type RouteHandler<T = any> = (req: HttpRequest, res: HttpResponse) => T | Promise<T>;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void
) => void | Promise<void>;

// Configuration interfaces
export interface ValidationConfig {
  body?: ValidationSchema;
  query?: ValidationSchema;
  params?: ValidationSchema;
  headers?: ValidationSchema;
}

export interface AuthConfig {
  roles?: string[];
  permissions?: string[];
  optional?: boolean;
}

export interface RateLimitConfig {
  requests: number;
  window: number;
  skipSuccessfulRequests?: boolean;
}

export interface CacheConfig {
  ttl: number;
  key?: string;
  tags?: string[];
}

// Middleware phases for intelligent ordering
export interface MiddlewarePhases {
  before?: Middleware[]; // Before auth/validation
  after?: Middleware[]; // After validation, before handler
  transform?: Middleware[]; // Data transformation phase
}

// Core route schema
export interface RouteSchema {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;

  // Framework-managed (order-independent)
  validation?: ValidationConfig;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;

  // Custom middleware with phase hints
  middleware?: MiddlewarePhases;

  // Metadata
  description?: string;
  tags?: string[];
}

// Execution phases in optimal order
export const EXECUTION_PHASES = [
  'security', // CORS, Helmet (framework-managed)
  'parsing', // Body/query parsing (framework-managed)
  'rateLimit', // Rate limiting (early protection)
  'before', // Custom pre-processing middleware
  'auth', // Authentication/authorization
  'validation', // Request validation
  'transform', // Data transformation middleware
  'cache', // Caching logic
  'after', // Custom post-processing middleware
  'handler', // Route handler (always last)
] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

// Enhanced request with validation results
export interface ValidatedRequest<T = any> extends HttpRequest {
  validatedBody?: T;
  validatedQuery?: any;
  validatedParams?: any;
  validatedHeaders?: any;
  user?: any; // Added by auth middleware
}

// Route builder for chainable API
export interface RouteBuilder {
  // Validation methods
  validate(config: ValidationConfig): RouteBuilder;
  body<T>(schema: ValidationSchema<T>): RouteBuilder;
  query<T>(schema: ValidationSchema<T>): RouteBuilder;
  params<T>(schema: ValidationSchema<T>): RouteBuilder;
  headers<T>(schema: ValidationSchema<T>): RouteBuilder;

  // Security/Auth methods
  auth(config: AuthConfig): RouteBuilder;
  rateLimit(config: RateLimitConfig): RouteBuilder;

  // Caching
  cache(config: CacheConfig): RouteBuilder;

  // Custom middleware with phase control
  before(...middleware: Middleware[]): RouteBuilder;
  after(...middleware: Middleware[]): RouteBuilder;
  transform(...middleware: Middleware[]): RouteBuilder;
  use(...middleware: Middleware[]): RouteBuilder; // Alias for 'after'

  // Metadata
  describe(description: string): RouteBuilder;
  tag(...tags: string[]): RouteBuilder;

  // Terminal method
  handler<T>(handler: RouteHandler<T>): CompiledRoute;
}

// Compiled route ready for execution
export interface CompiledRoute {
  schema: RouteSchema;
  execute(req: HttpRequest, res: HttpResponse): Promise<void>;
}

// Route builder implementation
export class IntelligentRouteBuilder implements RouteBuilder {
  private schema: Partial<RouteSchema>;

  constructor(method: HttpMethod, path: string) {
    this.schema = {
      method,
      path,
      middleware: {},
    };
  }

  // Validation methods
  validate(config: ValidationConfig): RouteBuilder {
    this.schema.validation = { ...this.schema.validation, ...config };
    return this;
  }

  body<T>(schema: ValidationSchema<T>): RouteBuilder {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.body = schema;
    return this;
  }

  query<T>(schema: ValidationSchema<T>): RouteBuilder {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.query = schema;
    return this;
  }

  params<T>(schema: ValidationSchema<T>): RouteBuilder {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.params = schema;
    return this;
  }

  headers<T>(schema: ValidationSchema<T>): RouteBuilder {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.headers = schema;
    return this;
  }

  // Security methods
  auth(config: AuthConfig): RouteBuilder {
    this.schema.auth = config;
    return this;
  }

  rateLimit(config: RateLimitConfig): RouteBuilder {
    this.schema.rateLimit = config;
    return this;
  }

  // Caching
  cache(config: CacheConfig): RouteBuilder {
    this.schema.cache = config;
    return this;
  }

  // Custom middleware
  before(...middleware: Middleware[]): RouteBuilder {
    if (!this.schema.middleware) this.schema.middleware = {};
    this.schema.middleware.before = [...(this.schema.middleware.before || []), ...middleware];
    return this;
  }

  after(...middleware: Middleware[]): RouteBuilder {
    if (!this.schema.middleware) this.schema.middleware = {};
    this.schema.middleware.after = [...(this.schema.middleware.after || []), ...middleware];
    return this;
  }

  transform(...middleware: Middleware[]): RouteBuilder {
    if (!this.schema.middleware) this.schema.middleware = {};
    this.schema.middleware.transform = [...(this.schema.middleware.transform || []), ...middleware];
    return this;
  }

  use(...middleware: Middleware[]): RouteBuilder {
    return this.after(...middleware);
  }

  // Metadata
  describe(description: string): RouteBuilder {
    this.schema.description = description;
    return this;
  }

  tag(...tags: string[]): RouteBuilder {
    this.schema.tags = [...(this.schema.tags || []), ...tags];
    return this;
  }

  // Terminal method - compiles the route
  handler<T>(handler: RouteHandler<T>): CompiledRoute {
    if (!handler) {
      throw new Error('Handler is required');
    }

    const completeSchema: RouteSchema = {
      ...(this.schema as RouteSchema),
      handler,
    };

    logger.debug(
      `Compiled route: ${completeSchema.method} ${completeSchema.path}`,
      'RouteCompilation',
      {
        hasValidation: !!completeSchema.validation,
        hasAuth: !!completeSchema.auth,
        hasRateLimit: !!completeSchema.rateLimit,
        hasCache: !!completeSchema.cache,
        customMiddleware: {
          before: completeSchema.middleware?.before?.length || 0,
          after: completeSchema.middleware?.after?.length || 0,
          transform: completeSchema.middleware?.transform?.length || 0,
        },
      }
    );

    return new ExecutableRoute(completeSchema);
  }
}

// Executable route with intelligent middleware ordering
export class ExecutableRoute implements CompiledRoute {
  // PERFORMANCE OPTIMIZATION: Pre-analyze route requirements
  private readonly requiresAuth: boolean;
  private readonly requiresValidation: boolean;
  private readonly requiresRateLimit: boolean;
  private readonly requiresCache: boolean;
  private readonly hasBeforeMiddleware: boolean;
  private readonly hasAfterMiddleware: boolean;
  private readonly hasTransformMiddleware: boolean;
  private readonly isFastPath: boolean;

  constructor(public readonly schema: RouteSchema) {
    // Pre-calculate what this route actually needs
    this.requiresAuth = !!this.schema.auth;
    this.requiresValidation = !!this.schema.validation;
    this.requiresRateLimit = !!this.schema.rateLimit;
    this.requiresCache = !!this.schema.cache;
    this.hasBeforeMiddleware = !!this.schema.middleware?.before?.length;
    this.hasAfterMiddleware = !!this.schema.middleware?.after?.length;
    this.hasTransformMiddleware = !!this.schema.middleware?.transform?.length;

    // Fast path: no middleware, no auth, no validation, no rate limiting
    this.isFastPath =
      !this.requiresAuth &&
      !this.requiresValidation &&
      !this.requiresRateLimit &&
      !this.requiresCache &&
      !this.hasBeforeMiddleware &&
      !this.hasAfterMiddleware &&
      !this.hasTransformMiddleware;

    // Log fast path routes for monitoring
    if (this.isFastPath) {
      logger.debug(`Fast path route: ${this.schema.method} ${this.schema.path}`, 'FastPath');
    }
  }

  async execute(req: HttpRequest, res: HttpResponse): Promise<void> {
    const validatedReq = req as ValidatedRequest;

    try {
      // PERFORMANCE OPTIMIZATION: Fast path for simple routes
      if (this.isFastPath) {
        // Skip all middleware - execute handler directly
        const result = await this.schema.handler(validatedReq, res);
        if (result !== undefined && !res.headersSent) {
          res.json(result);
        }
        return;
      }

      // Optimized middleware execution - only run what's needed
      if (this.hasBeforeMiddleware) {
        await this.executePhase('before', validatedReq, res);
        if (res.headersSent) return;
      }

      if (this.requiresRateLimit) {
        await this.executePhase('rateLimit', validatedReq, res);
        if (res.headersSent) return;
      }

      if (this.requiresAuth) {
        await this.executePhase('auth', validatedReq, res);
        if (res.headersSent) return;
      }

      if (this.requiresValidation) {
        await this.executePhase('validation', validatedReq, res);
        if (res.headersSent) return;
      }

      if (this.hasTransformMiddleware) {
        await this.executePhase('transform', validatedReq, res);
        if (res.headersSent) return;
      }

      if (this.requiresCache) {
        await this.executePhase('cache', validatedReq, res);
        if (res.headersSent) return;
      }

      if (this.hasAfterMiddleware) {
        await this.executePhase('after', validatedReq, res);
        if (res.headersSent) return;
      }

      // Execute handler last
      if (!res.headersSent) {
        await this.executePhase('handler', validatedReq, res);
      }
    } catch (error) {
      logger.error('Route execution error', 'RouteExecution', {
        error: error instanceof Error ? error.message : String(error),
        route: `${this.schema.method} ${this.schema.path}`,
        requestId: req.requestId,
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Internal server error',
          requestId: req.requestId,
        });
      }
    }
  }

  private async executePhase(
    phase: ExecutionPhase,
    req: ValidatedRequest,
    res: HttpResponse
  ): Promise<void> {
    switch (phase) {
      case 'before':
        if (this.schema.middleware?.before) {
          for (const middleware of this.schema.middleware.before) {
            await this.executeMiddleware(middleware, req, res);
          }
        }
        break;

      case 'rateLimit':
        if (this.schema.rateLimit) {
          await this.executeRateLimit(req, res);
        }
        break;

      case 'auth':
        if (this.schema.auth) {
          await this.executeAuth(req, res);
        }
        break;

      case 'validation':
        if (this.schema.validation) {
          await this.executeValidation(req, res);
        }
        break;

      case 'transform':
        if (this.schema.middleware?.transform) {
          for (const middleware of this.schema.middleware.transform) {
            await this.executeMiddleware(middleware, req, res);
          }
        }
        break;

      case 'cache':
        if (this.schema.cache) {
          await this.executeCache(req, res);
        }
        break;

      case 'after':
        if (this.schema.middleware?.after) {
          for (const middleware of this.schema.middleware.after) {
            await this.executeMiddleware(middleware, req, res);
          }
        }
        break;

      case 'handler': {
        const result = await this.schema.handler(req, res);
        if (result !== undefined && !res.headersSent) {
          res.json(result);
        }
        break;
      }
    }
  }

  private async executeMiddleware(
    middleware: Middleware,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    // PERFORMANCE OPTIMIZATION: Reduce Promise overhead
    return new Promise((resolve, reject) => {
      let resolved = false;

      const next = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      try {
        const result = middleware(req, res, next);
        if (result instanceof Promise) {
          result.then(() => !resolved && next()).catch(reject);
        } else {
          // Synchronous middleware - call next immediately if not called
          if (!resolved) {
            next();
          }
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      }
    });
  }

  private async executeRateLimit(req: HttpRequest, res: HttpResponse): Promise<void> {
    // Rate limiting implementation will be added
    logger.debug('Rate limit check', 'RateLimit', {
      config: this.schema.rateLimit,
      ip: req.ip,
    });
  }

  private async executeAuth(req: ValidatedRequest, res: HttpResponse): Promise<void> {
    const authConfig = this.schema.auth;
    const auth = req.auth;

    // This should never happen since executeAuth is only called when auth config exists
    if (!authConfig) {
      logger.error('executeAuth called without auth config', 'Auth');
      return;
    }

    logger.debug('Auth check', 'Auth', {
      config: authConfig,
      isAuthenticated: auth?.isAuthenticated,
      userRoles: auth?.user?.roles,
    });

    // Check if auth middleware ran
    if (!auth) {
      res.status(500);
      res.json({
        success: false,
        error: 'Authentication middleware not configured',
        message: 'Auth middleware must be installed before using route-level auth',
      });
      return;
    }

    // Check authentication requirement (default is required unless optional: true)
    if (!authConfig.optional && !auth.isAuthenticated) {
      res.status(401);
      res.json({
        success: false,
        error: 'Authentication required',
        message: 'You must be logged in to access this resource',
      });
      return;
    }

    // Skip further checks if not authenticated but optional
    if (!auth.isAuthenticated && authConfig.optional) {
      return; // Continue to handler
    }

    // Only check roles/permissions if user is authenticated
    if (auth.isAuthenticated) {
      const user = auth.user;

      // Check roles if specified
      if (authConfig.roles && authConfig.roles.length > 0) {
        const userRoles = user?.roles || [];
        const hasRole = authConfig.roles.some((role: string) => userRoles.includes(role));

        if (!hasRole) {
          res.status(403);
          res.json({
            success: false,
            error: 'Insufficient permissions',
            message: `Required roles: ${authConfig.roles.join(', ')}`,
            userRoles,
          });
          return;
        }
      }

      // Check permissions if specified
      if (authConfig.permissions && authConfig.permissions.length > 0) {
        const userPermissions = user?.permissions || [];
        const hasPermission = authConfig.permissions.every((permission: string) =>
          userPermissions.includes(permission)
        );

        if (!hasPermission) {
          res.status(403);
          res.json({
            success: false,
            error: 'Insufficient permissions',
            message: `Required permissions: ${authConfig.permissions.join(', ')}`,
            userPermissions,
          });
          return;
        }
      }
    }

    // All auth checks passed
  }

  private async executeValidation(req: ValidatedRequest, res: HttpResponse): Promise<void> {
    if (!this.schema.validation) return;

    const { body, query, params, headers } = this.schema.validation;

    // Validate body
    if (body && req.body !== undefined) {
      try {
        req.validatedBody = await body.parseAsync(req.body);
        req.body = req.validatedBody; // Update original for compatibility
      } catch (error: any) {
        this.sendValidationError(res, error, 'body', req.requestId);
        return;
      }
    }

    // Validate query
    if (query && req.query !== undefined) {
      try {
        req.validatedQuery = await query.parseAsync(req.query);
        req.query = req.validatedQuery; // Update original for compatibility
      } catch (error: any) {
        this.sendValidationError(res, error, 'query', req.requestId);
        return;
      }
    }

    // Validate params
    if (params && req.params !== undefined) {
      try {
        req.validatedParams = await params.parseAsync(req.params);
        req.params = req.validatedParams; // Update original for compatibility
      } catch (error: any) {
        this.sendValidationError(res, error, 'params', req.requestId);
        return;
      }
    }

    // Validate headers
    if (headers && req.headers !== undefined) {
      try {
        req.validatedHeaders = await headers.parseAsync(req.headers);
      } catch (error: any) {
        this.sendValidationError(res, error, 'headers', req.requestId);
        return;
      }
    }

    logger.debug('Validation passed', 'Validation', {
      route: `${this.schema.method} ${this.schema.path}`,
      validatedFields: Object.keys(this.schema.validation),
    });
  }

  private sendValidationError(
    res: HttpResponse,
    error: any,
    field: string,
    requestId?: string
  ): void {
    if (error.issues) {
      res.status(400).json({
        success: false,
        error: `Validation failed for ${field}`,
        details: error.issues.map((issue: any) => ({
          field: issue.path.length > 0 ? issue.path.join('.') : field,
          message: issue.message,
          code: issue.code,
        })),
        requestId,
      });
    } else {
      res.status(400).json({
        success: false,
        error: `Validation failed for ${field}`,
        requestId,
      });
    }
  }

  private async executeCache(req: HttpRequest, res: HttpResponse): Promise<void> {
    // Caching implementation will be added
    logger.debug('Cache check', 'Cache', {
      config: this.schema.cache,
    });
  }

  // Performance monitoring
  getPerformanceInfo() {
    return {
      path: this.schema.path,
      method: this.schema.method,
      isFastPath: this.isFastPath,
      requiresAuth: this.requiresAuth,
      requiresValidation: this.requiresValidation,
      requiresRateLimit: this.requiresRateLimit,
      requiresCache: this.requiresCache,
      hasBeforeMiddleware: this.hasBeforeMiddleware,
      hasAfterMiddleware: this.hasAfterMiddleware,
      hasTransformMiddleware: this.hasTransformMiddleware,
    };
  }
}

// Factory functions for creating routes
export function createRoute(method: HttpMethod, path: string): RouteBuilder {
  return new IntelligentRouteBuilder(method, path);
}

// Schema-first route creation
export function defineRoute(schema: RouteSchema): CompiledRoute {
  return new ExecutableRoute(schema);
}
