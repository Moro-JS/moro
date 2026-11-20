import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { cors } from '../../../src/core/middleware/built-in/cors/hook.js';
import { createCORSMiddleware } from '../../../src/core/middleware/built-in/cors/middleware.js';
import { OriginFunction } from '../../../src/core/middleware/built-in/cors/core.js';
import { HttpRequest } from '../../../src/types/http.js';

describe('CORS Middleware', () => {
  describe('CORS Hook', () => {
    let mockHooks: any;
    let mockContext: any;

    beforeEach(() => {
      mockHooks = {
        before: jest.fn(),
      };

      mockContext = {
        request: {
          method: 'GET',
          path: '/test',
          headers: {},
        },
        response: {
          setHeader: jest.fn(),
          status: jest.fn().mockReturnThis(),
          end: jest.fn(),
          headersSent: false,
        },
      };
    });

    it('should install CORS hook and apply headers', async () => {
      const corsMiddleware = cors({
        origin: 'https://example.com',
        credentials: true,
      });

      await corsMiddleware.install(mockHooks, {});

      expect(mockHooks.before).toHaveBeenCalledWith('request', expect.any(Function));
    });

    it('should apply CORS headers to requests', async () => {
      const corsMiddleware = cors({
        origin: 'https://example.com',
        credentials: true,
      });

      await corsMiddleware.install(mockHooks, {});

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com'
      );
      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true'
      );
    });

    it('should handle OPTIONS preflight automatically', async () => {
      const corsMiddleware = cors({
        origin: 'https://example.com',
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.method = 'OPTIONS';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.status).toHaveBeenCalledWith(204);
      expect(mockContext.response.end).toHaveBeenCalled();
      expect(mockContext.response.headersSent).toBe(true);
    });

    it('should not handle OPTIONS when preflightContinue is true', async () => {
      const corsMiddleware = cors({
        origin: 'https://example.com',
        preflightContinue: true,
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.method = 'OPTIONS';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.status).not.toHaveBeenCalled();
      expect(mockContext.response.end).not.toHaveBeenCalled();
      expect(mockContext.response.headersSent).toBe(false);
    });

    it('should send only the matching origin when several are allowed', async () => {
      const corsMiddleware = cors({
        origin: ['https://example.com', 'https://app.example.com'],
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.headers.origin = 'https://app.example.com';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.example.com'
      );
      expect(mockContext.response.setHeader).toHaveBeenCalledWith('Vary', 'Origin');
    });

    it('should apply custom methods and headers', async () => {
      const corsMiddleware = cors({
        origin: '*',
        methods: ['GET', 'POST', 'PUT'],
        allowedHeaders: ['Content-Type', 'X-Custom-Header'],
      });

      await corsMiddleware.install(mockHooks, {});

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT'
      );
      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type,X-Custom-Header'
      );
    });

    it('should apply maxAge when specified', async () => {
      const corsMiddleware = cors({
        origin: '*',
        maxAge: 86400,
      });

      await corsMiddleware.install(mockHooks, {});

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Max-Age',
        '86400'
      );
    });

    it('should apply exposedHeaders when specified', async () => {
      const corsMiddleware = cors({
        origin: '*',
        exposedHeaders: ['X-Custom-Header', 'X-Another-Header'],
      });

      await corsMiddleware.install(mockHooks, {});

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Expose-Headers',
        'X-Custom-Header,X-Another-Header'
      );
    });

    it('should handle dynamic origin validation with function', async () => {
      const corsMiddleware = cors({
        origin: (origin, _req) => {
          if (origin?.endsWith('.example.com')) {
            return origin;
          }
          return false;
        },
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.headers.origin = 'https://app.example.com';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.example.com'
      );
    });

    it('should deny request when origin function returns false', async () => {
      const corsMiddleware = cors({
        origin: origin => {
          return origin === 'https://allowed.com';
        },
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.headers.origin = 'https://blocked.com';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.status).toHaveBeenCalledWith(403);
      expect(mockContext.response.end).toHaveBeenCalled();
      expect(mockContext.response.headersSent).toBe(true);
    });

    it('should support async origin validation', async () => {
      const mockOriginCheck = jest
        .fn<(origin?: string) => Promise<boolean>>()
        .mockResolvedValue(true);

      const corsMiddleware = cors({
        origin: (async (origin: string | undefined, _req: HttpRequest) => {
          const isAllowed = await mockOriginCheck(origin);
          return isAllowed ? origin : false;
        }) as OriginFunction,
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.headers.origin = 'https://test.com';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockOriginCheck).toHaveBeenCalledWith('https://test.com');
      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://test.com'
      );
    });

    it('should convert true to wildcard in origin function', async () => {
      const corsMiddleware = cors({
        origin: () => true,
      });

      await corsMiddleware.install(mockHooks, {});

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        '*'
      );
    });

    it('should support origin function returning array', async () => {
      const corsMiddleware = cors({
        origin: origin => {
          if (origin?.includes('example.com')) {
            return ['https://example.com', 'https://app.example.com'];
          }
          return false;
        },
      });

      await corsMiddleware.install(mockHooks, {});

      mockContext.request.headers.origin = 'https://example.com';

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      // One origin per header: the request's own, since it is in the list
      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com'
      );
    });
  });

  describe('CORS Standard Middleware', () => {
    let mockRequest: any;
    let mockResponse: any;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockRequest = {
        method: 'GET',
        path: '/test',
        headers: {},
      };

      mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };

      mockNext = jest.fn();
    });

    it('should apply CORS headers and call next', async () => {
      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com'
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle OPTIONS preflight automatically', async () => {
      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
      });

      mockRequest.method = 'OPTIONS';

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(204);
      expect(mockResponse.end).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should not handle OPTIONS when preflightContinue is true', async () => {
      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        preflightContinue: true,
      });

      mockRequest.method = 'OPTIONS';

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockResponse.end).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should apply default CORS settings', async () => {
      const middleware = createCORSMiddleware();

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,DELETE,OPTIONS'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization'
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle array of methods', async () => {
      const middleware = createCORSMiddleware({
        origin: '*',
        methods: ['GET', 'POST'],
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET,POST'
      );
    });

    it('should handle array of allowedHeaders', async () => {
      const middleware = createCORSMiddleware({
        origin: '*',
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-API-Key'
      );
    });

    it('should set credentials header when enabled', async () => {
      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        credentials: true,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true'
      );
    });

    it('should not set credentials header when disabled', async () => {
      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        credentials: false,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      const credentialsCalls = (mockResponse.setHeader as jest.Mock).mock.calls.filter(
        call => call[0] === 'Access-Control-Allow-Credentials'
      );

      expect(credentialsCalls.length).toBe(0);
    });

    it('should handle multiple origins with credentials by matching request origin', async () => {
      const mockRequest1 = {
        method: 'GET',
        path: '/api',
        headers: { origin: 'https://app.example.com' },
      };
      const mockResponse1 = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext1 = jest.fn();

      const middleware = createCORSMiddleware({
        origin: ['https://example.com', 'https://app.example.com', 'https://admin.example.com'],
        credentials: true,
      });

      await middleware(mockRequest1 as any, mockResponse1 as any, mockNext1);

      // Should match the request origin from the allowed list
      expect(mockResponse1.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.example.com'
      );
      expect(mockResponse1.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true'
      );
      expect(mockNext1).toHaveBeenCalled();

      // Test with a different allowed origin
      const mockRequest2 = {
        method: 'GET',
        path: '/api',
        headers: { origin: 'https://admin.example.com' },
      };
      const mockResponse2 = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext2 = jest.fn();

      await middleware(mockRequest2 as any, mockResponse2 as any, mockNext2);

      expect(mockResponse2.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://admin.example.com'
      );
      expect(mockNext2).toHaveBeenCalled();
    });

    it('should deny request when origin not in allowed list with credentials', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/api',
        headers: { origin: 'https://malicious.com' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: ['https://example.com', 'https://app.example.com'],
        credentials: true,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      // Should not call next or set origin header - request should be denied
      expect(mockNext).not.toHaveBeenCalled();
    });

    describe('several allowed origins without credentials', () => {
      const allowed = ['https://example.com', 'https://app.example.com'];

      const run = async (origin?: string) => {
        const mockRequest = {
          method: 'GET',
          path: '/api',
          headers: origin ? { origin } : {},
        };
        const headers: Record<string, string> = {};
        const mockResponse = {
          setHeader: jest.fn((name: string, value: string) => {
            headers[name] = value;
          }),
          status: jest.fn().mockReturnThis(),
          end: jest.fn(),
        };
        const mockNext = jest.fn();

        const middleware = createCORSMiddleware({ origin: allowed, credentials: false });
        await middleware(mockRequest as any, mockResponse as any, mockNext);

        return { headers, mockResponse, mockNext };
      };

      it('should send only the origin that made the request', async () => {
        const { headers, mockNext } = await run('https://app.example.com');

        expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
        expect(mockNext).toHaveBeenCalled();
      });

      it('should never send a comma-separated list', async () => {
        for (const origin of [undefined, 'https://example.com', 'https://evil.example']) {
          const { headers } = await run(origin);
          expect(headers['Access-Control-Allow-Origin'] ?? '').not.toContain(',');
        }
      });

      it('should name no origin for a request from outside the list, and should not refuse it', async () => {
        const { headers, mockResponse, mockNext } = await run('https://evil.example');

        expect(headers).not.toHaveProperty('Access-Control-Allow-Origin');
        expect(headers.Vary).toBe('Origin');
        expect(mockResponse.status).not.toHaveBeenCalled();
        expect(mockNext).toHaveBeenCalled();
      });

      it('should name no origin for a request that sends no Origin', async () => {
        const { headers, mockNext } = await run(undefined);

        expect(headers).not.toHaveProperty('Access-Control-Allow-Origin');
        expect(headers.Vary).toBe('Origin');
        expect(mockNext).toHaveBeenCalled();
      });

      it('should match a list of one origin the same way', async () => {
        const single = async (origin?: string) => {
          const headers: Record<string, string> = {};
          const res = {
            setHeader: (name: string, value: string) => {
              headers[name] = value;
            },
            status: jest.fn().mockReturnThis(),
            end: jest.fn(),
          };
          const req = { method: 'GET', path: '/api', headers: origin ? { origin } : {} };
          await createCORSMiddleware({ origin: ['https://example.com'] })(
            req as any,
            res as any,
            jest.fn()
          );
          return headers;
        };

        expect((await single('https://example.com'))['Access-Control-Allow-Origin']).toBe(
          'https://example.com'
        );
        const other = await single('https://evil.example');
        expect(other).not.toHaveProperty('Access-Control-Allow-Origin');
        expect(other.Vary).toBe('Origin');
      });
    });

    describe('Vary: Origin', () => {
      const run = async (options: any, origin?: string, existingVary?: string | string[]) => {
        const headers: Record<string, any> = {};
        if (existingVary !== undefined) headers.Vary = existingVary;
        const mockResponse = {
          setHeader: jest.fn((name: string, value: any) => {
            headers[name] = value;
          }),
          getHeader: (name: string) => headers[name],
          status: jest.fn().mockReturnThis(),
          end: jest.fn(),
        };
        const mockRequest = { method: 'GET', path: '/api', headers: origin ? { origin } : {} };

        await createCORSMiddleware(options)(mockRequest as any, mockResponse as any, jest.fn());
        return headers;
      };

      it('should be sent when the allowed origin is chosen from a list', async () => {
        const headers = await run(
          { origin: ['https://example.com', 'https://app.example.com'] },
          'https://example.com'
        );
        expect(headers.Vary).toBe('Origin');
      });

      it('should be sent when a list is matched for a credentialed response', async () => {
        const headers = await run(
          { origin: ['https://example.com'], credentials: true },
          'https://example.com'
        );
        expect(headers.Vary).toBe('Origin');
      });

      it('should be sent when the allowed origin comes from a function', async () => {
        const headers = await run(
          { origin: (origin: string | undefined) => origin || false },
          'https://example.com'
        );
        expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
        expect(headers.Vary).toBe('Origin');
      });

      it('should not be sent with a wildcard answer, even when a function produced it', async () => {
        // No Origin on the request: the function answers '*', which is the
        // same for every origin, so there is nothing for a cache to key on.
        const options = { origin: (origin: string | undefined) => origin || '*' };

        const anonymous = await run(options);
        expect(anonymous['Access-Control-Allow-Origin']).toBe('*');
        expect(anonymous.Vary).toBeUndefined();

        const named = await run(options, 'https://example.com');
        expect(named['Access-Control-Allow-Origin']).toBe('https://example.com');
        expect(named.Vary).toBe('Origin');
      });

      it('should send no CORS headers when the origin function answers with nothing', async () => {
        // A function that echoes the Origin answers undefined for a request
        // that sent none: the request goes on, and no header says "undefined".
        const echo = { origin: (origin: string | undefined) => origin };

        const sameOrigin = await run(echo);
        expect(sameOrigin['Access-Control-Allow-Origin']).toBeUndefined();
        expect(sameOrigin['Access-Control-Allow-Methods']).toBeUndefined();
        expect(sameOrigin.Vary).toBeUndefined();

        const crossOrigin = await run(echo, 'https://example.com');
        expect(crossOrigin['Access-Control-Allow-Origin']).toBe('https://example.com');
      });

      it('should not be sent on a refusal, which carries no allowed origin', async () => {
        const fromFunction = await run({ origin: () => false }, 'https://evil.example');
        expect(fromFunction['Access-Control-Allow-Origin']).toBeUndefined();
        expect(fromFunction.Vary).toBeUndefined();

        const fromList = await run(
          { origin: ['https://example.com'], credentials: true },
          'https://evil.example'
        );
        expect(fromList['Access-Control-Allow-Origin']).toBeUndefined();
        expect(fromList.Vary).toBeUndefined();
      });

      it('should be appended to a Vary header that is already set', async () => {
        const options = { origin: ['https://example.com', 'https://app.example.com'] };

        expect((await run(options, 'https://example.com', 'Accept-Encoding')).Vary).toBe(
          'Accept-Encoding, Origin'
        );
        expect((await run(options, 'https://example.com', ['Accept', 'Cookie'])).Vary).toBe(
          'Accept, Cookie, Origin'
        );
        // already there, or already "varies on everything": left as it is
        expect((await run(options, 'https://example.com', 'Accept, origin')).Vary).toBe(
          'Accept, origin'
        );
        expect((await run(options, 'https://example.com', '*')).Vary).toBe('*');
      });

      it('should not be sent when the allowed origin is the same for every request', async () => {
        expect((await run({}, 'https://example.com')).Vary).toBeUndefined();
        expect(
          (await run({ origin: 'https://example.com' }, 'https://x.example')).Vary
        ).toBeUndefined();
        expect((await run({ origin: true }, 'https://x.example')).Vary).toBeUndefined();
      });
    });

    it('should support allowedHeaders config property (alias for headers)', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/api',
        headers: {},
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
        credentials: true,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-CSRF-Token'
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle exposedHeaders config property', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/api',
        headers: {},
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        exposedHeaders: ['X-Total-Count', 'X-Page-Number', 'X-Custom-Header'],
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Expose-Headers',
        'X-Total-Count,X-Page-Number,X-Custom-Header'
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle maxAge config property', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/api',
        headers: {},
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        maxAge: 7200,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '7200');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle complete CORS config with all options', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/api',
        headers: { origin: 'https://app.example.com' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: ['https://example.com', 'https://app.example.com'],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
        exposedHeaders: ['X-Total-Count', 'X-Page-Number'],
        credentials: true,
        maxAge: 86400,
        preflightContinue: false,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.example.com'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,DELETE'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization,X-CSRF-Token'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Expose-Headers',
        'X-Total-Count,X-Page-Number'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '86400');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should allow same-origin requests without Origin header when using multiple origins with credentials', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/api',
        headers: {}, // No origin header (same-origin request)
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: ['https://example.com', 'https://app.example.com'],
        credentials: true,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      // Not a cross-origin request: it is let through, and no origin from the
      // list is named for it
      const sent = mockResponse.setHeader.mock.calls.map((call: any[]) => call[0]);
      expect(sent).not.toContain('Access-Control-Allow-Origin');
      expect(sent).not.toContain('Access-Control-Allow-Credentials');
      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('CORS Integration Scenarios', () => {
    it('should handle POST request with CORS', async () => {
      const mockRequest = { method: 'POST', path: '/api/data', headers: {} };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        credentials: true,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true'
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle OPTIONS preflight before POST', async () => {
      const mockRequest = { method: 'OPTIONS', path: '/api/data', headers: {} };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: 'https://example.com',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAge: 3600,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,DELETE'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Headers',
        'Content-Type,Authorization'
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Max-Age', '3600');
      expect(mockResponse.status).toHaveBeenCalledWith(204);
      expect(mockResponse.end).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should support dynamic origin validation in middleware', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/test',
        headers: { origin: 'https://app.trusted.com' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: origin => {
          return origin?.endsWith('.trusted.com') ? origin : false;
        },
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://app.trusted.com'
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should deny request in middleware when origin function returns false', async () => {
      const mockRequest = {
        method: 'GET',
        path: '/test',
        headers: { origin: 'https://blocked.com' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: origin => origin === 'https://allowed.com',
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.end).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should support async origin validation in middleware', async () => {
      const mockDbCheck = jest.fn<(origin?: string) => Promise<boolean>>().mockResolvedValue(true);
      const mockRequest = {
        method: 'GET',
        path: '/test',
        headers: { origin: 'https://dynamic.com' },
      };
      const mockResponse = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };
      const mockNext = jest.fn();

      const middleware = createCORSMiddleware({
        origin: (async (origin: string | undefined, _req: HttpRequest) => {
          const allowed = await mockDbCheck(origin);
          return allowed ? origin : false;
        }) as OriginFunction,
      });

      await middleware(mockRequest as any, mockResponse as any, mockNext);

      expect(mockDbCheck).toHaveBeenCalledWith('https://dynamic.com');
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://dynamic.com'
      );
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
