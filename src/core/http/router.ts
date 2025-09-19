// src/core/router.ts
import {
  HttpRequest,
  HttpResponse,
  HttpHandler,
  Middleware,
  RouteDefinition,
} from '../../types/http';
import { createFrameworkLogger } from '../logger';

export class Router {
  private routes: RouteDefinition[] = [];
  private logger = createFrameworkLogger('Router');

  // Performance optimizations - O(1) static route lookup
  private staticRoutes = new Map<string, RouteDefinition>(); // "GET:/api/users" -> route
  private dynamicRoutes: RouteDefinition[] = []; // Routes with parameters

  // Object pooling for parameters to reduce GC pressure
  private paramObjectPool: Record<string, string>[] = [];
  private readonly maxPoolSize = 50;

  get(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('GET', path, handlers);
  }

  post(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('POST', path, handlers);
  }

  put(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('PUT', path, handlers);
  }

  delete(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('DELETE', path, handlers);
  }

  patch(path: string, ...handlers: (Middleware | HttpHandler)[]): void {
    this.addRoute('PATCH', path, handlers);
  }

  private addRoute(method: string, path: string, handlers: (Middleware | HttpHandler)[]): void {
    const { pattern, paramNames } = this.pathToRegex(path);
    const handler = handlers.pop() as HttpHandler;
    const middleware = handlers as Middleware[];

    const route: RouteDefinition = {
      method,
      path,
      pattern,
      paramNames,
      handler,
      middleware,
    };

    // Add to routes array (maintain compatibility)
    this.routes.push(route);

    // Performance optimization: separate static and dynamic routes
    const isStatic = !path.includes(':') && !path.includes('*');
    if (isStatic && middleware.length === 0) {
      // Static route with no middleware - use O(1) lookup
      const routeKey = `${method}:${path}`;
      this.staticRoutes.set(routeKey, route);
      this.logger.debug(`Added static route: ${routeKey}`, 'FastRoute');
    } else {
      // Dynamic route or has middleware - needs regex matching
      this.dynamicRoutes.push(route);
      this.logger.debug(`Added dynamic route: ${method} ${path}`, 'DynamicRoute');
    }

    // Initialize object pool on first route
    if (this.paramObjectPool.length === 0) {
      for (let i = 0; i < this.maxPoolSize; i++) {
        this.paramObjectPool.push({});
      }
    }
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    // Convert parameterized routes to regex
    const regexPattern = path
      .replace(/\/:([^/]+)/g, (match, paramName) => {
        paramNames.push(paramName);
        return '/([^/]+)';
      })
      .replace(/\//g, '\\/');

    return {
      pattern: new RegExp(`^${regexPattern}$`),
      paramNames,
    };
  }

  async handle(req: HttpRequest, res: HttpResponse, basePath: string = ''): Promise<boolean> {
    let path = req.path.startsWith(basePath) ? req.path.substring(basePath.length) : req.path;

    // If removing basePath results in empty string, default to '/'
    if (path === '' || path === undefined) {
      path = '/';
    }

    this.logger.debug(
      `Router processing: originalPath="${req.path}", basePath="${basePath}", processedPath="${path}"`,
      'Processing'
    );

    // PERFORMANCE OPTIMIZATION: Fast path - O(1) static route lookup first
    const routeKey = `${req.method}:${path}`;
    const staticRoute = this.staticRoutes.get(routeKey);

    if (staticRoute) {
      this.logger.debug(`Fast route match: ${routeKey}`, 'FastRoute');

      // Static route with no middleware - execute handler directly
      req.params = {}; // No params for static routes
      const result = await staticRoute.handler(req, res);

      // If handler returns data and response hasn't been sent, send it
      if (result !== undefined && result !== null && !res.headersSent) {
        res.json(result);
      }

      return true;
    }

    // Fallback: Dynamic route matching (with middleware support)
    const route = this.dynamicRoutes.find(r => r.method === req.method && r.pattern.test(path));

    this.logger.debug(
      `Found dynamic route: ${!!route}${route ? ` ${route.method} ${route.path}` : ' none'}`,
      'RouteMatch'
    );

    if (!route) {
      return false; // Route not found
    }

    // Extract path parameters using object pooling
    const matches = path.match(route.pattern);
    if (matches) {
      req.params = this.acquireParamObject();
      route.paramNames.forEach((name, index) => {
        req.params[name] = matches[index + 1];
      });
    }

    try {
      // Execute middleware
      for (const mw of route.middleware) {
        await new Promise<void>((resolve, reject) => {
          let nextCalled = false;

          const next = () => {
            if (nextCalled) return;
            nextCalled = true;
            resolve();
          };

          try {
            const result = mw(req, res, next);

            if (result instanceof Promise) {
              result
                .then(() => {
                  if (!nextCalled) next();
                })
                .catch(reject);
            }
          } catch (error) {
            reject(error);
          }
        });

        if (res.headersSent) break; // Early exit if response sent
      }

      // Execute handler
      const result = await route.handler(req, res);

      // If handler returns data and response hasn't been sent, send it
      if (result !== undefined && result !== null && !res.headersSent) {
        res.json(result);
      }

      return true;
    } finally {
      // Release parameter object back to pool
      if (req.params && matches) {
        this.releaseParamObject(req.params);
      }
    }
  }

  getRoutes(): RouteDefinition[] {
    return [...this.routes];
  }

  // Object pooling methods for performance optimization
  private acquireParamObject(): Record<string, string> {
    const obj = this.paramObjectPool.pop();
    if (obj) {
      // Clear the object
      for (const key in obj) {
        delete obj[key];
      }
      return obj;
    }
    return {};
  }

  private releaseParamObject(obj: Record<string, string>): void {
    if (this.paramObjectPool.length < this.maxPoolSize) {
      this.paramObjectPool.push(obj);
    }
  }

  // Performance statistics for monitoring
  getPerformanceStats() {
    return {
      totalRoutes: this.routes.length,
      staticRoutes: this.staticRoutes.size,
      dynamicRoutes: this.dynamicRoutes.length,
      paramObjectPoolSize: this.paramObjectPool.length,
    };
  }
}
