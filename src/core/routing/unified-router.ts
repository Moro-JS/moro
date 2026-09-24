// Unified Router - Consolidates Intelligent Router and Core Router
// Combines best features from both systems with zero breaking changes

import { PathMatcher, CompiledPath } from './path-matcher.js';
import { ObjectPoolManager } from '../pooling/object-pool-manager.js';
import { createFrameworkLogger } from '../logger/index.js';
import { HttpRequest, HttpResponse } from '../../types/http.js';
import { RateLimitCore, type RateLimitConfig } from '../middleware/built-in/rate-limit/index.js';
import { CacheCore, type CacheConfig } from '../middleware/built-in/cache/index.js';
import { ValidationCore, type ValidationConfig } from '../middleware/built-in/validation/index.js';
import { requireAuth } from '../middleware/built-in/auth/helpers.js';
import { ValidationSchema } from '../validation/schema-interface.js';
import { MethodRadixRouter } from './radix-tree.js';

const logger = createFrameworkLogger('UnifiedRouter');

// Shared Core instances for route-based features
const rateLimitCore = new RateLimitCore();
const cacheCore = new CacheCore();
const validationCore = new ValidationCore();

// ===== Types =====

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type RouteHandler<T = any> = (req: HttpRequest, res: HttpResponse) => T | Promise<T>;
export type Middleware = (
  req: HttpRequest,
  res: HttpResponse,
  next: () => void
) => void | Promise<void>;

export interface AuthConfig {
  roles?: string[];
  permissions?: string[];
  optional?: boolean;
}

// Re-export config types from built-in middleware for convenience
export type { RateLimitConfig, CacheConfig, ValidationConfig };

export interface MiddlewarePhases {
  before?: Middleware[];
  after?: Middleware[];
  transform?: Middleware[];
}

export interface RouteSchema {
  method: HttpMethod;
  path: string;
  /** A function, or the response body itself (see StaticBody) */
  handler: RouteHandler | StaticBody;
  validation?: ValidationConfig;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  middleware?: MiddlewarePhases | Middleware[];
  description?: string;
  tags?: string[];
  /** Fixed reply of a literal handler. A server that can answer it
   *  natively (MoroEngineServer on @morojs/engine >= 1.1.6) does so without
   *  calling into JS; every other server runs `handler`, which sends the
   *  same bytes. */
  static?: StaticResponse;
}

/** The reply a literal handler sends, in the engine's shape. */
export interface StaticResponse {
  status: number;
  /** [name, value, name, value, ...], or null for no headers at all */
  headers: string[] | null;
  body: string | Buffer | null;
}

/** What .handler() accepts in place of a function: the response body itself. */
export type StaticBody = string | Buffer;

// A RouteSchema after registerRoute(): a literal body has been compiled into
// a function by compileStaticRoute, so dispatch can call the handler directly.
type RegisteredRouteSchema = RouteSchema & { handler: RouteHandler };

