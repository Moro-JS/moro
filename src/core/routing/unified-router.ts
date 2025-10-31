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
  handler: RouteHandler;
  validation?: ValidationConfig;
  auth?: AuthConfig;
  rateLimit?: RateLimitConfig;
  cache?: CacheConfig;
  middleware?: MiddlewarePhases | Middleware[];
  description?: string;
  tags?: string[];
}

// Internal route representation
interface InternalRoute {
  schema: RouteSchema;
  compiledPath: CompiledPath;
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
    this.schema.validation = { ...this.schema.validation, ...config };
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
    phases.before = [...(phases.before || []), ...middleware];
    return this;
  }

  after(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    phases.after = [...(phases.after || []), ...middleware];
    return this;
  }

  transform(...middleware: Middleware[]): this {
    if (!this.schema.middleware) this.schema.middleware = {};
    const phases = this.schema.middleware as MiddlewarePhases;
    phases.transform = [...(phases.transform || []), ...middleware];
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
    this.schema.tags = [...(this.schema.tags || []), ...tags];
    return this;
  }

  // Terminal method
  handler<T>(handler: RouteHandler<T>): void {
    if (!handler) {
      throw new Error('Handler is required');
    }

    const completeSchema: RouteSchema = {
      ...(this.schema as RouteSchema),
      handler,
    };

    this.router.registerRoute(completeSchema);
  }
}

// ===== Unified Router =====

export class UnifiedRouter {
  private static instance: UnifiedRouter | null = null;

  private readonly poolManager = ObjectPoolManager.getInstance();

