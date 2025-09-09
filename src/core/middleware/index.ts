// Middleware System for Moro
import { EventEmitter } from 'events';
import { HookManager } from '../utilities';
import {
  MiddlewareMetadata,
  MiddlewareContext,
  MiddlewareInterface,
  SimpleMiddlewareFunction,
  MoroMiddleware,
} from '../../types/hooks';
import { createFrameworkLogger } from '../logger';

// Export types needed by built-in middleware
export type { MiddlewareInterface, MoroMiddleware } from '../../types/hooks';

export class MiddlewareManager extends EventEmitter {
  private middleware = new Map<string, MiddlewareInterface>();
  private simpleMiddleware = new Map<string, SimpleMiddlewareFunction>();
  private hooks: HookManager;
  private logger = createFrameworkLogger('Middleware');

  constructor() {
    super();
    this.hooks = new HookManager();
  }

  // Register middleware without installing
  register(name: string, middleware: MiddlewareInterface): void {
    if (this.middleware.has(name)) {
      throw new Error(`Middleware ${name} is already registered`);
    }

    this.middleware.set(name, middleware);
    this.logger.debug(`Registered middleware: ${name}`, 'Registration');
    this.emit('registered', { name, middleware });
  }

  // Install simple function-style middleware
  install(middleware: SimpleMiddlewareFunction | MiddlewareInterface, options: any = {}): void {
    if (typeof middleware === 'function') {
      // Simple function-style middleware
      const simpleName = middleware.name || 'anonymous';
      this.logger.debug(`Installing simple middleware: ${simpleName}`, 'Installation');

      this.simpleMiddleware.set(simpleName, middleware);
      this.emit('installed', { name: simpleName, type: 'simple' });
      this.logger.info(`Simple middleware installed: ${simpleName}`, 'Installation');
      return;
    }

    // Advanced middleware with dependencies and lifecycle
    const name = middleware.metadata?.name || 'unknown';

    if (this.middleware.has(name)) {
      throw new Error(`Middleware ${name} is already installed`);
    }

    // Check dependencies
    if (middleware.metadata?.dependencies) {
      for (const dep of middleware.metadata.dependencies) {
        if (!this.middleware.has(dep)) {
          throw new Error(`Dependency ${dep} not found for middleware ${name}`);
        }
      }
    }

    // Store middleware
    this.middleware.set(name, middleware);

    this.logger.debug(`Installing middleware: ${name}`, 'Installation');

    // Initialize middleware
    if (middleware.install) {
      middleware.install(this.hooks, options);
    }

    this.emit('installed', { name, middleware, options });
    this.logger.info(`Middleware installed: ${name}`, 'Installation');
  }

  // Uninstall middleware and clean up
  uninstall(name: string): void {
    if (!this.middleware.has(name)) {
      throw new Error(`Middleware ${name} is not installed`);
    }

    const middleware = this.middleware.get(name)!;

    this.logger.debug(`Uninstalling middleware: ${name}`, 'Uninstallation');

    // Call cleanup if available
    if (middleware.uninstall) {
      middleware.uninstall(this.hooks);
    }

    this.middleware.delete(name);
    this.emit('uninstalled', { name, middleware });
    this.logger.info(`Middleware uninstalled: ${name}`, 'Uninstallation');
  }

  // Get installed middleware
  getInstalled(): string[] {
    return Array.from(this.middleware.keys());
  }

  // Get middleware configuration
  getConfig(name: string): any {
    return this.middleware.get(name)?.metadata;
  }

  // Check if middleware is installed
  isInstalled(name: string): boolean {
    return this.middleware.has(name);
  }

  // List all registered middleware
  list(): MiddlewareInterface[] {
    return Array.from(this.middleware.values());
  }

  // Dependency resolution with topological sorting for optimal middleware loading
  async installWithDependencies(
    middleware: MiddlewareInterface[],
    options?: Record<string, any>
  ): Promise<void> {
    // Advanced topological sort for dependency resolution
    const resolved = this.topologicalSort(middleware);

    for (const middlewareItem of resolved) {
      const middlewareOptions = options?.[middlewareItem.name];
      await this.install(middlewareItem, middlewareOptions);
    }
  }

  // Optimized topological sort implementation for middleware dependencies
  private topologicalSort(middleware: MiddlewareInterface[]): MiddlewareInterface[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const result: MiddlewareInterface[] = [];

    const visit = (middlewareItem: MiddlewareInterface) => {
      if (temp.has(middlewareItem.name)) {
        throw new Error(`Circular dependency detected: ${middlewareItem.name}`);
      }

      if (!visited.has(middlewareItem.name)) {
        temp.add(middlewareItem.name);

        // Visit dependencies first
        if (middlewareItem.dependencies) {
          for (const depName of middlewareItem.dependencies) {
            const dependency = middleware.find(m => m.name === depName);
            if (dependency) {
              visit(dependency);
            }
          }
        }

        temp.delete(middlewareItem.name);
        visited.add(middlewareItem.name);
        result.push(middlewareItem);
      }
    };

    for (const middlewareItem of middleware) {
      if (!visited.has(middlewareItem.name)) {
        visit(middlewareItem);
      }
    }

    return result;
  }
}

// Built-in middleware exports
export { builtInMiddleware, simpleMiddleware } from './built-in';
export * from './built-in';
