// Module System - Definition and Loading
import { promises as fs } from 'fs';
import path from 'path';
import { Container } from '../utilities/index.js';
import { ModuleConfig, ModuleDefinition, ModuleRoute } from '../../types/module.js';
import { CompiledRoute } from '../routing/index.js';
import { createFrameworkLogger } from '../logger/index.js';
import { filePathToImportURL } from '../utilities/package-utils.js';

function isCompiledRoute(route: ModuleRoute | CompiledRoute): route is CompiledRoute {
  return 'schema' in route && 'execute' in route;
}

function normalizeRoute(route: ModuleRoute | CompiledRoute): ModuleRoute {
  if (!isCompiledRoute(route)) return route;
  return {
    method: route.schema.method as ModuleRoute['method'],
    path: route.schema.path,
    handler: route.schema.handler as ModuleRoute['handler'],
    ...(route.schema.validation !== undefined ? { validation: route.schema.validation } : {}),
    ...(route.schema.auth !== undefined ? { auth: route.schema.auth } : {}),
    ...(route.schema.cache !== undefined ? { cache: route.schema.cache } : {}),
    ...(route.schema.rateLimit
      ? {
          rateLimit: {
            requests: route.schema.rateLimit.requests,
            window: route.schema.rateLimit.window,
          },
        }
      : {}),
  };
}

// The keys defineModule() reads. Anything else on the definition is not copied
// to the module it returns.
const MODULE_DEFINITION_KEYS = new Set([
  'name',
  'version',
  'config',
  'routes',
  'sockets',
  'dependencies',
  'middleware',
]);
const reportedIgnoredKeys = new Set<string>();

// Name the keys defineModule() is about to leave out, once per module.
function warnIgnoredDefinitionKeys(definition: ModuleDefinition): void {
  const given = definition as unknown as Record<string, unknown>;
  const ignored = Object.keys(given).filter(
    key => !MODULE_DEFINITION_KEYS.has(key) && given[key] !== undefined
  );
  if (ignored.length === 0) return;

  const id = `${definition.name}@${definition.version}:${ignored.join(',')}`;
  if (reportedIgnoredKeys.has(id)) return;
  reportedIgnoredKeys.add(id);

  const names = ignored.map(key => `'${key}'`).join(', ');
  createFrameworkLogger('Modules').warn(
    `defineModule('${definition.name}'): ${names} ${ignored.length > 1 ? 'are' : 'is'} not read ` +
      `and ${ignored.length > 1 ? 'are' : 'is'} left out of the module. A module definition takes ` +
      'name, version, config, routes, sockets, dependencies and middleware.' +
      (ignored.includes('services')
        ? " Register services on the container instead: app.getContainer().register('name', factory)."
        : ''),
    'defineModule'
  );
}

// Module Definition Function
export function defineModule(definition: ModuleDefinition): ModuleConfig {
  warnIgnoredDefinitionKeys(definition);

  const moduleConfig: ModuleConfig = {
    name: definition.name,
    version: definition.version,
    ...(definition.dependencies !== undefined ? { dependencies: definition.dependencies } : {}),
  };

  // Store module-level middleware
  if (definition.middleware) {
    moduleConfig.middleware = definition.middleware;
  }

  // Store route definitions and handlers
  if (definition.routes) {
    const normalizedRoutes = definition.routes.map(normalizeRoute);

    moduleConfig.routes = normalizedRoutes.map((route, index) => ({
      method: route.method,
      path: route.path,
      handler: `route_handler_${index}`, // Standardized naming
      validation: route.validation,
      ...(route.cache !== undefined ? { cache: route.cache } : {}),
      ...(route.rateLimit !== undefined ? { rateLimit: route.rateLimit } : {}),
      ...(route.middleware !== undefined ? { middleware: route.middleware } : {}), // Route-level middleware
      // Copy all additional properties for extensibility
      ...Object.fromEntries(
        Object.entries(route).filter(
          ([key]) =>
            ![
              'method',
              'path',
              'handler',
              'validation',
              'cache',
              'rateLimit',
              'middleware',
            ].includes(key)
        )
      ),
    }));

    // Store the actual route handler functions
    moduleConfig.routeHandlers = normalizedRoutes.reduce(
      (acc, route, index) => {
        acc[`route_handler_${index}`] = route.handler;
        return acc;
      },
      {} as Record<string, CallableFunction>
    );
  }

  // Store socket definitions and handlers
  if (definition.sockets) {
    moduleConfig.sockets = definition.sockets.map((socket, index) => ({
      event: socket.event,
      handler: `socket_handler_${index}`, // Standardized naming
      validation: socket.validation,
      ...(socket.rateLimit !== undefined ? { rateLimit: socket.rateLimit } : {}),
      ...(socket.rooms !== undefined ? { rooms: socket.rooms } : {}),
      ...(socket.broadcast !== undefined ? { broadcast: socket.broadcast } : {}),
    }));

    // Store the actual socket handler functions
    moduleConfig.socketHandlers = definition.sockets.reduce(
      (acc, socket, index) => {
        acc[`socket_handler_${index}`] = socket.handler;
        return acc;
      },
      {} as Record<string, CallableFunction>
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
            // Convert file path to proper file URL for Windows compatibility
            const importURL = filePathToImportURL(modulePath);
            const moduleExports = await import(importURL);

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
