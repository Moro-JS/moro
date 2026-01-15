import { createApp, defineModule, resetConfig } from '../../src/index.js';
import { ModuleDefinition } from '../../src/types/module.js';

/* eslint-disable no-undef */

describe('Module API Prefix Configuration', () => {
  let app: any;
  let port: number;

  beforeEach(() => {
    port = 3100 + Math.floor(Math.random() * 1000);
    // Reset config before each test to allow different configurations
    resetConfig();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should use default /api/ prefix when no config provided', async () => {
    app = createApp({ logging: { level: 'error' } });

    const testModule: ModuleDefinition = {
      name: 'default-prefix',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: async () => ({
            success: true,
            message: 'Default prefix works',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Should work with default /api/ prefix
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/default-prefix/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Default prefix works');
  });

  it('should remove prefix when apiPrefix is empty string', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '',
      },
    });

    const testModule: ModuleDefinition = {
      name: 'no-prefix',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: async () => ({
            success: true,
            message: 'No prefix works',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Should work without /api/ prefix
    const response = await fetch(`http://localhost:${port}/v1.0.0/no-prefix/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('No prefix works');

    // Should NOT work with /api/ prefix
    const wrongResponse = await fetch(`http://localhost:${port}/api/v1.0.0/no-prefix/test`);
    expect(wrongResponse.status).toBe(404);
  });

  it('should use custom apiPrefix when configured', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '/services/',
      },
    });

    const testModule: ModuleDefinition = {
      name: 'custom-prefix',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: async () => ({
            success: true,
            message: 'Custom prefix works',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Should work with custom /services/ prefix
    const response = await fetch(`http://localhost:${port}/services/v1.0.0/custom-prefix/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Custom prefix works');

    // Should NOT work with default /api/ prefix
    const wrongResponse = await fetch(`http://localhost:${port}/api/v1.0.0/custom-prefix/test`);
    expect(wrongResponse.status).toBe(404);
  });

  it('should normalize trailing slash in custom prefix', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '/v1',
      },
    });

    const testModule: ModuleDefinition = {
      name: 'normalize-test',
      version: '2.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: async () => ({
            success: true,
            message: 'Normalized prefix works',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Should work with normalized path
    const response = await fetch(`http://localhost:${port}/v1/v2.0.0/normalize-test/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Normalized prefix works');
  });

  it('should work with multiple modules using same apiPrefix', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '/rest/',
      },
    });

    const module1: ModuleDefinition = {
      name: 'users',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/list',
          handler: async () => ({
            success: true,
            module: 'users',
          }),
        },
      ],
    };

    const module2: ModuleDefinition = {
      name: 'products',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/list',
          handler: async () => ({
            success: true,
            module: 'products',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(module1));
    await app.loadModule(defineModule(module2));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test both modules with custom prefix
    const response1 = await fetch(`http://localhost:${port}/rest/v1.0.0/users/list`);
    const data1 = await response1.json();
    expect(response1.status).toBe(200);
    expect(data1.module).toBe('users');

    const response2 = await fetch(`http://localhost:${port}/rest/v1.0.0/products/list`);
    const data2 = await response2.json();
    expect(response2.status).toBe(200);
    expect(data2.module).toBe('products');
  });

  it('should work with different versions and custom prefix', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '/v1/',
      },
    });

    const moduleV1: ModuleDefinition = {
      name: 'admin',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/users',
          handler: async () => ({
            success: true,
            version: '1.0.0',
          }),
        },
      ],
    };

    const moduleV2: ModuleDefinition = {
      name: 'admin',
      version: '2.0.0',
      routes: [
        {
          method: 'GET',
          path: '/users',
          handler: async () => ({
            success: true,
            version: '2.0.0',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(moduleV1));
    await app.loadModule(defineModule(moduleV2));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test both versions
    const responseV1 = await fetch(`http://localhost:${port}/v1/v1.0.0/admin/users`);
    const dataV1 = await responseV1.json();
    expect(responseV1.status).toBe(200);
    expect(dataV1.version).toBe('1.0.0');

    const responseV2 = await fetch(`http://localhost:${port}/v1/v2.0.0/admin/users`);
    const dataV2 = await responseV2.json();
    expect(responseV2.status).toBe(200);
    expect(dataV2.version).toBe('2.0.0');
  });

  it('should work with no prefix and nested routes', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '',
      },
    });

    const testModule: ModuleDefinition = {
      name: 'api',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/users/:id',
          handler: async (req: any) => ({
            success: true,
            userId: req.params.id,
          }),
        },
        {
          method: 'POST',
          path: '/users/:id/posts',
          handler: async (req: any) => ({
            success: true,
            userId: req.params.id,
            action: 'create-post',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test nested routes without prefix
    const response1 = await fetch(`http://localhost:${port}/v1.0.0/api/users/123`);
    const data1 = await response1.json();
    expect(response1.status).toBe(200);
    expect(data1.userId).toBe('123');

    const response2 = await fetch(`http://localhost:${port}/v1.0.0/api/users/456/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test' }),
    });
    const data2 = await response2.json();
    expect(response2.status).toBe(200);
    expect(data2.userId).toBe('456');
    expect(data2.action).toBe('create-post');
  });

  it('should work with custom prefix and middleware', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '/backend/',
      },
    });

    const authMiddleware = async (req: any, res: any, next: any) => {
      if (!req.headers.authorization) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      req.user = { id: 'test-user' };
      next();
    };

    const testModule: ModuleDefinition = {
      name: 'secure',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/data',
          middleware: [authMiddleware],
          handler: async (req: any) => ({
            success: true,
            user: req.user,
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test without auth
    const noAuthResponse = await fetch(`http://localhost:${port}/backend/v1.0.0/secure/data`);
    expect(noAuthResponse.status).toBe(401);

    // Test with auth
    const withAuthResponse = await fetch(`http://localhost:${port}/backend/v1.0.0/secure/data`, {
      headers: { Authorization: 'Bearer token' },
    });
    const data = await withAuthResponse.json();
    expect(withAuthResponse.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.user.id).toBe('test-user');
  });

  it('should handle root path routes with custom prefix', async () => {
    app = createApp({
      logging: { level: 'error' },
      modules: {
        apiPrefix: '/api/',
      },
    });

    const testModule: ModuleDefinition = {
      name: 'health',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/status',
          handler: async () => ({
            success: true,
            status: 'healthy',
          }),
        },
      ],
    };

    await app.loadModule(defineModule(testModule));

    await new Promise<void>(resolve => {
      app.listen(port, () => resolve());
    });

    // Test with default prefix
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/health/status`);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe('healthy');
  });
});
