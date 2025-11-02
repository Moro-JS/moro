// Integration layer for intelligent routing system with main Moro app
// Provides both chainable and schema-first APIs
//
// NOTE: This is now a thin facade to UnifiedRouter
// All routing logic has been consolidated in unified-router.ts

import {
  RouteBuilder,
  RouteSchema,
  CompiledRoute,
  createRoute,
  defineRoute,
  HttpMethod,
} from './index.js';
import { HttpRequest, HttpResponse } from '../http/index.js';
import { UnifiedRouter } from './unified-router.js';
import { createFrameworkLogger } from '../logger/index.js';

const logger = createFrameworkLogger('AppIntegration');

// ===== RouteRegistry (Public API - Backward Compatibility) =====

/**
 * RouteRegistry - Facade to UnifiedRouter for backward compatibility
 * This was part of the public API, so we maintain it as an alias
 */
export class RouteRegistry {
  private router = UnifiedRouter.getInstance();

  register(_route: CompiledRoute): void {
    // Routes are automatically registered with UnifiedRouter when created
    // This is a no-op for API compatibility
  }

  async handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    return this.router.handleRequest(req, res) as Promise<boolean>;
  }

  getRoutes(): CompiledRoute[] {
    const routes = this.router.getAllRoutes();
    return routes.map(routeSchema => ({
      schema: routeSchema as RouteSchema,
      execute: async (_req: HttpRequest, _res: HttpResponse) => {
        throw new Error('CompiledRoute.execute() not used - routing handled by UnifiedRouter');
      },
    }));
  }
}

// Extended app interface with intelligent routing
export interface IntelligentApp {
  get(path: string): RouteBuilder;
  post(path: string): RouteBuilder;
  put(path: string): RouteBuilder;
  delete(path: string): RouteBuilder;
  patch(path: string): RouteBuilder;
  head(path: string): RouteBuilder;
  options(path: string): RouteBuilder;
  route(schema: RouteSchema): CompiledRoute;
  register(route: CompiledRoute): void;
  directRoute(
    method: string,
    path: string,
    handler: (req: any, res: any) => any | Promise<any>,
    options?: any
  ): void;
}

// Intelligent routing manager class
// Now a thin facade to UnifiedRouter
export class IntelligentRoutingManager implements IntelligentApp {
  private router = UnifiedRouter.getInstance();

  // Chainable route methods - delegate to createRoute
  get(path: string): RouteBuilder {
    return this.createChainableRoute('GET', path);
  }

  post(path: string): RouteBuilder {
    return this.createChainableRoute('POST', path);
  }

  put(path: string): RouteBuilder {
    return this.createChainableRoute('PUT', path);
  }

  delete(path: string): RouteBuilder {
    return this.createChainableRoute('DELETE', path);
  }

  patch(path: string): RouteBuilder {
    return this.createChainableRoute('PATCH', path);
  }

  head(path: string): RouteBuilder {
    return this.createChainableRoute('HEAD', path);
  }

  options(path: string): RouteBuilder {
    return this.createChainableRoute('OPTIONS', path);
  }

  // Schema-first route method
  route(schema: RouteSchema): CompiledRoute {
    const compiledRoute = defineRoute(schema);
    this.register(compiledRoute);
    return compiledRoute;
  }

  // Register compiled route (no-op, already registered by defineRoute)
  register(_route: CompiledRoute): void {
    // Routes are automatically registered with UnifiedRouter in defineRoute()
    // This is just for API compatibility
  }

  // Handle incoming requests - delegates to UnifiedRouter
  async handleIntelligentRoute(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    return this.router.handleRequest(req, res) as Promise<boolean>;
  }

  // Get all registered routes - fetch from UnifiedRouter
  getIntelligentRoutes(): CompiledRoute[] {
    // Convert UnifiedRouter's internal routes to CompiledRoute format for docs
    const routes = this.router.getAllRoutes();
    return routes.map(routeSchema => ({
      schema: routeSchema as RouteSchema, // Cast to match CompiledRoute interface
      execute: async (_req: HttpRequest, _res: HttpResponse) => {
        // Not used - routing handled by UnifiedRouter
        throw new Error('CompiledRoute.execute() not used - routing handled by UnifiedRouter');
      },
    }));
  }

  // Direct route method (deprecated but kept for compatibility)
  directRoute(
    method: string,
    path: string,
    handler: (req: any, res: any) => any | Promise<any>,
    options?: any
  ): void {
    logger.warn('Using deprecated direct route method', 'DirectRoute', {
      method,
      path,
      suggestion: 'Use chainable or schema-first API instead',
    });

    const schema: RouteSchema = {
      method: method.toUpperCase() as HttpMethod,
      path,
      handler: handler as any,
    };

    if (options?.validation) {
      schema.validation = { body: options.validation };
    }

    if (options?.rateLimit) {
      schema.rateLimit = options.rateLimit;
    }

    this.route(schema);
  }

  private createChainableRoute(method: HttpMethod, path: string): RouteBuilder {
    // Just create and return the builder - it auto-registers with UnifiedRouter
    return createRoute(method, path);
  }
}

// Convenience type for apps with intelligent routing
export type AppWithIntelligentRouting = IntelligentApp & {
  handleIntelligentRoute(req: HttpRequest, res: HttpResponse): Promise<boolean>;
  getIntelligentRoutes(): CompiledRoute[];
};
