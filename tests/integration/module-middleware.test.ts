/* eslint-disable no-undef */
import { createApp, defineModule, middleware } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { ModuleDefinition } from '../../src/types/module.js';
import { createTestPort } from '../setup.js';

describe('Module Middleware - Integration Tests', () => {
  let app: Moro;
  let port: number;

  beforeEach(async () => {
    // Use dynamic port allocation to avoid conflicts in CI
    port = createTestPort();
    app = await createApp({ logging: { level: 'error' } });
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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

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
    const data = (await response.json()) as any;

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

  it('should resolve built-in chain middleware by string name', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['helmet'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    // helmet with default options sets security headers
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('should fail closed for hook-based built-ins referenced by string name', async () => {
    // builtInMiddleware.cors is a hook-style factory (MiddlewareInterface) and
    // cannot run per-route — the request must fail rather than silently skip
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      middleware: ['cors'],
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    expect(response.status).toBe(500);
  });

  it('should resolve simple middleware by string name', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['requestLogger'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should resolve user-installed middleware from the middleware manager by name', async () => {
    let ran = false;
    function taggedMiddleware(req: any, res: any, next: () => void) {
      ran = true;
      next();
    }
    (app as any).middlewareManager.install(taggedMiddleware);

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['taggedMiddleware'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(ran).toBe(true);
  });

  it('should fail the request instead of hanging or skipping when a named middleware cannot be resolved', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: ['doesNotExist'],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Unresolvable declared middleware must fail closed (500), never run the handler
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    expect(response.status).toBe(500);
  });

  it('should throw at registration when a built-in factory is passed uncalled to app.use()', async () => {
    // app.use(middleware.helmet) — missing parens — must fail loudly, not
    // silently no-op through the app-plugin dispatch path
    await expect(app.use((middleware as any).helmet)).rejects.toThrow(/uncalled/);
  });

  it('should fail the request when a built-in factory is passed uncalled in a middleware array', async () => {
    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: [(middleware as any).helmet],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    expect(response.status).toBe(500);
  });

  it('should not hang when middleware ends the response without calling next()', async () => {
    const rejectingMiddleware = (_req: any, res: any, _next: () => void) => {
      res.status(403).json({ success: false, error: 'denied' });
    };

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          middleware: [rejectingMiddleware],
          handler: () => ({ success: true }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));
    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test`);
    const data = (await response.json()) as any;

    expect(response.status).toBe(403);
    expect(data.success).toBe(false);
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
    const data = (await response.json()) as any;

    expect(data.executionOrder).toEqual(['async-middleware', 'handler']);
  });
});
