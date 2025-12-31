import { createApp, defineModule } from '../../src/index.js';
import { Moro } from '../../src/moro.js';
import { ModuleDefinition } from '../../src/types/module.js';

describe('Module Routes - Headers Access', () => {
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

  it('should allow functional module handlers to access request headers', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedAuthHeader: string | undefined;

    const testModule: ModuleDefinition = {
      name: 'test-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/test-headers',
          handler: (req: any) => {
            // Capture headers for assertion
            capturedHeaders = req.headers;
            capturedAuthHeader = req.headers?.authorization;

            return {
              success: true,
              hasHeaders: !!req.headers,
              authorization: req.headers?.authorization,
              contentType: req.headers?.['content-type'],
              customHeader: req.headers?.['x-custom-header'],
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

    // eslint-disable-next-line no-undef
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/test-module/test-headers`, {
      headers: {
        Authorization: 'Bearer test-token-123',
        'Content-Type': 'application/json',
        'X-Custom-Header': 'custom-value',
      },
    });

    const data = await response.json();

    // Verify the response
    expect(data.success).toBe(true);
    expect(data.hasHeaders).toBe(true);
    expect(data.authorization).toBe('Bearer test-token-123');
    expect(data.contentType).toBe('application/json');
    expect(data.customHeader).toBe('custom-value');

    // Verify captured values
    expect(capturedHeaders).toBeDefined();
    expect(capturedAuthHeader).toBe('Bearer test-token-123');
  });

  it('should preserve all standard headers in module handlers', async () => {
    let receivedHeaders: any;

    const testModule: ModuleDefinition = {
      name: 'header-test',
      version: '1.0.0',
      routes: [
        {
          method: 'POST',
          path: '/check-all-headers',
          handler: (req: any) => {
            receivedHeaders = req.headers;
            return {
              headers: req.headers,
              hasHost: !!req.headers?.host,
              hasUserAgent: !!req.headers?.['user-agent'],
              hasContentType: !!req.headers?.['content-type'],
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

    // eslint-disable-next-line no-undef
    const response = await fetch(
      `http://localhost:${port}/api/v1.0.0/header-test/check-all-headers`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'test-agent',
        },
        body: JSON.stringify({ test: 'data' }),
      }
    );

    const data = await response.json();

    expect(data.hasHost).toBe(true);
    expect(data.hasUserAgent).toBe(true);
    expect(data.hasContentType).toBe(true);
    expect(receivedHeaders).toBeDefined();
    expect(typeof receivedHeaders).toBe('object');
  });

  it('should allow access to headers in routes with validation', async () => {
    const testModule: ModuleDefinition = {
      name: 'validated-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/validated',
          handler: (req: any) => {
            return {
              apiKey: req.headers?.['x-api-key'],
              hasHeaders: !!req.headers,
              allHeaderKeys: req.headers ? Object.keys(req.headers) : [],
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

    // Test with valid header
    // eslint-disable-next-line no-undef
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/validated-module/validated`, {
      headers: {
        'X-API-Key': 'secret-key',
      },
    });

    const data = await response.json();
    expect(data.apiKey).toBe('secret-key');
    expect(data.hasHeaders).toBe(true);
  });

  it('should preserve cookies and authorization headers together', async () => {
    const testModule: ModuleDefinition = {
      name: 'auth-module',
      version: '1.0.0',
      routes: [
        {
          method: 'GET',
          path: '/auth-check',
          handler: (req: any) => {
            return {
              hasAuth: !!req.headers?.authorization,
              hasCookies: !!req.cookies,
              cookieCount: Object.keys(req.cookies || {}).length,
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

    // eslint-disable-next-line no-undef
    const response = await fetch(`http://localhost:${port}/api/v1.0.0/auth-module/auth-check`, {
      headers: {
        Authorization: 'Bearer token',
        Cookie: 'session=abc123; user=test',
      },
    });

    const data = await response.json();
    expect(data.hasAuth).toBe(true);
    expect(data.hasCookies).toBe(true);
    expect(data.cookieCount).toBeGreaterThan(0);
  });
});
