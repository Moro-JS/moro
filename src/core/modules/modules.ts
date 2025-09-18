// Module System - Definition and Loading
import { promises as fs } from 'fs';
import path from 'path';
import { Container } from '../utilities';
import { ModuleConfig } from '../../types/module';
import { ModuleDefinition, ModuleRoute, ModuleSocket } from '../../types/module';
import { createFrameworkLogger } from '../logger';

// Module Definition Function
export function defineModule(definition: ModuleDefinition): ModuleConfig {
  const moduleConfig: ModuleConfig = {
    name: definition.name,
    version: definition.version,
    dependencies: definition.dependencies,
  };

  // Store route definitions and handlers
  if (definition.routes) {
    moduleConfig.routes = definition.routes.map((route, index) => ({
      method: route.method,
      path: route.path,
      handler: `route_handler_${index}`, // Standardized naming
      validation: route.validation,
      cache: route.cache,
      rateLimit: route.rateLimit,
      middleware: route.middleware,
    }));

    // Store the actual route handler functions
    moduleConfig.routeHandlers = definition.routes.reduce(
      (acc, route, index) => {
        acc[`route_handler_${index}`] = route.handler;
        return acc;
      },
      {} as Record<string, Function>
    );
  }

  // Store socket definitions and handlers
  if (definition.sockets) {
    moduleConfig.sockets = definition.sockets.map((socket, index) => ({
      event: socket.event,
      handler: `socket_handler_${index}`, // Standardized naming
      validation: socket.validation,
      rateLimit: socket.rateLimit,
      rooms: socket.rooms,
      broadcast: socket.broadcast,
    }));

    // Store the actual socket handler functions
    moduleConfig.socketHandlers = definition.sockets.reduce(
      (acc, socket, index) => {
        acc[`socket_handler_${index}`] = socket.handler;
        return acc;
      },
      {} as Record<string, Function>
    );
  }

  // Copy config
  if (definition.config) {
    moduleConfig.config = definition.config;
  }

  return moduleConfig;
}

// Module Loader Class
export class ModuleLoader {
  private moduleLogger = createFrameworkLogger('MODULE_LOADER');

  constructor(private container: Container) {}

  async discoverModules(directory: string): Promise<ModuleConfig[]> {
    const modules: ModuleConfig[] = [];

    try {
      const moduleDir = path.resolve(directory);
      const entries = await fs.readdir(moduleDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const modulePath = path.join(moduleDir, entry.name, 'index.ts');

          try {
            await fs.access(modulePath);
            const moduleExports = await import(modulePath);

            // Look for exported module config
            for (const exportName of Object.keys(moduleExports)) {
              const exported = moduleExports[exportName];
              if (exported && typeof exported === 'object' && exported.name && exported.version) {
                modules.push(exported as ModuleConfig);
              }
            }
          } catch (error) {
            this.moduleLogger.warn(`Could not load module from ${modulePath}`, 'MODULE_LOADER', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch (error) {
      this.moduleLogger.error('Failed to discover modules', 'MODULE_LOADER', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return modules;
  }

  validateModule(config: ModuleConfig): boolean {
    if (!config.name || !config.version) {
      return false;
    }

    // [TODO] Add more validation logic here
    return true;
  }
}
