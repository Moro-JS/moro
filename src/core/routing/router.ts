// src/core/routing/router.ts
// FACADE: This class now delegates to UnifiedRouter for actual routing
// Maintains backward compatibility while using optimized implementation
import {
  HttpRequest,
  HttpResponse,
  HttpHandler,
  Middleware,
  RouteDefinition,
} from '../../types/http.js';
import { createFrameworkLogger } from '../logger/index.js';
import { UnifiedRouter } from './unified-router.js';

export class Router {
  private logger = createFrameworkLogger('Router');

  // Delegate to shared UnifiedRouter singleton for actual routing
  private unifiedRouter = UnifiedRouter.getInstance();

  // Maintain route definitions for backward compatibility (getRoutes())
  private routes: RouteDefinition[] = [];

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
    const handler = handlers.pop() as HttpHandler;
    const middleware = handlers as Middleware[];

    // Delegate to UnifiedRouter for actual routing
    this.unifiedRouter.addRoute(method as any, path, handler, middleware);

    // Keep route definition for backward compatibility (getRoutes())
    const route: RouteDefinition = {
      method,
      path,
      pattern: new RegExp(''), // Not used since we delegate
      paramNames: [],
      handler,
      middleware,
    };
    this.routes.push(route);

    this.logger.debug(`Delegated route to UnifiedRouter: ${method} ${path}`, 'Facade');
  }

  async handle(req: HttpRequest, res: HttpResponse, basePath: string = ''): Promise<boolean> {
    // Adjust path for basePath
    let path = req.path.startsWith(basePath) ? req.path.substring(basePath.length) : req.path;
    if (path === '' || path === undefined) {
      path = '/';
    }

    this.logger.debug(
      `Router delegating to UnifiedRouter: originalPath="${req.path}", basePath="${basePath}", processedPath="${path}"`,
      'Facade'
    );

    // Temporarily adjust request path for processing
    const originalPath = req.path;
    req.path = path;

    try {
      // Delegate to UnifiedRouter for actual routing
      return await this.unifiedRouter.handleRequest(req, res);
    } finally {
      // Restore original path
      req.path = originalPath;
    }
  }

  getRoutes(): RouteDefinition[] {
    // Return direct reference instead of creating defensive copy
    // Routes array is not modified externally, so copy is unnecessary overhead
    return this.routes;
  }

  // Performance statistics for monitoring (delegates to UnifiedRouter)
  getPerformanceStats() {
    return this.unifiedRouter.getStats();
  }
}
