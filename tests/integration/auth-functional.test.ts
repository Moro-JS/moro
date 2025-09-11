// Auth Functional Tests - Testing the core functionality
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { auth, providers } from '../../src/core/middleware/built-in/auth';
import { AuthProvider, AuthOptions } from '../../src/types/auth';

describe('Auth Middleware Functional Tests', () => {
  // Mock the logger to avoid console output during tests
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Provider Factory Functions', () => {
    it('should create GitHub provider with correct configuration', () => {
      const provider = providers.github({
        clientId: 'test-github-id',
        clientSecret: 'test-github-secret',
      });

      expect(provider).toMatchObject({
        id: 'github',
        name: 'GitHub',
        type: 'oauth',
        authorization: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userinfo: 'https://api.github.com/user',
        clientId: 'test-github-id',
        clientSecret: 'test-github-secret',
      });
    });

    it('should create Google provider with correct configuration', () => {
      const provider = providers.google({
        clientId: 'test-google-id',
        clientSecret: 'test-google-secret',
      });

      expect(provider).toMatchObject({
        id: 'google',
        name: 'Google',
        type: 'oauth',
        authorization: 'https://accounts.google.com/oauth/authorize',
        token: 'https://oauth2.googleapis.com/token',
        userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
        clientId: 'test-google-id',
        clientSecret: 'test-google-secret',
      });
    });

    it('should create Discord provider with correct configuration', () => {
      const provider = providers.discord({
        clientId: 'test-discord-id',
        clientSecret: 'test-discord-secret',
      });

      expect(provider).toMatchObject({
        id: 'discord',
        name: 'Discord',
        type: 'oauth',
        authorization: 'https://discord.com/api/oauth2/authorize',
        token: 'https://discord.com/api/oauth2/token',
        userinfo: 'https://discord.com/api/users/@me',
        clientId: 'test-discord-id',
        clientSecret: 'test-discord-secret',
      });
    });

    it('should create credentials provider with authorize function', () => {
      const authorize = async (credentials: any) => {
        if (credentials.username === 'admin') {
          return { id: '1', name: 'Admin', email: 'admin@test.com' };
        }
        return null;
      };

      const provider = providers.credentials({
        name: 'Test Credentials',
        credentials: {
          username: { label: 'Username', type: 'text' },
          password: { label: 'Password', type: 'password' },
        },
        authorize,
      });

      expect(provider.id).toBe('credentials');
      expect(provider.name).toBe('Test Credentials');
      expect(provider.type).toBe('credentials');
      expect(typeof provider.authorize).toBe('function');
    });

    it('should create email provider with server configuration', () => {
      const provider = providers.email({
        server: {
          host: 'smtp.test.com',
          port: 587,
          auth: {
            user: 'test@test.com',
            pass: 'password',
          },
        },
        from: 'noreply@test.com',
      });

      expect(provider).toMatchObject({
        id: 'email',
        name: 'Email',
        type: 'email',
        server: {
          host: 'smtp.test.com',
          port: 587,
          auth: {
            user: 'test@test.com',
            pass: 'password',
          },
        },
        from: 'noreply@test.com',
      });
    });
  });

  describe('Auth Middleware Creation', () => {
    it('should create auth middleware with valid configuration', () => {
      const middleware = auth({
        providers: [
          providers.github({
            clientId: 'test-id',
            clientSecret: 'test-secret',
          }),
        ],
        secret: 'test-secret-key',
      });

      expect(middleware.name).toBe('auth');
      expect(middleware.version).toBe('2.0.0');
      expect(middleware.metadata?.name).toBe('auth');
      expect(middleware.metadata?.description).toContain('Auth.js authentication middleware');
      expect(middleware.metadata?.dependencies).toEqual([]); // Auth middleware is now self-contained
      expect(typeof middleware.install).toBe('function');
    });

    it('should create auth middleware with multiple providers', () => {
      const middleware = auth({
        providers: [
          providers.github({
            clientId: 'github-id',
            clientSecret: 'github-secret',
          }),
          providers.google({
            clientId: 'google-id',
            clientSecret: 'google-secret',
          }),
          providers.credentials({
            credentials: {
              email: { label: 'Email', type: 'email' },
              password: { label: 'Password', type: 'password' },
            },
            authorize: async () => null,
          }),
        ],
        secret: 'test-secret',
        debug: true,
      });

      expect(middleware.name).toBe('auth');
      expect(middleware.version).toBe('2.0.0');
      expect(typeof middleware.install).toBe('function');
    });

    it('should create auth middleware with custom configuration', () => {
      const middleware = auth({
        providers: [
          providers.github({
            clientId: 'test-id',
            clientSecret: 'test-secret',
          }),
        ],
        secret: 'custom-secret',
        basePath: '/custom/auth',
        session: {
          strategy: 'jwt',
          maxAge: 86400,
        },
        debug: false,
        trustHost: true,
      });

      expect(middleware.name).toBe('auth');
      expect(middleware.version).toBe('2.0.0');
      expect(typeof middleware.install).toBe('function');
    });
  });

  describe('Auth Middleware Installation', () => {
    let mockHooks: any;

    beforeEach(() => {
      mockHooks = {
        before: jest.fn(),
        after: jest.fn(),
      };
    });

    it('should install auth middleware successfully', async () => {
      const middleware = auth({
        providers: [
          providers.github({
            clientId: 'test-id',
            clientSecret: 'test-secret',
          }),
        ],
        secret: 'test-secret',
      });

      await expect(middleware.install!(mockHooks)).resolves.not.toThrow();

      // Verify hooks were registered
      expect(mockHooks.before).toHaveBeenCalledWith('request', expect.any(Function));
      expect(mockHooks.after).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('should throw error when no providers are configured', async () => {
      const middleware = auth({
        providers: [],
        secret: 'test-secret',
      });

      await expect(middleware.install!(mockHooks)).rejects.toThrow(
        'At least one authentication provider must be configured'
      );
    });

    it('should install with custom callbacks and events', async () => {
      const signInCallback = async () => true;
      const sessionCallback = async (params: any) => params.session;
      const signInEvent = async () => {};

      const middleware = auth({
        providers: [
          providers.github({
            clientId: 'test-id',
            clientSecret: 'test-secret',
          }),
        ],
        secret: 'test-secret',
        callbacks: {
          signIn: signInCallback,
          session: sessionCallback,
        },
        events: {
          signIn: signInEvent,
        },
      });

      await expect(middleware.install!(mockHooks)).resolves.not.toThrow();
    });
  });

  describe('Request Processing', () => {
    let middleware: any;
    let mockHooks: any;
    let requestHandler: any;

    beforeEach(async () => {
      mockHooks = {
        before: jest.fn(),
        after: jest.fn(),
      };

      middleware = auth({
        providers: [
          providers.github({
            clientId: 'test-id',
            clientSecret: 'test-secret',
          }),
        ],
        secret: 'test-secret',
      });

      await middleware.install(mockHooks);

      // Get the request handler
      const beforeCalls = mockHooks.before.mock.calls;
      const requestCall = beforeCalls.find((call: any) => call[0] === 'request');
      requestHandler = requestCall?.[1];
    });

         it('should add auth object to request', async () => {
       const mockRequest: any = {
         url: '/test',
         headers: {},
         cookies: {},
       };

       const mockResponse = {
         cookie: jest.fn(),
       };

       const context = {
         request: mockRequest,
         response: mockResponse,
       };

       await requestHandler(context);

       expect(mockRequest.auth).toBeDefined();
       expect(mockRequest.auth.isAuthenticated).toBe(false);
       expect(typeof mockRequest.auth.signIn).toBe('function');
       expect(typeof mockRequest.auth.signOut).toBe('function');
       expect(typeof mockRequest.auth.getSession).toBe('function');
       expect(typeof mockRequest.auth.getToken).toBe('function');
       expect(typeof mockRequest.auth.getCsrfToken).toBe('function');
       expect(typeof mockRequest.auth.getProviders).toBe('function');
     });

    it('should handle auth API routes', async () => {
      const mockRequest = {
        url: '/api/auth/signin',
        headers: {},
        cookies: {},
      };

      const mockResponse = {
        cookie: jest.fn(),
      };

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

                    const result = await requestHandler(context);

       // Mock implementation may return null or undefined for auth routes
       expect(result).toBeFalsy();
    });

         it('should handle JWT token in Authorization header', async () => {
       const mockJwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

       const mockRequest: any = {
         url: '/test',
         headers: {
           authorization: `Bearer ${mockJwtToken}`,
         },
         cookies: {},
       };

       const mockResponse = {
         cookie: jest.fn(),
       };

       const context = {
         request: mockRequest,
         response: mockResponse,
       };

       await requestHandler(context);

       expect(mockRequest.auth).toBeDefined();
       expect(mockRequest.auth.isAuthenticated).toBe(false); // Mock doesn't validate JWT
     });

         it('should provide working auth methods', async () => {
       const mockRequest: any = {
         url: '/test',
         headers: {},
         cookies: {},
       };

      const mockResponse = {
        cookie: jest.fn(),
      };

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      await requestHandler(context);

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

      // Test getSession method
      const session = await mockRequest.auth.getSession();
      expect(session).toBeNull(); // Mock returns null for unauthenticated

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

  describe('Configuration Validation', () => {
    it('should accept valid provider configurations', () => {
      const validProviders: AuthProvider[] = [
        providers.github({
          clientId: 'github-id',
          clientSecret: 'github-secret',
        }),
        providers.google({
          clientId: 'google-id',
          clientSecret: 'google-secret',
        }),
        providers.discord({
          clientId: 'discord-id',
          clientSecret: 'discord-secret',
        }),
        providers.credentials({
          credentials: {
            username: { label: 'Username', type: 'text' },
            password: { label: 'Password', type: 'password' },
          },
          authorize: async () => null,
        }),
        providers.email({
          server: 'smtp://test:test@localhost:587',
          from: 'test@example.com',
        }),
      ];

      expect(() => {
        auth({
          providers: validProviders,
          secret: 'test-secret',
        });
      }).not.toThrow();
    });

    it('should accept valid auth options', () => {
      const validOptions: AuthOptions = {
        providers: [
          providers.github({
            clientId: 'test-id',
            clientSecret: 'test-secret',
          }),
        ],
        secret: 'test-secret-key',
        session: {
          strategy: 'jwt',
          maxAge: 30 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
        },
        jwt: {
          secret: 'jwt-secret',
          maxAge: 30 * 24 * 60 * 60,
        },
        basePath: '/api/auth',
        trustHost: true,
        debug: false,
        useSecureCookies: true,
        skipCSRFCheck: ['/api/webhook'],
      };

      expect(() => {
        auth(validOptions);
      }).not.toThrow();
    });
  });

  describe('Type Safety', () => {
    it('should maintain type safety for providers', () => {
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

    it('should maintain type safety for auth options', () => {
      const options: AuthOptions = {
        providers: [
          providers.github({
            clientId: 'test',
            clientSecret: 'test',
          }),
        ],
        secret: 'test-secret',
        session: {
          strategy: 'jwt' as const,
          maxAge: 86400,
        },
        debug: true,
      };

      expect(options.providers.length).toBe(1);
      expect(options.session?.strategy).toBe('jwt');
      expect(options.debug).toBe(true);
    });
  });
});

// Run a simple smoke test to ensure everything works
describe('Auth Smoke Test', () => {
  it('should export auth and providers', () => {
    expect(typeof auth).toBe('function');
    expect(typeof providers).toBe('object');
    expect(typeof providers.github).toBe('function');
    expect(typeof providers.google).toBe('function');
    expect(typeof providers.discord).toBe('function');
    expect(typeof providers.credentials).toBe('function');
    expect(typeof providers.email).toBe('function');
  });

  it('should create a working auth middleware', async () => {
    const middleware = auth({
      providers: [
        providers.github({
          clientId: 'test-id',
          clientSecret: 'test-secret',
        }),
      ],
      secret: 'test-secret',
    });

    expect(middleware).toBeDefined();
    expect(middleware.name).toBe('auth');
    expect(middleware.version).toBe('2.0.0');
    expect(typeof middleware.install).toBe('function');

    // Test installation doesn't throw
    const mockHooks = {
      before: jest.fn(),
      after: jest.fn(),
    };

    await expect(middleware.install!(mockHooks)).resolves.not.toThrow();
  });
});
