/* eslint-disable no-undef */
import { createApp, defineModule } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { ModuleDefinition } from '../../src/types/module.js';

describe('Module Middleware - Integration Tests', () => {
  let app: Moro;
  let port: number;

  beforeEach(() => {
    // Use dynamic port allocation to avoid conflicts in CI
    port = 3100 + Math.floor(Math.random() * 1000);
    app = createApp({ logging: { level: 'error' } });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    // Wait a bit for port to be released in CI environments
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should execute module-level middleware before route handler', async () => {
    const executionOrder: string[] = [];

    const moduleMiddleware = (req: any, res: any, next: () => void) => {
      executionOrder.push('module-middleware');
      (req as any).fromModuleMiddleware = true;
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [moduleMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: (req: any) => {
            executionOrder.push('route-handler');
            return {
              success: true,
              hadModuleMiddleware: (req as any).fromModuleMiddleware === true,
              executionOrder,
            };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.hadModuleMiddleware).toBe(true);
    expect(data.executionOrder).toEqual(['module-middleware', 'route-handler']);
  });

  it('should execute route-level middleware after module middleware', async () => {
    const executionOrder: string[] = [];

    const moduleMiddleware = (req: any, res: any, next: () => void) => {
      executionOrder.push('module-middleware');
      next();
    };

    const routeMiddleware = (req: any, res: any, next: () => void) => {
      executionOrder.push('route-middleware');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [moduleMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: [routeMiddleware],
          handler: () => {
            executionOrder.push('route-handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = await response.json();

    expect(data.executionOrder).toEqual(['module-middleware', 'route-middleware', 'route-handler']);
  });

  it('should handle middleware that modifies request', async () => {
    const addCustomProperty = (req: any, res: any, next: () => void) => {
      (req as any).customProperty = 'custom-value';
      (req as any).middlewareTimestamp = Date.now();
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [addCustomProperty],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: (req: any) => {
            return {
              success: true,
              customProperty: (req as any).customProperty,
              hasTimestamp: !!(req as any).middlewareTimestamp,
            };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.customProperty).toBe('custom-value');
    expect(data.hasTimestamp).toBe(true);
  });

  it('should support multiple module-level middleware functions', async () => {
    const executionOrder: string[] = [];

    const middleware1 = (req: any, res: any, next: () => void) => {
      executionOrder.push('middleware-1');
      next();
    };

    const middleware2 = (req: any, res: any, next: () => void) => {
      executionOrder.push('middleware-2');
      next();
    };

    const middleware3 = (req: any, res: any, next: () => void) => {
      executionOrder.push('middleware-3');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [middleware1, middleware2, middleware3],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => {
            executionOrder.push('handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = await response.json();

    expect(data.executionOrder).toEqual([
      'middleware-1',
      'middleware-2',
      'middleware-3',
      'handler',
    ]);
  });

  it('should support mixed middleware (functions only - string resolution for simple middleware)', async () => {
    const executionOrder: string[] = [];

    const customMiddleware1 = (req: any, res: any, next: () => void) => {
      executionOrder.push('custom-middleware-1');
      next();
    };

    const customMiddleware2 = (req: any, res: any, next: () => void) => {
      executionOrder.push('custom-middleware-2');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [customMiddleware1, customMiddleware2],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => {
            executionOrder.push('handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = await response.json();

    expect(data.executionOrder).toEqual(['custom-middleware-1', 'custom-middleware-2', 'handler']);
  });

  it('should apply module middleware to all routes in the module', async () => {
    const middleware1Calls: string[] = [];

    const moduleMiddleware = (req: any, res: any, next: () => void) => {
      middleware1Calls.push(req.path);
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [moduleMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/route1',
          handler: () => ({ route: 'route1' }),
        },
        {
          method: 'GET',
          path: '/route2',
          handler: () => ({ route: 'route2' }),
        },
        {
          method: 'POST',
          path: '/route3',
          handler: () => ({ route: 'route3' }),
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    await fetch(`http://localhost:${port}/api/v1.0.0/test-module/route1`);
    await fetch(`http://localhost:${port}/api/v1.0.0/test-module/route2`);
    await fetch(`http://localhost:${port}/api/v1.0.0/test-module/route3`, { method: 'POST' });

    expect(middleware1Calls.length).toBe(3);
    expect(middleware1Calls).toContain('/api/v1.0.0/test-module/route1');
    expect(middleware1Calls).toContain('/api/v1.0.0/test-module/route2');
    expect(middleware1Calls).toContain('/api/v1.0.0/test-module/route3');
  });

  it('should handle async middleware functions', async () => {
    const executionOrder: string[] = [];

    const asyncMiddleware = async (req: any, res: any, next: () => void) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      executionOrder.push('async-middleware');
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: [asyncMiddleware],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => {
            executionOrder.push('handler');
            return { executionOrder };
          },
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = await response.json();

    expect(data.executionOrder).toEqual(['async-middleware', 'handler']);
  });
});