  // Route storage optimized for different access patterns
  private staticRoutes = new Map<string, InternalRoute>(); // O(1) lookup: "GET:/api/users"
  private dynamicRoutesBySegments = new Map<number, InternalRoute[]>(); // Grouped by segment count
  private fastPathRoutes = new Set<InternalRoute>(); // Routes with no middleware
  private allRoutes: InternalRoute[] = []; // For iteration/inspection

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
  };

  constructor() {
    logger.debug('UnifiedRouter initialized', 'Initialization');
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
    this.staticRoutes.clear();
    this.dynamicRoutesBySegments.clear();
    this.fastPathRoutes.clear();
    this.allRoutes = [];
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
    };
    logger.debug('UnifiedRouter routes cleared', 'Reset');
  }

  // ===== Route Registration =====

  /**
   * Register a route (internal method)
   */
  registerRoute(schema: RouteSchema): void {
    // Compile path pattern
    const compiledPath = PathMatcher.compile(schema.path);

    // Determine if this is a fast-path route
    const isFastPath = this.isFastPathRoute(schema);

    // Determine execution order
    const executionOrder = this.buildExecutionOrder(schema);

    // Pre-compile param extractor for this route (faster for 1-2 param routes)
    const paramExtractor = this.compileParamExtractor(compiledPath);

    // Store configs directly (not middleware) - router will use Core classes
    const route: InternalRoute = {
      schema,
      compiledPath,
      isFastPath,
      executionOrder,
      rateLimitConfig: schema.rateLimit,
      cacheConfig: schema.cache,
      authMiddleware: schema.auth
        ? requireAuth({
            roles: schema.auth.roles,
            permissions: schema.auth.permissions,
            allowUnauthenticated: schema.auth.optional,
          })
        : undefined,
      validationConfig: schema.validation,
      paramExtractor, // Add pre-compiled extractor
    } as any;

    // Store in appropriate structures
    if (compiledPath.isStatic) {
      const key = `${schema.method}:${schema.path}`;
      this.staticRoutes.set(key, route);
      this.stats.staticRoutes++;
    } else {
      const segmentCount = compiledPath.segments;
      let routes = this.dynamicRoutesBySegments.get(segmentCount);
      if (!routes) {
        routes = [];
        this.dynamicRoutesBySegments.set(segmentCount, routes);
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

    logger.info(
      `Registered route: ${schema.method} ${schema.path} (PID: ${process.pid}, total: ${this.stats.totalRoutes})`,
      'Registration',
      {
        isStatic: compiledPath.isStatic,
        isFastPath,
        segments: compiledPath.segments,
      }
    );
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
      const name = paramNames[0];
      return matches => ({ [name]: matches[1] });
    } else if (paramCount === 2) {
      const name1 = paramNames[0];
      const name2 = paramNames[1];
      return matches => ({ [name1]: matches[1], [name2]: matches[2] });
    } else if (paramCount === 3) {
      const name1 = paramNames[0];
      const name2 = paramNames[1];
      const name3 = paramNames[2];
      return matches => ({ [name1]: matches[1], [name2]: matches[2], [name3]: matches[3] });
    } else {
      // Generic path for 4+ params
      return matches => {
        const params: Record<string, string> = {};
        for (let i = 0; i < paramCount; i++) {
          params[paramNames[i]] = matches[i + 1];
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
    handler: RouteHandler,
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
   * Find a matching route for the request
   * Returns boolean (sync) for fast-path routes, Promise<boolean> for others
   */
  handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> | boolean {
    // PERFORMANCE: Only increment stats counter, not individual metrics in hot path
    this.stats.requestCount++;

    const method = req.method?.toUpperCase() as HttpMethod;
    const path = req.path;

    // Phase 1: No middleware, auth, validation, or rate limiting
    // Optimized for synchronous execution when possible
    if (this.fastPathRoutes.size > 0) {
      for (const route of this.fastPathRoutes) {
        if (route.schema.method === method) {
          // Inline parameter extraction for speed (avoid function call overhead)
          if (route.compiledPath.isStatic) {
            if (route.compiledPath.path === path) {
              // Static route match
              req.params = {};

              try {
                const result = route.schema.handler(req, res);

                // Check if result is a promise (optimized check)
                if (result && typeof (result as any).then === 'function') {
                  // Async handler - return promise
                  return (result as Promise<any>)
                    .then(actualResult => {
                      if (actualResult !== undefined && !res.headersSent) {
                        res.json(actualResult);
                      }
                      return true;
                    })
                    .catch(() => {
                      if (!res.headersSent) {
                        res.status(500).json({ error: 'Internal server error' });
                      }
                      return true;
                    });
                } else {
                  // Sync handler - handle synchronously (fastest path!)
                  if (result !== undefined && !res.headersSent) {
                    res.json(result);
                  }
                  return true;
                }
              } catch {
                if (!res.headersSent) {
                  res.status(500).json({ error: 'Internal server error' });
                }
                return true;
              }
            }
          } else {
            // Dynamic route - use regex matching
            const pattern = route.compiledPath.pattern;
            if (pattern) {
              const matches = path.match(pattern);
              if (matches) {
                // Use pre-compiled extractor for faster param extraction
                req.params = (route as any).paramExtractor
                  ? (route as any).paramExtractor(matches)
                  : {};

                try {
                  const result = route.schema.handler(req, res);

                  if (result && typeof (result as any).then === 'function') {
                    return (result as Promise<any>)
                      .then(actualResult => {
                        if (actualResult !== undefined && !res.headersSent) {
                          res.json(actualResult);
                        }
                        return true;
                      })
                      .catch(() => {
                        if (!res.headersSent) {
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
                } catch {
                  if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' });
                  }
                  return true;
                }
              }
            }
          }
        }
      }
    }

    // Phase 2 & 3: Non-fast-path routes (async)
    return (async () => {
      // Phase 2: O(1) static route lookup
      const staticKey = `${method}:${path}`;

      // Check pool manager cache
      const cachedRoute = this.poolManager.getCachedRoute(staticKey);
      if (cachedRoute) {
        // Re-extract params for dynamic routes (cached route might be dynamic)
        if (!cachedRoute.compiledPath.isStatic) {
          const matchResult = PathMatcher.match(cachedRoute.compiledPath, path);
          if (matchResult) {
            await this.executeRoute(cachedRoute, req, res, matchResult);
            return true;
          }
        } else {
          await this.executeRoute(cachedRoute, req, res, { params: {} });
          return true;
        }
      }

      const staticRoute = this.staticRoutes.get(staticKey);
      if (staticRoute) {
        this.poolManager.cacheRoute(staticKey, staticRoute);
        req.params = {};
        await this.executeRoute(staticRoute, req, res, { params: {} });
        return true;
      }

      // Phase 3: Segment-based dynamic route matching
      const segmentCount = PathMatcher.countSegments(path);
      const candidates = this.dynamicRoutesBySegments.get(segmentCount) || [];

      for (const route of candidates) {
        if (route.schema.method === method) {
          const matchResult = PathMatcher.match(route.compiledPath, path);
          if (matchResult) {
            this.poolManager.cacheRoute(staticKey, route);
            await this.executeRoute(route, req, res, matchResult);
            return true;
          }
        }
      }

      // No route found
      return false;
    })();
  }

  // ===== Route Execution =====

  private async executeRoute(
    route: InternalRoute,
    req: HttpRequest,
    res: HttpResponse,
    matchResult: { params: Record<string, string> }
  ): Promise<void> {
    // Set params from pool
    req.params = this.poolManager.acquireParams();
    Object.assign(req.params, matchResult.params);

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

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Internal server error',
          requestId: req.requestId,
        });
      }
    } finally {
      // Release params back to pool
      if (req.params) {
        this.poolManager.releaseParams(req.params);
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
          await this.executeMiddleware(beforeMw[i], req, res);
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
        // Auth uses middleware (from requireAuth helper)
        if (route.authMiddleware) {
          await this.executeMiddleware(route.authMiddleware, req, res);
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
          await this.executeMiddleware(transformMw[i], req, res);
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
          await this.executeMiddleware(afterMw[i], req, res);
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
          await this.executeMiddleware(middleware[i], req, res);
          if (res.headersSent) return;
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
        // Optimized: Duck typing faster than instanceof
        if (result && typeof result.then === 'function') {
          result.then(() => !resolved && next()).catch(reject);
        } else if (!resolved) {
          next();
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      }
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

  getRouteCount(): number {
    return this.stats.totalRoutes;
  }

  getStats() {
    return {
      ...this.stats,
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
