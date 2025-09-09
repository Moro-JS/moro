import {
  HttpRequest,
  HttpResponse,
  HttpHandler,
  Middleware,
  RouteDefinition,
} from '../../types/http';
export declare class Router {
  private routes;
  private logger;
  get(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  post(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  put(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  delete(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  patch(path: string, ...handlers: (Middleware | HttpHandler)[]): void;
  private addRoute;
  private pathToRegex;
  handle(req: HttpRequest, res: HttpResponse, basePath?: string): Promise<boolean>;
  getRoutes(): RouteDefinition[];
}
