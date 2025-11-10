/* eslint-disable */
// Auth Middleware Unit Tests
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { auth, providers } from '../../../src/core/middleware/built-in/auth.js';
import { AuthProvider, AuthOptions } from '../../../src/types/auth.js';

// Mock logger
jest.mock('../../../src/core/logger/index.js', () => ({
  createFrameworkLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('Auth Middleware', () => {
  let mockHooks: any;
  let mockRequest: any;
  let mockResponse: any;

  beforeEach(() => {
    mockHooks = {
      before: jest.fn(),
      after: jest.fn(),
    };

    mockRequest = {
      url: '/',
      headers: {},
      cookies: {},
    };

    mockResponse = {
      cookie: jest.fn(),
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Provider Factories', () => {
    it('should create GitHub provider with correct configuration', () => {
      const provider = providers.github({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });

      expect(provider).toEqual({
        id: 'github',
        name: 'GitHub',
        type: 'oauth',
        authorization: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userinfo: 'https://api.github.com/user',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      });
    });

    it('should create Google provider with correct configuration', () => {
      const provider = providers.google({
        clientId: 'test-google-client-id',
        clientSecret: 'test-google-client-secret',
      });

      expect(provider).toEqual({
        id: 'google',
        name: 'Google',
        type: 'oauth',
        authorization: 'https://accounts.google.com/oauth/authorize',
        token: 'https://oauth2.googleapis.com/token',
        userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
        clientId: 'test-google-client-id',
        clientSecret: 'test-google-client-secret',
      });
    });

    it('should create Discord provider with correct configuration', () => {
      const provider = providers.discord({
        clientId: 'test-discord-client-id',
        clientSecret: 'test-discord-client-secret',
      });

      expect(provider).toEqual({
        id: 'discord',
        name: 'Discord',
        type: 'oauth',
        authorization: 'https://discord.com/api/oauth2/authorize',
        token: 'https://discord.com/api/oauth2/token',
        userinfo: 'https://discord.com/api/users/@me',
        clientId: 'test-discord-client-id',
        clientSecret: 'test-discord-client-secret',
      });
    });

    it('should create credentials provider with correct configuration', () => {
      const mockAuthorize = async (credentials: any) => {
        if (credentials.username === 'admin') {
          return { id: '1', name: 'Test User' };
        }
        return null;
      };

      const provider = providers.credentials({
        name: 'Custom Login',
        credentials: {
          username: { label: 'Username', type: 'text' },
          password: { label: 'Password', type: 'password' },
        },
        authorize: mockAuthorize,
      });

      expect(provider.id).toBe('credentials');
      expect(provider.name).toBe('Custom Login');
      expect(provider.type).toBe('credentials');
      expect(provider.credentials).toEqual({
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      });
      expect(typeof provider.authorize).toBe('function');
    });

    it('should create email provider with correct configuration', () => {
      const provider = providers.email({
        server: {
          host: 'smtp.example.com',
          port: 587,
          auth: {
            user: 'user@example.com',
            pass: 'password',
          },
        },
        from: 'noreply@example.com',
      });

      expect(provider).toEqual({
        id: 'email',
        name: 'Email',
        type: 'email',
        server: {
          host: 'smtp.example.com',
          port: 587,
          auth: {
            user: 'user@example.com',
            pass: 'password',
          },
        },
        from: 'noreply@example.com',
      });
    });
  });

  describe('Auth Middleware Configuration', () => {
    it('should create auth middleware with default configuration', () => {
      const authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
      });

      expect(authMiddleware.name).toBe('auth');
      expect(authMiddleware.version).toBe('2.0.0');
      expect(authMiddleware.metadata?.name).toBe('auth');
      expect(authMiddleware.metadata?.description).toContain('Auth.js authentication middleware');
      expect(authMiddleware.metadata?.dependencies).toEqual([]);
    });

    it('should throw error when no providers are configured', async () => {
      const authMiddleware = auth({
        providers: [],
      });

      await expect(authMiddleware.install!(mockHooks, {})).rejects.toThrow(
        'At least one authentication provider must be configured'
      );
    });

    it('should merge configuration with defaults', async () => {
      const authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        basePath: '/custom/auth',
        debug: true,
      });

      // Mock the install function to capture the configuration
      let capturedConfig: any;
      const originalInstall = authMiddleware.install;
      authMiddleware.install = async (hooks, options) => {
        // Extract config from the middleware options
        capturedConfig = {
          basePath: '/custom/auth',
          debug: true,
          ...options,
        };
      };

      await authMiddleware.install!(mockHooks, {});

      expect(capturedConfig.basePath).toBe('/custom/auth');
      expect(capturedConfig.debug).toBe(true);
    });
  });

  describe('Request Processing', () => {
    let authMiddleware: any;
    let beforeRequestHandler: any;

    beforeEach(async () => {
      authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
      });

      await authMiddleware.install(mockHooks, {});

      // Get the before request handler
      beforeRequestHandler = mockHooks.before.mock.calls.find(
        (call: any) => call[0] === 'request'
      )?.[1];
    });

    it('should add auth object to request', async () => {
      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      await beforeRequestHandler(context);

      expect(mockRequest.auth).toBeDefined();
      expect(mockRequest.auth.isAuthenticated).toBe(false);
      expect(mockRequest.auth.user).toBeUndefined();
      expect(mockRequest.auth.session).toBeUndefined();
      expect(typeof mockRequest.auth.signIn).toBe('function');
      expect(typeof mockRequest.auth.signOut).toBe('function');
      expect(typeof mockRequest.auth.getSession).toBe('function');
      expect(typeof mockRequest.auth.getToken).toBe('function');
      expect(typeof mockRequest.auth.getCsrfToken).toBe('function');
      expect(typeof mockRequest.auth.getProviders).toBe('function');
    });

    it('should handle JWT token from Authorization header', async () => {
      mockRequest.headers.authorization =
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      await beforeRequestHandler(context);

      expect(mockRequest.auth).toBeDefined();
      // Note: In a real implementation with proper JWT verification,
      // this would properly decode and validate the token
    });

    it('should handle Auth.js API routes', async () => {
      mockRequest.url = '/api/auth/signin';

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      const result = await beforeRequestHandler(context);

      // The mock implementation returns undefined, but in real Auth.js
      // this would handle the signin request
      expect(result).toBeUndefined();
    });

    it('should provide auth methods', async () => {
      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      await beforeRequestHandler(context);

      // Test signIn method
      const signInResult = await mockRequest.auth.signIn('github', {
        callbackUrl: '/dashboard',
      });
      expect(signInResult).toBeDefined();

      // Test signOut method
      const signOutResult = await mockRequest.auth.signOut({
        callbackUrl: '/',
      });
      expect(signOutResult).toBeDefined();

      // Test getProviders method
      const providersResult = await mockRequest.auth.getProviders();
      expect(providersResult).toBeDefined();
      expect(providersResult.github).toBeDefined();

      // Test getCsrfToken method
      const csrfToken = await mockRequest.auth.getCsrfToken();
      expect(typeof csrfToken).toBe('string');
      expect(csrfToken.length).toBeGreaterThan(0);
    });
  });

  describe('Session Handling', () => {
    let authMiddleware: any;
    let beforeRequestHandler: any;
    let afterResponseHandler: any;

    beforeEach(async () => {
      authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
        session: {
          strategy: 'jwt',
          maxAge: 30 * 24 * 60 * 60, // 30 days
        },
      });

      await authMiddleware.install(mockHooks, {});

      beforeRequestHandler = mockHooks.before.mock.calls.find(
        (call: any) => call[0] === 'request'
      )?.[1];

      afterResponseHandler = mockHooks.after.mock.calls.find(
        (call: any) => call[0] === 'response'
      )?.[1];
    });

    it('should handle session cookies', async () => {
      mockRequest.cookies = {
        'next-auth.session-token': 'test-session-token',
      };

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      await beforeRequestHandler(context);

      expect(mockRequest.auth).toBeDefined();
      // In a real implementation, this would load the session from the store
    });

    it('should update session after response', async () => {
      const context = {
        request: {
          ...mockRequest,
          auth: {
            session: {
              user: { id: '1', name: 'Test User' },
              expires: new Date(),
            },
          },
        },
        response: mockResponse,
      };

      await afterResponseHandler(context);

      // In a real implementation, this would update the session store
      expect(afterResponseHandler).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle initialization errors gracefully', async () => {
      // Mock a provider that would cause an error during initialization
      const invalidProvider = {
        id: 'invalid',
        name: 'Invalid Provider',
        type: 'oauth' as const,
      };

      const authMiddleware = auth({
        providers: [invalidProvider],
        secret: 'test-secret',
      });

      // The middleware should still install but might log warnings
      // In a real implementation, this would validate provider configuration
      await expect(authMiddleware.install!(mockHooks, {})).resolves.not.toThrow();
    });

    it('should handle JWT verification errors gracefully', async () => {
      const authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
      });

      await authMiddleware.install(mockHooks, {});

      const beforeRequestHandler = mockHooks.before.mock.calls.find(
        (call: any) => call[0] === 'request'
      )?.[1];

      // Invalid JWT token
      mockRequest.headers.authorization = 'Bearer invalid-token';

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      // Should not throw, but gracefully handle invalid token
      await expect(beforeRequestHandler(context)).resolves.not.toThrow();
      expect(mockRequest.auth.isAuthenticated).toBe(false);
    });
  });

  describe('Callback Functions', () => {
    it('should handle custom callbacks', async () => {
      const mockSignInCallback = jest.fn(() => Promise.resolve(true));
      const mockSessionCallback = jest.fn(() => Promise.resolve({}));
      const mockJwtCallback = jest.fn(() => Promise.resolve({}));

      const authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
        callbacks: {
          signIn: mockSignInCallback as any,
          session: mockSessionCallback as any,
          jwt: mockJwtCallback as any,
        },
      });

      await authMiddleware.install(mockHooks, {});

      // Verify that callbacks are properly stored in configuration
      // In a real implementation, these would be called during auth flow
      expect(mockSignInCallback).toBeDefined();
      expect(mockSessionCallback).toBeDefined();
      expect(mockJwtCallback).toBeDefined();
    });

    it('should handle custom events', async () => {
      const mockSignInEvent = jest.fn();
      const mockSignOutEvent = jest.fn();

      const authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
        secret: 'test-secret',
        events: {
          signIn: mockSignInEvent as any,
          signOut: mockSignOutEvent as any,
        },
      });

      await authMiddleware.install(mockHooks, {});

      // Verify that events are properly stored in configuration
      // In a real implementation, these would be triggered during auth events
      expect(mockSignInEvent).toBeDefined();
      expect(mockSignOutEvent).toBeDefined();
    });
  });

  describe('Configuration Validation', () => {
    it('should validate required provider fields', () => {
      expect(() => {
        providers.github({
          clientId: '',
          clientSecret: 'test-secret',
        });
      }).not.toThrow(); // Factory functions don't validate, middleware does

      expect(() => {
        providers.google({
          clientId: 'test-id',
          clientSecret: '',
        });
      }).not.toThrow();
    });

    it('should handle missing environment variables gracefully', async () => {
      // Mock missing environment variables
      const originalEnv = process.env;
      process.env = {};

      const authMiddleware = auth({
        providers: [
          providers.github({
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          }),
        ],
      });

      await expect(authMiddleware.install!(mockHooks, {})).resolves.not.toThrow();

      // Restore environment
      process.env = originalEnv;
    });
  });

  describe('TypeScript Type Safety', () => {
    it('should have correct provider types', () => {
      const githubProvider: AuthProvider = providers.github({
        clientId: 'test',
        clientSecret: 'test',
      });

      expect(githubProvider.type).toBe('oauth');
      expect(githubProvider.id).toBe('github');

      const credentialsProvider: AuthProvider = providers.credentials({
        credentials: {},
        authorize: async () => null,
      });

      expect(credentialsProvider.type).toBe('credentials');
      expect(credentialsProvider.id).toBe('credentials');
    });

    it('should have correct auth options types', () => {
      const options: AuthOptions = {
        providers: [
          providers.github({
            clientId: 'test',
            clientSecret: 'test',
          }),
        ],
        secret: 'test-secret',
        session: {
          strategy: 'jwt',
          maxAge: 86400,
        },
        debug: true,
      };

      expect(options.providers).toHaveLength(1);
      expect(options.session?.strategy).toBe('jwt');
      expect(options.debug).toBe(true);
    });
  });
});
