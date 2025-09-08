// Integration layer for intelligent routing system with main Moro app
// Provides both chainable and schema-first APIs

import {
  RouteBuilder,
  RouteSchema,
  CompiledRoute,
  createRoute,
  defineRoute,
  HttpMethod,
} from "./index";
import { HttpRequest, HttpResponse } from "../http";
import { createFrameworkLogger } from "../logger";

const logger = createFrameworkLogger("AppIntegration");

// Extended app interface with intelligent routing
export interface IntelligentApp {
  // Chainable route methods
  get(path: string): RouteBuilder;
  post(path: string): RouteBuilder;
  put(path: string): RouteBuilder;
  delete(path: string): RouteBuilder;
  patch(path: string): RouteBuilder;
  head(path: string): RouteBuilder;
  options(path: string): RouteBuilder;

  // Schema-first route method
  route(schema: RouteSchema): CompiledRoute;

  // Route registration for compiled routes
  register(route: CompiledRoute): void;

  // Direct route method (deprecated)
  directRoute(
    method: string,
    path: string,
    handler: Function,
    options?: any,
  ): void;
}

// Route registry for managing compiled routes
export class RouteRegistry {
  private routes = new Map<string, CompiledRoute>();
  private routePatterns: {
    pattern: RegExp;
    route: CompiledRoute;
    method: string;
    paramNames: string[];
  }[] = [];

  register(route: CompiledRoute): void {
    const key = `${route.schema.method}:${route.schema.path}`;
    this.routes.set(key, route);

    // Convert path to regex pattern for matching
    const { pattern, paramNames } = this.pathToRegex(route.schema.path);
    this.routePatterns.push({
      pattern,
      route,
      method: route.schema.method,
      paramNames,
    });

    logger.debug(`Registered route: ${key}`, "RouteRegistry", {
      path: route.schema.path,
      hasValidation: !!route.schema.validation,
      hasAuth: !!route.schema.auth,
      hasRateLimit: !!route.schema.rateLimit,
    });
  }

  async handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    const method = req.method?.toUpperCase();
    const path = req.path;

    // Find matching route
    for (const routePattern of this.routePatterns) {
      if (routePattern.method === method && routePattern.pattern.test(path)) {
        // Extract path parameters
        const matches = path.match(routePattern.pattern);
        if (matches) {
          req.params = {};
          routePattern.paramNames.forEach((name, index) => {
            req.params[name] = matches[index + 1];
          });
        }

        // Execute the route
        await routePattern.route.execute(req, res);
        return true; // Route handled
      }
    }

    return false; // No route matched
  }

  getRoutes(): CompiledRoute[] {
    return Array.from(this.routes.values());
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    // Convert path parameters like :id to regex groups
    const regexPath = path
      .replace(/\//g, "\\/") // Escape forward slashes
      .replace(/:([^/]+)/g, (match, paramName) => {
        paramNames.push(paramName);
        return "([^/]+)"; // Match parameter value
      });

    return {
      pattern: new RegExp(`^${regexPath}$`),
      paramNames,
    };
  }
}

// Intelligent routing manager class
export class IntelligentRoutingManager implements IntelligentApp {
  private routeRegistry = new RouteRegistry();

  // Chainable route methods
  get(path: string): RouteBuilder {
    return this.createChainableRoute("GET", path);
  }

  post(path: string): RouteBuilder {
    return this.createChainableRoute("POST", path);
  }

  put(path: string): RouteBuilder {
    return this.createChainableRoute("PUT", path);
  }

  delete(path: string): RouteBuilder {
    return this.createChainableRoute("DELETE", path);
  }

  patch(path: string): RouteBuilder {
    return this.createChainableRoute("PATCH", path);
  }

  head(path: string): RouteBuilder {
    return this.createChainableRoute("HEAD", path);
  }

  options(path: string): RouteBuilder {
    return this.createChainableRoute("OPTIONS", path);
  }

  // Schema-first route method
  route(schema: RouteSchema): CompiledRoute {
    const compiledRoute = defineRoute(schema);
    this.register(compiledRoute);
    return compiledRoute;
  }

  // Register compiled route
  register(route: CompiledRoute): void {
    this.routeRegistry.register(route);
  }

  // Handle incoming requests with intelligent routing
  async handleIntelligentRoute(
    req: HttpRequest,
    res: HttpResponse,
  ): Promise<boolean> {
    return await this.routeRegistry.handleRequest(req, res);
  }

  // Get all registered routes (useful for debugging/docs)
  getIntelligentRoutes(): CompiledRoute[] {
    return this.routeRegistry.getRoutes();
  }

  // Direct route method (deprecated)
  directRoute(
    method: string,
    path: string,
    handler: Function,
    options?: any,
  ): void {
    logger.warn("Using deprecated direct route method", "DirectRoute", {
      method,
      path,
      suggestion: "Use chainable or schema-first API instead",
    });

    // Convert direct options to new schema format
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
    const builder = createRoute(method, path);

    // Override the handler method to auto-register the route
    const originalHandler = builder.handler.bind(builder);
    builder.handler = <T>(handler: any) => {
      const compiledRoute = originalHandler(handler);
      this.register(compiledRoute);
      return compiledRoute;
    };

    return builder;
  }
}

// Convenience type for apps with intelligent routing
export type AppWithIntelligentRouting = IntelligentApp & {
  handleIntelligentRoute(req: HttpRequest, res: HttpResponse): Promise<boolean>;
  getIntelligentRoutes(): CompiledRoute[];
};