// The content-type res.send() implies for a body it was given no header for:
// the same three cases MoroEngineServer's send() picks a template by, spelled
// out here so an engine-answered reply carries the bytes send() would have.
const STATIC_JSON_START = /^\s*[{[]/;
function impliedContentType(body: StaticBody): string {
  if (typeof body !== 'string') return 'application/octet-stream';
  return STATIC_JSON_START.test(body)
    ? 'application/json; charset=utf-8'
    : 'text/plain; charset=utf-8';
}

/**
 * A literal body in place of a handler: the route answers with exactly that
 * body. A non-empty body goes out as res.send(body) would (status 200, the
 * implied content-type). An empty body has nothing a content-type could
 * describe, so it goes out as res.end() would: status and Content-Length: 0,
 * no header block - 38 bytes less per response, and byte-identical to the
 * engine's own static reply with no headers. When nothing else is configured
 * on the route - no auth, validation, rate limit, cache or middleware, and a
 * literal path - the schema also carries `static`, so a server that can
 * answer it natively does so without calling into JS. Anything configured
 * keeps the route on the normal pipeline, where the handler sends the same
 * bytes after that configuration has run.
 */
export function compileStaticRoute(schema: Partial<RouteSchema>, body: StaticBody): RouteSchema {
  const empty = body.length === 0;
  schema.handler = empty
    ? (_req: HttpRequest, res: HttpResponse) => {
        res.end();
      }
    : (_req: HttpRequest, res: HttpResponse) => {
        res.send(body);
      };

  const path = schema.path ?? '';
  const mw = schema.middleware;
  const hasMiddleware = Array.isArray(mw)
    ? mw.length > 0
    : mw !== undefined &&
      Object.keys(mw).some(phase => {
        const list = (mw as Record<string, unknown>)[phase];
        return Array.isArray(list) && list.length > 0;
      });
  const bare =
    !path.includes(':') &&
    !path.includes('*') &&
    !schema.auth &&
    !schema.validation &&
    !schema.rateLimit &&
    !schema.cache &&
    !hasMiddleware;
  if (bare) {
    schema.static = {
      status: 200,
      headers: empty ? null : ['content-type', impliedContentType(body)],
      body,
    };
  }
  return schema as RouteSchema;
}

// Canonical uppercase methods - lets dispatch skip toUpperCase for the
// interned method strings every adapter hands over
const UPPERCASE_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

// Internal route representation
interface InternalRoute {
  schema: RegisteredRouteSchema;
  compiledPath: CompiledPath;
  // Hoisted from schema at registration so the per-request dispatch is a
  // single monomorphic load instead of a two-level property chase
  handler: RouteHandler;
  isFastPath: boolean; // No middleware, auth, validation, rate limiting
  executionOrder: string[]; // Ordered list of execution phases
  // Route-specific configs (not middleware)
  rateLimitConfig?: RateLimitConfig;
  cacheConfig?: CacheConfig;
  authMiddleware?: Middleware; // Auth keeps middleware since it's using requireAuth helper
  validationConfig?: ValidationConfig;
}

// ===== Route Builder (Chainable API) =====

export class RouteBuilder {
  private schema: Partial<RouteSchema>;
  private router: UnifiedRouter;

  constructor(method: HttpMethod, path: string, router: UnifiedRouter) {
    this.schema = {
      method,
      path,
      middleware: {} as MiddlewarePhases,
    };
    this.router = router;
  }

  // Validation methods
  validate(config: ValidationConfig): this {
    // Avoid spread operator and Object.assign - manually merge properties
    if (!this.schema.validation) {
      this.schema.validation = config;
    } else {
      if (config.body !== undefined) this.schema.validation.body = config.body;
      if (config.query !== undefined) this.schema.validation.query = config.query;
      if (config.params !== undefined) this.schema.validation.params = config.params;
      if (config.headers !== undefined) this.schema.validation.headers = config.headers;
      // Without this, `.body(schema).validate({ onValidationError })` silently
      // dropped the handler and fell back to the default 400 response.
      if (config.onValidationError !== undefined) {
        this.schema.validation.onValidationError = config.onValidationError;
      }
    }
    return this;
  }

  body<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.body = schema;
    return this;
  }

  query<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.query = schema;
    return this;
  }

  params<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.params = schema;
    return this;
  }

  headers<T>(schema: ValidationSchema<T>): this {
    if (!this.schema.validation) this.schema.validation = {};
    this.schema.validation.headers = schema;
    return this;
  }

  // Security methods
  auth(config: AuthConfig): this {
    this.schema.auth = config;
    return this;
  }

  rateLimit(config: RateLimitConfig): this {
    this.schema.rateLimit = config;
    return this;
  }

  // Caching
  cache(config: CacheConfig): this {
    this.schema.cache = config;
    return this;
  }

  // Custom middleware
  before(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.before) phases.before = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.before.push(middleware[i] as Middleware);
    }
    return this;
  }

  after(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.after) phases.after = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.after.push(middleware[i] as Middleware);
    }
    return this;
  }

  transform(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    // Avoid spread, use push for better performance
    if (!phases.transform) phases.transform = [];
    for (let i = 0; i < middleware.length; i++) {
      phases.transform.push(middleware[i] as Middleware);
    }
    return this;
  }

  use(...middleware: Middleware[]): this {
    return this.after(...middleware);
  }

  // Metadata
  describe(description: string): this {
    this.schema.description = description;
    return this;
  }

  tag(...tags: string[]): this {
    // Avoid spread, use push for better performance
    if (!this.schema.tags) this.schema.tags = [];
    for (let i = 0; i < tags.length; i++) {
      this.schema.tags.push(tags[i] as string);
    }
    return this;
  }

  // Terminal method: a function, or the response body itself (see
  // compileStaticRoute for what a literal body means).
  handler<T>(handler: RouteHandler<T> | StaticBody): void {
    if (typeof handler === 'function') {
      // Avoid spread operator - add handler directly
      this.schema.handler = handler;
      this.router.registerRoute(this.schema as RouteSchema);
      return;
    }
    if (typeof handler === 'string' || Buffer.isBuffer(handler)) {
      this.router.registerRoute(compileStaticRoute(this.schema, handler));
      return;
    }
    throw new Error('Handler is required: a function, or the response body as a string or Buffer');
  }
}

