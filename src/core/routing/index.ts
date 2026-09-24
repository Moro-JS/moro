// Intelligent Routing System for Moro Framework
// Schema-first with automatic middleware ordering and chainable API
//
// NOTE: This file exports types and thin facades to UnifiedRouter
// All routing logic has been consolidated in unified-router.ts

import { ValidationSchema } from '../validation/schema-interface.js';
import { HttpRequest, HttpResponse } from '../http/index.js';
import {
  UnifiedRouter,
  compileStaticRoute,
  compileParamRoute,
  isParamEcho,
  param,
  type RouteSchema as UnifiedRouteSchema,
  type StaticBody,
  type StaticResponse,
  type ParamEcho,
  type ParamRouteReply,
} from './unified-router.js';

export type { StaticBody, StaticResponse, ParamEcho, ParamRouteReply };
export { param };

// ===== TYPE EXPORTS (Keep all - used by app code) =====

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type RouteHandler<T = any> = (req: HttpRequest, res: HttpResponse) => T | Promise<T>;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void
) => void | Promise<void>;

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
  skipFailedRequests?: boolean;
}

export interface CacheConfig {
  ttl: number;
  key?: string;
  tags?: string[];
}

export interface MiddlewarePhases {
  before?: Middleware[];
  after?: Middleware[];
  transform?: Middleware[];
}

export interface RouteSchema {
  method: HttpMethod;
  path: string;
  /** A function, the response body itself (StaticBody), or param(name) */
  handler: RouteHandler | StaticBody | ParamEcho;
  validation?: ValidationConfig;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  middleware?: MiddlewarePhases;
  description?: string;
  tags?: string[];
  /** Fixed reply of a literal handler; see StaticResponse */
  static?: StaticResponse;
  /** Engine shape of a param(name) handler; see ParamRouteReply */
  paramEcho?: ParamRouteReply;
}

export const EXECUTION_PHASES = [
  'security',
  'parsing',
  'rateLimit',
  'before',
  'auth',
  'validation',
  'transform',
  'cache',
  'after',
  'handler',
] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

export interface ValidatedRequest<T = any> extends HttpRequest {
  validatedBody?: T;
  validatedQuery?: any;
  validatedParams?: any;
  validatedHeaders?: any;
  user?: any;
}

// ===== ROUTE BUILDER INTERFACE (Public API) =====

export interface RouteBuilder {
  validate(config: ValidationConfig): RouteBuilder;
  body<T>(schema: ValidationSchema<T>): RouteBuilder;
  query<T>(schema: ValidationSchema<T>): RouteBuilder;
  params<T>(schema: ValidationSchema<T>): RouteBuilder;
  headers<T>(schema: ValidationSchema<T>): RouteBuilder;
  auth(config: AuthConfig): RouteBuilder;
  rateLimit(config: RateLimitConfig): RouteBuilder;
  cache(config: CacheConfig): RouteBuilder;
  before(...middleware: Middleware[]): RouteBuilder;
  after(...middleware: Middleware[]): RouteBuilder;
  transform(...middleware: Middleware[]): RouteBuilder;
  use(...middleware: Middleware[]): RouteBuilder;
  describe(description: string): RouteBuilder;
  tag(...tags: string[]): RouteBuilder;
  /** Terminal. A function handles the request; a string or Buffer IS the
   *  response body (as res.send would send it); param(name) echoes that path
   *  parameter as the body. On a route with nothing else configured Moro's
   *  native engine answers the last two without calling JS. */
  handler<T>(handler: RouteHandler<T> | StaticBody | ParamEcho): void;
}

// ===== COMPILED ROUTE INTERFACE (Public API) =====

export interface CompiledRoute {
  schema: RouteSchema;
  execute(req: HttpRequest, res: HttpResponse): Promise<void>;
}

// ===== FACADE IMPLEMENTATIONS (Delegate to UnifiedRouter) =====

/**
 * Thin facade to UnifiedRouter.RouteBuilder
 * Maintains backward compatibility while using optimized implementation
 */
export class IntelligentRouteBuilder implements RouteBuilder {
  private schema: Partial<RouteSchema>;
  private router = UnifiedRouter.getInstance();

