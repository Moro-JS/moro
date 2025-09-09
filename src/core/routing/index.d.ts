import { ZodSchema } from 'zod';
import { HttpRequest, HttpResponse } from '../http';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type RouteHandler<T = any> = (req: HttpRequest, res: HttpResponse) => T | Promise<T>;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void
) => void | Promise<void>;
export interface ValidationConfig {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
  headers?: ZodSchema;
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
export interface MiddlewarePhases {
  before?: Middleware[];
  after?: Middleware[];
  transform?: Middleware[];
}
export interface RouteSchema {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
  validation?: ValidationConfig;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  middleware?: MiddlewarePhases;
  description?: string;
  tags?: string[];
}
export declare const EXECUTION_PHASES: readonly [
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
];
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
export interface ValidatedRequest<T = any> extends HttpRequest {
  validatedBody?: T;
  validatedQuery?: any;
  validatedParams?: any;
  validatedHeaders?: any;
  user?: any;
}
export interface RouteBuilder {
  validate(config: ValidationConfig): RouteBuilder;
  body<T>(schema: ZodSchema<T>): RouteBuilder;
  query<T>(schema: ZodSchema<T>): RouteBuilder;
  params<T>(schema: ZodSchema<T>): RouteBuilder;
  headers<T>(schema: ZodSchema<T>): RouteBuilder;
  auth(config: AuthConfig): RouteBuilder;
  rateLimit(config: RateLimitConfig): RouteBuilder;
  cache(config: CacheConfig): RouteBuilder;
  before(...middleware: Middleware[]): RouteBuilder;
  after(...middleware: Middleware[]): RouteBuilder;
  transform(...middleware: Middleware[]): RouteBuilder;
  use(...middleware: Middleware[]): RouteBuilder;
  describe(description: string): RouteBuilder;
  tag(...tags: string[]): RouteBuilder;
  handler<T>(handler: RouteHandler<T>): CompiledRoute;
}
export interface CompiledRoute {
  schema: RouteSchema;
  execute(req: HttpRequest, res: HttpResponse): Promise<void>;
}
export declare class IntelligentRouteBuilder implements RouteBuilder {
  private schema;
  constructor(method: HttpMethod, path: string);
  validate(config: ValidationConfig): RouteBuilder;
  body<T>(schema: ZodSchema<T>): RouteBuilder;
  query<T>(schema: ZodSchema<T>): RouteBuilder;
  params<T>(schema: ZodSchema<T>): RouteBuilder;
  headers<T>(schema: ZodSchema<T>): RouteBuilder;
  auth(config: AuthConfig): RouteBuilder;
  rateLimit(config: RateLimitConfig): RouteBuilder;
  cache(config: CacheConfig): RouteBuilder;
  before(...middleware: Middleware[]): RouteBuilder;
  after(...middleware: Middleware[]): RouteBuilder;
  transform(...middleware: Middleware[]): RouteBuilder;
  use(...middleware: Middleware[]): RouteBuilder;
  describe(description: string): RouteBuilder;
  tag(...tags: string[]): RouteBuilder;
  handler<T>(handler: RouteHandler<T>): CompiledRoute;
}
export declare class ExecutableRoute implements CompiledRoute {
  readonly schema: RouteSchema;
  constructor(schema: RouteSchema);
  execute(req: HttpRequest, res: HttpResponse): Promise<void>;
  private executePhase;
  private executeMiddleware;
  private executeRateLimit;
  private executeAuth;
  private executeValidation;
  private sendValidationError;
  private executeCache;
}
export declare function createRoute(method: HttpMethod, path: string): RouteBuilder;
export declare function defineRoute(schema: RouteSchema): CompiledRoute;