// ===== Unified Router =====

export class UnifiedRouter {
  private static instance: UnifiedRouter | null = null;

  private readonly poolManager = ObjectPoolManager.getInstance();

  // Route storage optimized for different access patterns
  // OPTIMIZATION: Separate maps per method for faster lookup (no string concat needed)
  // Method -> path -> route. A Map (not a plain object) so the per-request
  // lookup keyed by a non-constant method string stays a monomorphic Map.get
  // instead of a megamorphic keyed object load.
  private staticRoutesByMethod = new Map<string, Map<string, InternalRoute>>([
    ['GET', new Map<string, InternalRoute>()],
    ['POST', new Map<string, InternalRoute>()],
    ['PUT', new Map<string, InternalRoute>()],
    ['DELETE', new Map<string, InternalRoute>()],
    ['PATCH', new Map<string, InternalRoute>()],
    ['HEAD', new Map<string, InternalRoute>()],
    ['OPTIONS', new Map<string, InternalRoute>()],
  ]);
  private dynamicRoutesBySegments = new Map<number, InternalRoute[]>(); // Grouped by segment count
  private fastPathRoutes = new Set<InternalRoute>(); // Routes with no middleware
  private allRoutes: InternalRoute[] = []; // For iteration/inspection

  // NEW: Radix tree for fast dynamic route matching
  private radixRouter = new MethodRadixRouter();

  // Statistics
  private stats = {
    totalRoutes: 0,
    staticRoutes: 0,
    dynamicRoutes: 0,
    fastPathRoutes: 0,
    requestCount: 0,
    fastPathHits: 0,
    staticHits: 0,
    dynamicHits: 0,
    cacheHits: 0,
    radixHits: 0,
  };

  constructor() {
    logger.debug('UnifiedRouter initialized', 'Initialization');
  }

  // User-registered global error handler (set via Moro.setErrorHandler)
  private errorHandler?: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>;

  // Lifecycle hook manager (set via Moro) so 'error' hooks observe handler
  // errors — the router swallows them here, so the server-level error
  // boundary never sees them.
  private hookManager?: any;

  setErrorHandler(fn: (err: any, req: HttpRequest, res: HttpResponse) => any | Promise<any>): void {
    this.errorHandler = fn;
  }

  setHookManager(hookManager: any): void {
    this.hookManager = hookManager;
  }