  constructor(method: HttpMethod, path: string) {
    this.schema = {
      method,
      path,
      middleware: {} as MiddlewarePhases,
    };
  }

  validate(config: ValidationConfig): RouteBuilder {
    // Avoid spread operator - manually merge properties
    if (!this.schema.validation) {
      this.schema.validation = config;
    } else {
      if (config.body !== undefined) this.schema.validation.body = config.body;
      if (config.query !== undefined) this.schema.validation.query = config.query;
      if (config.params !== undefined) this.schema.validation.params = config.params;
      if (config.headers !== undefined) this.schema.validation.headers = config.headers;
    }
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

  auth(config: AuthConfig): RouteBuilder {
    this.schema.auth = config;
    return this;
  }

  rateLimit(config: RateLimitConfig): RouteBuilder {
    this.schema.rateLimit = config;
    return this;
  }

  cache(config: CacheConfig): RouteBuilder {
    this.schema.cache = config;
    return this;
  }

  before(...middleware: Middleware[]): RouteBuilder {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.before) phases.before = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.before.push(middleware[i] as Middleware);
    }
    return this;
  }

  after(...middleware: Middleware[]): RouteBuilder {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.after) phases.after = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.after.push(middleware[i] as Middleware);
    }
    return this;
  }

  transform(...middleware: Middleware[]): RouteBuilder {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.transform) phases.transform = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.transform.push(middleware[i] as Middleware);
    }
    return this;
  }

  use(...middleware: Middleware[]): RouteBuilder {
    return this.after(...middleware);
  }

  describe(description: string): RouteBuilder {
    this.schema.description = description;
    return this;
  }

  tag(...tags: string[]): RouteBuilder {
    // Avoid spread, use push for better performance
    if (!this.schema.tags) this.schema.tags = [];
    for (let i = 0; i < tags.length; i++) {
      this.schema.tags.push(tags[i] as string);
    }
    return this;
  }

  handler<T>(handler: RouteHandler<T> | StaticBody | ParamEcho): void {
    if (typeof handler === 'function') {
      // Avoid spread operator - add handler directly
      this.schema.handler = handler;

      // Delegate to UnifiedRouter
      this.router.registerRoute(this.schema as RouteSchema);
      return;
    }
    if (typeof handler === 'string' || Buffer.isBuffer(handler)) {
      this.router.registerRoute(
        compileStaticRoute(this.schema as Partial<UnifiedRouteSchema>, handler)
      );
      return;
    }
    if (isParamEcho(handler)) {
      this.router.registerRoute(
        compileParamRoute(this.schema as Partial<UnifiedRouteSchema>, handler)
      );
      return;
    }
    throw new Error(
      'Handler is required: a function, the response body as a string or Buffer, or param(name)'
    );
  }
}

/**
 * Thin facade implementing CompiledRoute interface
 * Just stores schema for documentation purposes
 */
export class ExecutableRoute implements CompiledRoute {
  constructor(public readonly schema: RouteSchema) {
    // Register with UnifiedRouter
    UnifiedRouter.getInstance().registerRoute(schema);
  }

  async execute(_req: HttpRequest, _res: HttpResponse): Promise<void> {
    // This is never called - UnifiedRouter handles execution
    // But we implement it for interface compatibility
    throw new Error(
      'ExecutableRoute.execute() should not be called directly - routing handled by UnifiedRouter'
    );
  }
}

// ===== FACTORY FUNCTIONS (Backward Compatibility) =====

export function createRoute(method: HttpMethod, path: string): RouteBuilder {
  return new IntelligentRouteBuilder(method, path);
}

export function defineRoute(schema: RouteSchema): CompiledRoute {
  return new ExecutableRoute(schema);
}

// ===== RE-EXPORTS FROM UNIFIED ROUTER =====

export { UnifiedRouter } from './unified-router.js';
export { RouteBuilder as UnifiedRouteBuilder } from './unified-router.js';
export { PathMatcher, type CompiledPath, type MatchResult } from './path-matcher.js';
export { ObjectPoolManager, getPoolManager } from '../pooling/object-pool-manager.js';
