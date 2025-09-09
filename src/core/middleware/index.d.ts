import { EventEmitter } from 'events';
import { MiddlewareInterface, SimpleMiddlewareFunction } from '../../types/hooks';
export type { MiddlewareInterface, MoroMiddleware } from '../../types/hooks';
export declare class MiddlewareManager extends EventEmitter {
  private middleware;
  private simpleMiddleware;
  private hooks;
  private logger;
  constructor();
  register(name: string, middleware: MiddlewareInterface): void;
  install(middleware: SimpleMiddlewareFunction | MiddlewareInterface, options?: any): void;
  uninstall(name: string): void;
  getInstalled(): string[];
  getConfig(name: string): any;
  isInstalled(name: string): boolean;
  list(): MiddlewareInterface[];
  installWithDependencies(
    middleware: MiddlewareInterface[],
    options?: Record<string, any>
  ): Promise<void>;
  private topologicalSort;
}
export { builtInMiddleware, simpleMiddleware } from './built-in';
export * from './built-in';
