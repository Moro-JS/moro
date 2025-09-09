import { RouteBuilder, RouteSchema, CompiledRoute } from './index';
import { HttpRequest, HttpResponse } from '../http';
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
  directRoute(method: string, path: string, handler: Function, options?: any): void;
}
export declare class RouteRegistry {
  private routes;
  private routePatterns;
  register(route: CompiledRoute): void;
  handleRequest(req: HttpRequest, res: HttpResponse): Promise<boolean>;
  getRoutes(): CompiledRoute[];
  private pathToRegex;
}
export declare class IntelligentRoutingManager implements IntelligentApp {
  private routeRegistry;
  get(path: string): RouteBuilder;
  post(path: string): RouteBuilder;
  put(path: string): RouteBuilder;
  delete(path: string): RouteBuilder;
  patch(path: string): RouteBuilder;
  head(path: string): RouteBuilder;
  options(path: string): RouteBuilder;
  route(schema: RouteSchema): CompiledRoute;
  register(route: CompiledRoute): void;
  handleIntelligentRoute(req: HttpRequest, res: HttpResponse): Promise<boolean>;
  getIntelligentRoutes(): CompiledRoute[];
  directRoute(method: string, path: string, handler: Function, options?: any): void;
  private createChainableRoute;
}
export type AppWithIntelligentRouting = IntelligentApp & {
  handleIntelligentRoute(req: HttpRequest, res: HttpResponse): Promise<boolean>;
  getIntelligentRoutes(): CompiledRoute[];
};
