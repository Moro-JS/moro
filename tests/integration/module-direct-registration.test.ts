import { createApp, defineModule } from '../../src/index.js';
import { ModuleDefinition } from '../../src/types/module.js';

/* eslint-disable no-undef */

describe('Module Routes - Direct Registration Fix', () => {
  let app: any;
  let port: number;

  beforeEach(async () => {
    port = 3100 + Math.floor(Math.random() * 1000);
    app = await createApp({ logging: { level: 'error' } });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should register module routes in http-server route table', async () => {
    const actions = {
      testHandler: async () => {
        return {
          success: true,
          message: 'Module route in route table!',
        };
      },
    };

    const testModule: ModuleDefinition = {
      name: 'route-table-test',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: actions.testHandler,
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test request
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/route-table-test/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Module route in route table!');
  });

  it('should work with route-level middleware and plain object returns', async () => {
    const authMiddleware = async (req: any, res: any, next: any) => {
      if (!req.headers.authorization) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      req.user = { id: '123' };
      next();
    };

    const actions = {
      protectedHandler: async (req: any) => {
        return {
          success: true,
          user: req.user,
          message: 'Protected route works!',
        };
      },
    };

    const testModule: ModuleDefinition = {
      name: 'middleware-test',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/protected',
          handler: actions.protectedHandler,
          middleware: [authMiddleware],
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test without auth
    const noAuthResponse = await fetch(
      `http://localhost:${port}/api/v1.0.0/middleware-test/protected`
    );
    const noAuthData = await noAuthResponse.json();

    expect(noAuthResponse.status).toBe(401);
    expect(noAuthData.error).toBe('Unauthorized');

    // Test with auth
    const withAuthResponse = await fetch(
      `http://localhost:${port}/api/v1.0.0/middleware-test/protected`,
      {
        headers: { Authorization: 'Bearer test' },
      }
    );
    const withAuthData = await withAuthResponse.json();

    expect(withAuthResponse.status).toBe(200);
    expect(withAuthData.success).toBe(true);
    expect(withAuthData.user.id).toBe('123');
  });

  it('should work with global middleware and module routes', async () => {
    const globalMiddleware = async (req: any, res: any, next: any) => {
      req.globalData = 'from-global-middleware';
      next();
    };

    app.use(globalMiddleware);

    const actions = {
      testHandler: async (req: any) => {
        return {
          success: true,
          globalData: req.globalData,
        };
      },
    };

    const testModule: ModuleDefinition = {
      name: 'global-mw-test',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: actions.testHandler,
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    const response = await fetch(`http://localhost:${port}/api/v1.0.0/global-mw-test/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.globalData).toBe('from-global-middleware');
  });

  it('should handle compression correctly with await', async () => {
    const appWithCompression = await createApp({
      logging: { level: 'error' },
      performance: {
        compression: {
          enabled: true,
          threshold: 100, // Low threshold for testing
        },
      },
    });

    const actions = {
      largeResponse: async () => {
        // Create a response large enough to trigger compression
        return {
          success: true,
          data: 'x'.repeat(200), // 200 bytes
        };
      },
    };

    const testModule: ModuleDefinition = {
      name: 'compression-test',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/large',
          handler: actions.largeResponse,
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await appWithCompression.loadModule(moduleConfig);

    const testPort = port + 1;
    await new Promise<void>(resolve => {
      appWithCompression.listen(testPort, () => resolve());
    });

    const response = await fetch(`http://localhost:${testPort}/api/v1.0.0/compression-test/large`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.length).toBe(200);

    await appWithCompression.close();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should properly return 404 for non-existent module routes', async () => {
    const actions = {
      existingRoute: async () => {
        return { success: true };
      },
    };

    const testModule: ModuleDefinition = {
      name: '404-test',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/exists',
          handler: actions.existingRoute,
        },
      ],
    };

    const moduleConfig = defineModule(testModule);
    await app.loadModule(moduleConfig);

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test existing route
    const existsResponse = await fetch(`http://localhost:${port}/api/v1.0.0/404-test/exists`);
    expect(existsResponse.status).toBe(200);

    // Test non-existent route
    const notFoundResponse = await fetch(
      `http://localhost:${port}/api/v1.0.0/404-test/does-not-exist`
    );
    const notFoundData = await notFoundResponse.json();

    expect(notFoundResponse.status).toBe(404);
    expect(notFoundData.success).toBe(false);
    expect(notFoundData.error).toBe('Not found');
  });

  it('should handle multiple modules with different base paths', async () => {
    const module1Actions = {
      test: async () => ({ success: true, module: '1' }),
    };

    const module2Actions = {
      test: async () => ({ success: true, module: '2' }),
    };

    const module1: ModuleDefinition = {
      name: 'module1',
      version: '1.0.0',
      routes: [{ method: 'GET', path: '/test', handler: module1Actions.test }],
    };

    const module2: ModuleDefinition = {
      name: 'module2',
      version: '1.0.0',
      routes: [{ method: 'GET', path: '/test', handler: module2Actions.test }],
    };

    await app.loadModule(defineModule(module1));
    await app.loadModule(defineModule(module2));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Add delay for coverage test timing
    await new Promise(resolve => setTimeout(resolve, 100));

    // Test both modules
    const response1 = await fetch(`http://localhost:${port}/api/v1.0.0/module1/test`);
    expect(response1.status).toBe(200);
    const data1 = await response1.json();
    expect(data1.success).toBe(true);
    expect(data1.module).toBe('1');

    const response2 = await fetch(`http://localhost:${port}/api/v1.0.0/module2/test`);
    expect(response2.status).toBe(200);
    const data2 = await response2.json();
    expect(data2.success).toBe(true);
    expect(data2.module).toBe('2');
  });

  it('should handle module root path "/" without overriding app root', async () => {
    let appRootCalled = false;
    let moduleRootCalled = false;
    let moduleStatusCalled = false;

    // Register app root route first
    app.get('/', async (_req: any, res: any) => {
      appRootCalled = true;
      res.json({ success: true, message: 'App root' });
    });

    // Create health module with root path
    const healthActions = {
      rootHandler: async (_req: any, res: any) => {
        moduleRootCalled = true;
        res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString() });
      },
      statusHandler: async (_req: any, res: any) => {
        moduleStatusCalled = true;
        res.json({ success: true, status: 'ok' });
      },
    };

    const healthModule: ModuleDefinition = {
      name: 'health',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/',
          handler: healthActions.rootHandler,
        },
        {
          method: 'GET',
          path: '/status',
          handler: healthActions.statusHandler,
        },
      ],
    };

    await app.loadModule(defineModule(healthModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test app root - should NOT be overridden by module
    const appRootResponse = await fetch(`http://localhost:${port}/`);
    const appRootData = await appRootResponse.json();
    expect(appRootResponse.status).toBe(200);
    expect(appRootCalled).toBe(true);
    expect(appRootData.success).toBe(true);
    expect(appRootData.message).toBe('App root');

    // Test module root - should map to /api/v1.0.0/health
    const moduleRootResponse = await fetch(`http://localhost:${port}/api/v1.0.0/health`);
    const moduleRootData = await moduleRootResponse.json();
    expect(moduleRootResponse.status).toBe(200);
    expect(moduleRootCalled).toBe(true);
    expect(moduleRootData.success).toBe(true);
    expect(moduleRootData.status).toBe('healthy');
    expect(moduleRootData.timestamp).toBeDefined();

    // Test module status route - should map to /api/v1.0.0/health/status
    const moduleStatusResponse = await fetch(`http://localhost:${port}/api/v1.0.0/health/status`);
    const moduleStatusData = await moduleStatusResponse.json();
    expect(moduleStatusResponse.status).toBe(200);
    expect(moduleStatusCalled).toBe(true);
    expect(moduleStatusData.success).toBe(true);
    expect(moduleStatusData.status).toBe('ok');

    // Verify app root was not overridden - test again
    appRootCalled = false;
    const appRootResponse2 = await fetch(`http://localhost:${port}/`);
    const appRootData2 = await appRootResponse2.json();
    expect(appRootResponse2.status).toBe(200);
    expect(appRootCalled).toBe(true);
    expect(appRootData2.message).toBe('App root');
  });
});