  // Invoke the registered error handler (if any). Returns true if it produced a response.
  private async invokeErrorHandler(
    err: any,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<boolean> {
    // Error hooks are observational: fire-and-forget so a slow or throwing
    // observer can never delay or alter the error response.
    if (
      this.hookManager &&
      (this.hookManager.hasHooks === undefined || this.hookManager.hasHooks('error'))
    ) {
      void Promise.resolve(
        this.hookManager.execute('error', { request: req, response: res, error: err })
      ).catch((hookError: any) =>
        logger.error('Error hook error', 'Hooks', {
          error: hookError instanceof Error ? hookError.message : String(hookError),
        })
      );
    }

    if (!this.errorHandler || res.headersSent) return false;
    try {
      const result = this.errorHandler(err, req, res);
      if (result && typeof (result as any).then === 'function') {
        await result;
      }
      return res.headersSent;
    } catch (handlerErr) {
      logger.error('Error handler itself threw', 'Execution', {
        error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
      });
      return false;
    }
  }

  /**
   * Get singleton instance (optional - can still create new instances)
   */
  static getInstance(): UnifiedRouter {
    if (!this.instance) {
      this.instance = new UnifiedRouter();
      logger.info(`UnifiedRouter initialized (PID: ${process.pid})`, 'Router');
    }
    return this.instance;
  }

  /**
   * Reset singleton (useful for testing)
   */
  static reset(): void {
    if (this.instance) {
      this.instance.clearAllRoutes();
    }
    this.instance = null;
  }

  /**
   * Clear all routes (useful for testing)
   */
  clearAllRoutes(): void {
    for (const methodMap of this.staticRoutesByMethod.values()) methodMap.clear();
    this.dynamicRoutesBySegments.clear();
    this.fastPathRoutes.clear();
    this.allRoutes = [];
    this.radixRouter.clear();
    this.stats = {
      totalRoutes: 0,
      staticRoutes: 0,
      dynamicRoutes: 0,
      fastPathRoutes: 0,
      requestCount: 0,
      fastPathHits: 0,
      staticHits: 0,
      dynamicHits: 0,
      cacheHits: 0,
      radixHits: 0,
    };
    logger.debug('UnifiedRouter routes cleared', 'Reset');
  }

  // ===== Route Registration =====

  /**
   * Register a route (internal method) - OPTIMIZED
   */
  registerRoute(schema: RouteSchema): void {
    // A literal body in place of a handler (see compileStaticRoute). Every
    // entry point lands here - the builder, app.get(path, body), route(schema)
    // - so this is where the body becomes a handler and, on a bare route, a
    // reply the native engine can answer itself.
    if (typeof schema.handler !== 'function') {
      const body: unknown = schema.handler;
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
        throw new Error(
          `Handler for ${schema.method} ${schema.path} must be a function, ` +
            'or the response body as a string or Buffer'
        );
      }
      compileStaticRoute(schema, body);
    }
    // From here on the handler is a function, whichever form was registered.
    const registered = schema as RegisteredRouteSchema;

    // OPTIMIZATION: Skip PathMatcher.compile for better performance
    // Determine if static route (optimized check)
    const pathLen = schema.path.length;
    let hasParams = false;
    for (let i = 0; i < pathLen; i++) {
      if (schema.path.charCodeAt(i) === 58) {
        // ':' character
        hasParams = true;
        break;
      }
    }

    const isStatic = !hasParams;
    const isFastPath = this.isFastPathRoute(schema);

    // OPTIMIZATION: Lazy execution order building (only when needed)
    const executionOrder = isFastPath ? [] : this.buildExecutionOrder(schema);

    // OPTIMIZATION: Lazy auth middleware creation (only create when needed, not during registration)
    // This speeds up route registration significantly
    const route: InternalRoute = {
      schema: registered,
      compiledPath: null as any, // Will be set lazily if needed
      handler: registered.handler,
      isFastPath,
      executionOrder,
      rateLimitConfig: schema.rateLimit,
      cacheConfig: schema.cache,
      authMiddleware: undefined, // Will be created lazily on first request
      validationConfig: schema.validation,
    } as any;

    // Store in appropriate structures
    if (isStatic) {
      const methodMap = this.staticRoutesByMethod.get(schema.method);
      if (methodMap) {
        methodMap.set(schema.path, route);
      }
      this.stats.staticRoutes++;

      // DON'T add static routes to radix tree - Map is faster
    } else {
      // Add ONLY dynamic routes to radix tree (primary lookup for dynamic routes)
      this.radixRouter.addRoute(schema.method, schema.path, route);

      // Keep segment-based grouping for backward compatibility
      const segments = this.countSegmentsFast(schema.path);
      let routes = this.dynamicRoutesBySegments.get(segments);
      if (!routes) {
        routes = [];
        this.dynamicRoutesBySegments.set(segments, routes);
      }
      routes.push(route);
      this.stats.dynamicRoutes++;
    }

    if (isFastPath) {
      this.fastPathRoutes.add(route);
      this.stats.fastPathRoutes++;
    }

    this.allRoutes.push(route);
    this.stats.totalRoutes++;

    // OPTIMIZATION: Skip logging in production for performance
    // Most routes are registered once at startup, so this isn't a hot path
    // But reducing allocations still helps
  }

