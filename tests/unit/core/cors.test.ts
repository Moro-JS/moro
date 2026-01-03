/* eslint-disable no-unused-vars */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { cors } from '../../../src/core/middleware/built-in/cors/hook.js';
import { createCORSMiddleware } from '../../../src/core/middleware/built-in/cors/middleware.js';

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

    it('should handle multiple origins', async () => {
      const corsMiddleware = cors({
        origin: ['https://example.com', 'https://app.example.com'],
      });

      await corsMiddleware.install(mockHooks, {});

      const hookHandler = mockHooks.before.mock.calls[0][1];
      await hookHandler(mockContext);

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com,https://app.example.com'
      );
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
      const mockOriginCheck = jest.fn().mockResolvedValue(true);

      const corsMiddleware = cors({
        origin: async (origin, _req) => {
          const isAllowed = await mockOriginCheck(origin);
          return isAllowed ? origin : false;
        },
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

      expect(mockContext.response.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com,https://app.example.com'
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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

      expect(mockResponse.status).not.toHaveBeenCalled();
      expect(mockResponse.end).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should apply default CORS settings', async () => {
      const middleware = createCORSMiddleware();

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest1, mockResponse1, mockNext1);

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

      await middleware(mockRequest2, mockResponse2, mockNext2);

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

      await middleware(mockRequest, mockResponse, mockNext);

      // Should not call next or set origin header - request should be denied
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow comma-separated origins when credentials is false', async () => {
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
        origin: ['https://example.com', 'https://app.example.com'],
        credentials: false,
      });

      await middleware(mockRequest, mockResponse, mockNext);

      // Without credentials, should join with comma (though not ideal)
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://example.com,https://app.example.com'
      );
      expect(mockNext).toHaveBeenCalled();
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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

      // Should use first origin in list for same-origin requests
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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

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

      await middleware(mockRequest, mockResponse, mockNext);

      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.end).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should support async origin validation in middleware', async () => {
      const mockDbCheck = jest.fn().mockResolvedValue(true);
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
        origin: async (origin, _req) => {
          const allowed = await mockDbCheck(origin);
          return allowed ? origin : false;
        },
      });

      await middleware(mockRequest, mockResponse, mockNext);

      expect(mockDbCheck).toHaveBeenCalledWith('https://dynamic.com');
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'https://dynamic.com'
      );
      expect(mockNext).toHaveBeenCalled();
    });
  });
});
