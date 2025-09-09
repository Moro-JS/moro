import { Moro as MoroCore } from './core/framework';
import { HttpRequest, HttpResponse } from './core/http';
import { ModuleConfig } from './types/module';
import { MoroOptions } from './types/core';
import { MoroEventBus } from './core/events';
import { RouteBuilder, RouteSchema, CompiledRoute } from './core/routing';
import { DocsConfig } from './core/docs';
import { EventEmitter } from 'events';
import { type AppConfig } from './core/config';
import { RuntimeAdapter, RuntimeType } from './core/runtime';
export declare class Moro extends EventEmitter {
  private coreFramework;
  private routes;
  private moduleCounter;
  private loadedModules;
  private routeHandlers;
  private eventBus;
  private logger;
  private intelligentRouting;
  private documentation;
  private config;
  private runtimeAdapter;
  private runtimeType;
  constructor(options?: MoroOptions);
  /**
   * Get configuration object
   */
  getConfig(): AppConfig;
  /**
   * Get runtime adapter
   */
  getRuntime(): RuntimeAdapter;
  /**
   * Get runtime type
   */
  getRuntimeType(): RuntimeType;
  /**
   * Extract default options from configuration
   */
  private getDefaultOptionsFromConfig;
  get(path: string): RouteBuilder;
  get(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  post(path: string): RouteBuilder;
  post(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  put(path: string): RouteBuilder;
  put(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  delete(path: string): RouteBuilder;
  delete(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  patch(path: string): RouteBuilder;
  patch(path: string, handler: (req: HttpRequest, res: HttpResponse) => any, options?: any): this;
  route(schema: RouteSchema): CompiledRoute;
  enableDocs(config: DocsConfig): void;
  getOpenAPISpec(): import('./core/docs').OpenAPISpec;
  getDocsJSON(): string;
  getDocsYAML(): string;
  refreshDocs(): void;
  use(middlewareOrFunction: any, config?: any): Promise<this>;
  plugin(middleware: any, options?: any): Promise<this>;
  loadModule(moduleOrPath: ModuleConfig | string): Promise<this>;
  database(adapter: any): this;
  websocket(namespace: string, handlers: Record<string, Function>): this;
  listen(port: number, callback?: () => void): void;
  listen(port: number, host: string, callback?: () => void): void;
  getHandler(): any;
  private handleDirectRoutes;
  private findMatchingRoute;
  private pathToRegex;
  get events(): MoroEventBus;
  get core(): MoroCore;
  private addRoute;
  private registerDirectRoutes;
  private rateLimitStore;
  private checkRateLimit;
  private setupDefaultMiddleware;
  private autoDiscoverModules;
  private importModule;
}
export declare function createApp(options?: MoroOptions): Moro;
export declare function createAppNode(options?: Omit<MoroOptions, 'runtime'>): Moro;
export declare function createAppEdge(options?: Omit<MoroOptions, 'runtime'>): Moro;
export declare function createAppLambda(options?: Omit<MoroOptions, 'runtime'>): Moro;
export declare function createAppWorker(options?: Omit<MoroOptions, 'runtime'>): Moro;