  /**
   * Fast segment counting without allocations
   */
  private countSegmentsFast(path: string): number {
    let count = 0;
    let inSegment = false;
    const len = path.length;

    for (let i = 0; i < len; i++) {
      const char = path.charCodeAt(i);
      if (char === 47) {
        // '/' character
        inSegment = false;
      } else if (!inSegment) {
        inSegment = true;
        count++;
      }
    }

    return count;
  }

  /**
   * Compile specialized param extractor for common cases
   */
  private compileParamExtractor(
    compiledPath: CompiledPath
  ): (matches: RegExpMatchArray) => Record<string, string> {
    const paramNames = compiledPath.paramNames;
    const paramCount = paramNames.length;

    // Specialized extractors for common cases
    if (paramCount === 0) {
      return () => ({}); // No allocation needed
    } else if (paramCount === 1) {
      const name = paramNames[0] as string;
      return matches => ({ [name]: matches[1] as string });
    } else if (paramCount === 2) {
      const name1 = paramNames[0] as string;
      const name2 = paramNames[1] as string;
      return matches => ({ [name1]: matches[1] as string, [name2]: matches[2] as string });
    } else if (paramCount === 3) {
      const name1 = paramNames[0] as string;
      const name2 = paramNames[1] as string;
      const name3 = paramNames[2] as string;
      return matches => ({
        [name1]: matches[1] as string,
        [name2]: matches[2] as string,
        [name3]: matches[3] as string,
      });
    } else {
      // Generic path for 4+ params
      return matches => {
        const params: Record<string, string> = {};
        for (let i = 0; i < paramCount; i++) {
          params[paramNames[i] as string] = matches[i + 1] as string;
        }
        return params;
      };
    }
  }

  /**
   * Chainable API methods
   */
  get(path: string): RouteBuilder {
    return new RouteBuilder('GET', path, this);
  }

  post(path: string): RouteBuilder {
    return new RouteBuilder('POST', path, this);
  }

  put(path: string): RouteBuilder {
    return new RouteBuilder('PUT', path, this);
  }

  delete(path: string): RouteBuilder {
    return new RouteBuilder('DELETE', path, this);
  }

  patch(path: string): RouteBuilder {
    return new RouteBuilder('PATCH', path, this);
  }

  head(path: string): RouteBuilder {
    return new RouteBuilder('HEAD', path, this);
  }

  options(path: string): RouteBuilder {
    return new RouteBuilder('OPTIONS', path, this);
  }

  /**
   * Schema-first route registration
   */
  route(schema: RouteSchema): void {
    this.registerRoute(schema);
  }

  /**
   * Direct API (for backward compatibility)
   */
  addRoute(
    method: HttpMethod,
    path: string,
    handler: RouteHandler | StaticBody,
    middleware: Middleware[] = []
  ): void {
    this.registerRoute({
      method,
      path,
      handler,
      middleware,
    });
  }

  // ===== Route Matching =====

  /**
   * Find a matching route for the request - HYBRID OPTIMIZED
   * Returns boolean (sync) for fast-path routes, Promise<boolean> for others
   */
  handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> | boolean {
    this.stats.requestCount++;

    // Adapters hand over interned uppercase method strings - the Set probe
    // skips a per-request toUpperCase call (and its scan) in the common case
    const rawMethod = req.method;
    const method = (
      rawMethod && UPPERCASE_METHODS.has(rawMethod) ? rawMethod : rawMethod?.toUpperCase()
    ) as HttpMethod;
    const path = req.path;

    // FAST PATH 1: Try static route Map lookup first (fastest possible - no string concat)
    const methodMap = this.staticRoutesByMethod.get(method);
    if (methodMap) {
      const staticRoute = methodMap.get(path);

      if (staticRoute) {
        // (params untouched here: every adapter req initializes params, and
        // the engine adapter materializes it lazily on first handler access)

        // Fast-path execution (no middleware)
        if (staticRoute.isFastPath) {
          try {
            const result = staticRoute.handler(req, res);

            if (result && typeof (result as any).then === 'function') {
              return (result as Promise<any>)
                .then(actualResult => {
                  if (actualResult !== undefined && !res.headersSent) {
                    res.json(actualResult);
                  }
                  return true;
                })
                .catch(async err => {
                  const handled = await this.invokeErrorHandler(err, req, res);
                  if (!handled && !res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' });
                  }
                  return true;
                });
            } else {
              if (result !== undefined && !res.headersSent) {
                res.json(result);
              }
              return true;
            }
          } catch (err) {
            return (async () => {
              const handled = await this.invokeErrorHandler(err, req, res);
              if (!handled && !res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
              }
              return true;
            })();
          }
        }

        // Non-fast-path static route
        return (async () => {
          await this.executeRoute(staticRoute, req, res, { params: {} });
          return true;
        })();
      }
    }

    // FAST PATH 2: Try radix tree for dynamic routes
    const radixResult = this.radixRouter.findRoute(method, path);
    if (radixResult) {
      const route = radixResult.handler as InternalRoute;
      req.params = radixResult.params;

      // Fast-path dynamic routes (no middleware)
      if (route.isFastPath) {
        try {
          const result = route.handler(req, res);

          if (result && typeof (result as any).then === 'function') {
            return (result as Promise<any>)
              .then(actualResult => {
                if (actualResult !== undefined && !res.headersSent) {
                  res.json(actualResult);
                }
                return true;
              })
              .catch(async err => {
                const handled = await this.invokeErrorHandler(err, req, res);
                if (!handled && !res.headersSent) {
                  res.status(500).json({ error: 'Internal server error' });
                }
                return true;
              });
          } else {
            if (result !== undefined && !res.headersSent) {
              res.json(result);
            }
            return true;
          }
        } catch (err) {
          return (async () => {
            const handled = await this.invokeErrorHandler(err, req, res);
            if (!handled && !res.headersSent) {
              res.status(500).json({ error: 'Internal server error' });
            }
            return true;
          })();
        }
      }

      // Non-fast-path dynamic routes (with middleware)
      return (async () => {
        await this.executeRoute(route, req, res, { params: radixResult.params });
        return true;
      })();
    }

    // No route found
    return false;
  }

  // ===== Route Execution =====

  private async executeRoute(
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse,
    matchResult: { params: Record<string, string> }
  ): Promise<void> {
    // The matcher already built a fresh params object - use it directly.
    // (No pooling: handlers may retain req past the response, so recycling
    // the object would alias params across requests.)
    req.params = matchResult.params;

    try {
      // Performance: Skip empty executionOrder array iteration
      // Most routes have empty or very short executionOrder
      if (route.executionOrder.length > 0) {
        // Execute middleware phases in order
        for (const phase of route.executionOrder) {
          if (res.headersSent) break;
          await this.executePhase(phase, route, req, res);
        }
      }

      // Execute handler
      if (!res.headersSent) {
        const result = await route.schema.handler(req, res);
        if (result !== undefined && !res.headersSent) {
          await res.json(result);
        }
      } else {
        // Headers already sent by middleware (e.g., cache hit, validation error, rate limit, auth)
        // This is expected behavior, not an error
        logger.debug('Handler skipped - response already sent by middleware', 'Execution');
      }
    } catch (error) {
      logger.error('Route execution error', 'Execution', {
        error: error instanceof Error ? error.message : String(error),
        route: `${route.schema.method} ${route.schema.path}`,
      });

      const handled = await this.invokeErrorHandler(error, req, res);
      if (!handled && !res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Internal server error',
          requestId: req.requestId,
        });
      }
    }
  }

  private async executePhase(
    phase: string,
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse
  ): Promise<void> {
    const schema = route.schema;
    const middleware = schema.middleware;

    switch (phase) {
      case 'before': {
        // Performance: Early exit if no middleware present (fast path)
        if (!middleware || !('before' in middleware)) break;
        const beforeMw = (middleware as MiddlewarePhases).before;
        if (!beforeMw || beforeMw.length === 0) break;

        const beforeLen = beforeMw.length;
        for (let i = 0; i < beforeLen; i++) {
          const r = this.executeMiddleware(beforeMw[i] as Middleware, req, res);
          if (r) await r;
          if (res.headersSent) return;
        }
        break;
      }

      case 'rateLimit':
        // Use Core directly for route-based rate limiting
        if (route.rateLimitConfig) {
          await rateLimitCore.checkLimit(req, res, route.rateLimitConfig);
        }
        break;

      case 'auth':
        // Auth uses middleware (from requireAuth helper) - created lazily
        if (schema.auth) {
          if (!route.authMiddleware) {
            route.authMiddleware = requireAuth({
              ...(schema.auth.roles !== undefined && { roles: schema.auth.roles }),
              ...(schema.auth.permissions !== undefined && {
                permissions: schema.auth.permissions,
              }),
              ...(schema.auth.optional !== undefined && {
                allowUnauthenticated: schema.auth.optional,
              }),
            });
          }
          const r = this.executeMiddleware(route.authMiddleware, req, res);
          if (r) await r;
        }
        break;

      case 'validation':
        // Use Core directly for route-based validation
        if (route.validationConfig) {
          const isValid = await validationCore.validate(req, res, route.validationConfig);
          if (!isValid) {
            return; // Validation failed, response already sent
          }
        }
        break;

      case 'transform': {
        // Performance: Early exit if no middleware present (fast path)
        if (!middleware || !('transform' in middleware)) break;
        const transformMw = (middleware as MiddlewarePhases).transform;
        if (!transformMw || transformMw.length === 0) break;

        const transformLen = transformMw.length;
        for (let i = 0; i < transformLen; i++) {
          const r = this.executeMiddleware(transformMw[i] as Middleware, req, res);
          if (r) await r;
          if (res.headersSent) return;
        }
        break;
      }

      case 'cache':
        // Use Core directly for route-based caching
        if (route.cacheConfig) {
          const cached = await cacheCore.tryGet(req, res, route.cacheConfig);
          if (cached) {
            return; // Cache hit, response already sent
          }
        }
        break;

      case 'after': {
        // Performance: Early exit if no middleware present (fast path)
        if (!middleware || !('after' in middleware)) break;
        const afterMw = (middleware as MiddlewarePhases).after;
        if (!afterMw || afterMw.length === 0) break;

        const afterLen = afterMw.length;
        for (let i = 0; i < afterLen; i++) {
          const r = this.executeMiddleware(afterMw[i] as Middleware, req, res);
          if (r) await r;
          if (res.headersSent) return;
        }
        break;
      }

      case 'middleware': {
        // Handle array-style middleware (backward compatibility)
        // Performance: Early exit if no middleware present (fast path)
        if (!middleware || !Array.isArray(middleware) || middleware.length === 0) break;

        const middlewareLen = middleware.length;
        for (let i = 0; i < middlewareLen; i++) {
          const r = this.executeMiddleware(middleware[i] as Middleware, req, res);
          if (r) await r;
          if (res.headersSent) return;
        }
        break;
      }
    }
  }

  // Sync-aware: a middleware that returns a non-thenable always settled before
  // the caller could await it (next() called, or the auto-advance below), so
  // the promise was pure overhead - one allocation plus an async suspension per
  // middleware per request. Returns undefined in that case; callers skip the
  // await. A promise is only built when the middleware is genuinely async.
  // Error/advance semantics are unchanged.
  private executeMiddleware(
    middleware: Middleware,
    req: HttpRequest,
    res: HttpResponse
  ): void | Promise<void> {
    let resolved = false;
    let settle: (() => void) | undefined;

    const next = () => {
      if (resolved) return;
      resolved = true;
      if (settle) settle();
    };

    let result: any;
    try {
      result = middleware(req, res, next);
    } catch (error) {
      // Matches the previous promise form: a throw after next() already
      // advanced the chain was swallowed; otherwise it rejects/throws.
      if (resolved) return;
      resolved = true;
      throw error;
    }

    // Duck typing faster than instanceof
    const isThenable = result && typeof result.then === 'function';

    if (!isThenable) {
      // Sync middleware: previously this either resolved via next() or was
      // auto-advanced - settled either way before any await could observe it.
      next();
      return;
    }

    if (resolved) {
      // next() ran synchronously, so the chain already advanced. Keep the
      // returned promise's rejection handled, exactly as the old .catch(reject)
      // did on an already-resolved promise, so it never surfaces as unhandled.
      (result as Promise<any>).then(undefined, () => {});
      return;
    }

    return new Promise<void>((resolve, reject) => {
      settle = resolve;
      (result as Promise<any>).then(() => next(), reject);
    });
  }

  // ===== Helper Methods =====

  private isFastPathRoute(schema: RouteSchema): boolean {
    const middleware = schema.middleware;
    const hasMiddleware =
      (middleware && Array.isArray(middleware) && middleware.length > 0) ||
      (middleware &&
        typeof middleware === 'object' &&
        ((middleware as MiddlewarePhases).before?.length ||
          (middleware as MiddlewarePhases).after?.length ||
          (middleware as MiddlewarePhases).transform?.length));

    return (
      !schema.auth && !schema.validation && !schema.rateLimit && !schema.cache && !hasMiddleware
    );
  }

  private buildExecutionOrder(schema: RouteSchema): string[] {
    const order: string[] = [];
    const middleware = schema.middleware;

    // Phase-based middleware
    if (middleware && 'before' in middleware && middleware.before?.length) {
      order.push('before');
    }

    if (schema.rateLimit) order.push('rateLimit');
    if (schema.auth) order.push('auth');
    if (schema.validation) order.push('validation');

    if (middleware && 'transform' in middleware && middleware.transform?.length) {
      order.push('transform');
    }

    if (schema.cache) order.push('cache');

    if (middleware && 'after' in middleware && middleware.after?.length) {
      order.push('after');
    }

    // Array-style middleware (backward compatibility)
    if (middleware && Array.isArray(middleware) && middleware.length > 0) {
      order.push('middleware');
    }

    return order;
  }

  // ===== Inspection Methods =====

  getAllRoutes(): RouteSchema[] {
    return this.allRoutes.map(r => r.schema);
  }

  /**
   * Fast-path routes (no middleware/auth/validation/rateLimit/cache) in a shape
   * suitable for registering directly on a native server router (e.g. uWS).
   */
  getNativeFastPathRoutes(): Array<{
    method: string;
    path: string;
    paramNames: string[] | null;
    handler: (req: HttpRequest, res: HttpResponse) => any;
  }> {
    const result: Array<{
      method: string;
      path: string;
      paramNames: string[] | null;
      handler: (req: HttpRequest, res: HttpResponse) => any;
    }> = [];
    for (const route of this.allRoutes) {
      if (!route.isFastPath) continue;
      const path = route.schema.path;
      let paramNames: string[] | null = null;
      if (path.indexOf(':') !== -1) {
        paramNames = [];
        for (const seg of path.split('/')) {
          if (seg.charCodeAt(0) === 58) paramNames.push(seg.slice(1));
        }
      }
      result.push({
        method: route.schema.method,
        path,
        paramNames,
        handler: route.schema.handler,
      });
    }
    return result;
  }

  /**
   * Public wrapper around the registered error handler so native fast paths
   * share the exact same error semantics as router-dispatched routes.
   * Returns true if the handler produced a response.
   */
  handleRouteError(err: any, req: HttpRequest, res: HttpResponse): Promise<boolean> {
    return this.invokeErrorHandler(err, req, res);
  }

  getRouteCount(): number {
    return this.stats.totalRoutes;
  }

  getStats() {
    // Manually build object instead of spread operator
    return {
      totalRoutes: this.stats.totalRoutes,
      staticRoutes: this.stats.staticRoutes,
      dynamicRoutes: this.stats.dynamicRoutes,
      fastPathRoutes: this.stats.fastPathRoutes,
      requestCount: this.stats.requestCount,
      fastPathHits: this.stats.fastPathHits,
      staticHits: this.stats.staticHits,
      dynamicHits: this.stats.dynamicHits,
      cacheHits: this.stats.cacheHits,
      radixHits: this.stats.radixHits,
      poolManager: this.poolManager.getPerformanceSummary(),
      pathMatcher: PathMatcher.getStats(),
    };
  }

  logPerformanceStats(): void {
    const stats = this.getStats();
    logger.info('UnifiedRouter Performance', 'Stats', {
      totalRoutes: stats.totalRoutes,
      staticRoutes: stats.staticRoutes,
      dynamicRoutes: stats.dynamicRoutes,
      fastPathRoutes: stats.fastPathRoutes,
      requests: stats.requestCount,
      poolManager: {
        routeCacheHitRate: stats.poolManager.routeCacheHitRate.toFixed(1) + '%',
        responseCacheHitRate: stats.poolManager.responseCacheHitRate.toFixed(1) + '%',
        paramPoolUtilization: stats.poolManager.paramPoolUtilization.toFixed(1) + '%',
        totalMemoryKB: stats.poolManager.totalMemoryKB.toFixed(1) + ' KB',
      },
    });
  }
}
