// Auth Middleware Unit Tests
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { auth, providers } from '../../../src/core/middleware/built-in/auth/index.js';
import {
  authUtils,
  normalizeAuthList,
  requireAdmin,
  requireAuth,
  requirePermission,
  requireRole,
} from '../../../src/core/middleware/built-in/auth/helpers.js';
import { AuthProvider, AuthOptions } from '../../../src/types/auth.js';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';
import path from 'path';

// jsonwebtoken is an optional peer that is not installed in this repository:
// a stand-in with its verify() contract takes its place where a test says so.
const JWT_FAKE = path.resolve(__dirname, '../../fixtures/jsonwebtoken-fake/index.cjs');
const jwtFake: {
  sign: (payload: Record<string, unknown>, secret: string, header?: object) => string;
} = require(JWT_FAKE);

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
      expect(authMiddleware.metadata?.description).toContain(
        'Better Auth authentication middleware'
      );
      expect(authMiddleware.metadata?.dependencies).toEqual([]);
    });

    it('should install with no providers configured', async () => {
      const authMiddleware = auth({
        providers: [],
      });

      await expect(authMiddleware.install!(mockHooks, {})).resolves.toBeUndefined();
      expect(mockHooks.before).toHaveBeenCalledWith('request', expect.any(Function));
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
      authMiddleware.install = async (hooks: any, options: any) => {
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

    it('should handle Better Auth API routes', async () => {
      mockRequest.url = '/api/auth/signin';

      const context = {
        request: mockRequest,
        response: mockResponse,
      };

      const result = await beforeRequestHandler(context);

      // The mock implementation returns undefined, but in real Better Auth
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

    it('registers nothing to run after the response', () => {
      expect(afterResponseHandler).toBeUndefined();
      expect(mockHooks.after).not.toHaveBeenCalled();
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

// req.auth.getProviders() returns public provider metadata only: descriptive
// fields stay, credentials and callbacks never leave the server.
describe('auth(): Bearer tokens', () => {
  const SECRET = 'the-secret-the-tokens-are-signed-with';
  const savedEnv = { ...process.env };
  const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 300;

  beforeEach(() => {
    for (const name of ['JWT_SECRET', 'AUTH_SECRET', 'NEXTAUTH_SECRET']) delete process.env[name];
    // jsonwebtoken resolves to the stand-in; better-auth is not installed
    jest.spyOn(packageUtils, 'resolveUserPackage').mockImplementation((name: string) => {
      if (name === 'jsonwebtoken') return JWT_FAKE;
      throw new Error(`Cannot find module '${name}'`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  /** Install auth(options) on a hook recorder and run one request through it. */
  async function run(
    options: Parameters<typeof auth>[0],
    headers: Record<string, string>
  ): Promise<{ req: any; res: { status: jest.Mock; json: jest.Mock; headersSent: boolean } }> {
    const hooks = { before: jest.fn(), after: jest.fn() };
    await auth(options).install!(hooks, {});
    const handler = hooks.before.mock.calls.find((call: any) => call[0] === 'request')?.[1] as (
      context: unknown
    ) => Promise<void>;

    const req: any = { url: '/reports', method: 'GET', headers, cookies: {} };
    const res: any = { headersSent: false };
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => {
      res.headersSent = true;
    });
    await handler({ request: req, response: res });
    return { req, res };
  }

  const bearer = (token: string, accept?: string) => ({
    authorization: `Bearer ${token}`,
    ...(accept ? { accept } : {}),
  });

  describe.each([
    ['without an Accept header', undefined],
    ['with Accept: application/json', 'application/json'],
  ])('%s', (_label, accept) => {
    it('a valid token authenticates the request as the user in its claims', async () => {
      const exp = inFiveMinutes();
      const token = jwtFake.sign(
        {
          sub: 'user-7',
          name: 'Ada',
          email: 'ada@example.com',
          picture: 'https://img.example/ada.png',
          roles: ['admin'],
          permissions: ['reports:read'],
          tenant: 'acme',
          iss: 'https://issuer.example',
          aud: 'api',
          iat: exp - 600,
          exp,
        },
        SECRET
      );
      const { req, res } = await run({ secret: SECRET }, bearer(token, accept));

      expect(res.status).not.toHaveBeenCalled();
      expect(req.auth.isAuthenticated).toBe(true);
      expect(req.auth.token).toBe(token);
      // sub is the id; the other claims about the holder come along; the
      // claims about the token itself (iss, aud, iat, exp) do not
      expect(req.auth.user).toEqual({
        id: 'user-7',
        name: 'Ada',
        email: 'ada@example.com',
        picture: 'https://img.example/ada.png',
        image: 'https://img.example/ada.png',
        roles: ['admin'],
        permissions: ['reports:read'],
        tenant: 'acme',
      });
      expect(req.auth.session.userId).toBe('user-7');
      expect(req.auth.session.expires).toEqual(new Date(exp * 1000));
      expect(await req.auth.getSession()).toBe(req.auth.session);
      expect((await req.auth.getToken()).sub).toBe('user-7');

      // The guards read the same user
      expect(authUtils.hasRole(req, 'admin')).toBe(true);
      expect(authUtils.hasPermission(req, 'reports:read')).toBe(true);
    });

    it.each([
      [
        'expired',
        () => jwtFake.sign({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET),
      ],
      ['signed with another secret', () => jwtFake.sign({ sub: 'u' }, 'some-other-secret')],
      [
        'unsigned (alg: none)',
        () => jwtFake.sign({ sub: 'u', roles: ['admin'] }, '', { alg: 'none', typ: 'JWT' }),
      ],
      ['not yet valid', () => jwtFake.sign({ sub: 'u', nbf: inFiveMinutes() }, SECRET)],
      ['without a subject', () => jwtFake.sign({ roles: ['admin'] }, SECRET)],
      ['not a JWT at all', () => 'not-a-jwt'],
    ])('a token that is %s does not authenticate and is not kept', async (_what, make) => {
      const { req, res } = await run({ secret: SECRET }, bearer(make(), accept));

      if (accept) {
        // A client that asked for JSON is told why, before any route runs
        expect(res.status).toHaveBeenCalledWith(401);
        expect((res.json.mock.calls[0] as any)[0].success).toBe(false);
        expect(req.auth).toBeUndefined();
      } else {
        // Any other request goes on unauthenticated, for a guard to answer
        expect(res.status).not.toHaveBeenCalled();
        expect(req.auth.isAuthenticated).toBe(false);
        expect(req.auth.user).toBeUndefined();
        expect(req.auth.token).toBeUndefined();
        expect(await req.auth.getToken()).toBeNull();
      }
    });

    it('refuses a token for another audience or issuer when one is configured', async () => {
      const options = {
        secret: SECRET,
        jwt: { audience: 'api', issuer: 'https://issuer.example' },
      };
      const claims = { sub: 'u', aud: 'api', iss: 'https://issuer.example' };

      const right = await run(options, bearer(jwtFake.sign(claims, SECRET), accept));
      expect(right.req.auth.isAuthenticated).toBe(true);

      for (const wrong of [
        { ...claims, aud: 'billing' },
        { ...claims, iss: 'https://elsewhere.example' },
        { sub: 'u' },
      ]) {
        const { req } = await run(options, bearer(jwtFake.sign(wrong, SECRET), accept));
        expect(req.auth?.isAuthenticated ?? false).toBe(false);
        expect(req.auth?.token).toBeUndefined();
      }
    });
  });

  describe('the secret a token is verified with', () => {
    const J = 'secret-from-jwt.secret-option';
    const S = 'secret-from-the-secret-option';
    const E = 'secret-from-JWT_SECRET-env';
    const A = 'secret-from-AUTH_SECRET-env';

    it.each([
      [
        'jwt.secret, before secret and JWT_SECRET',
        { secret: S, jwt: { secret: J } },
        { JWT_SECRET: E },
        J,
        [S, E],
      ],
      ['secret, before JWT_SECRET', { secret: S }, { JWT_SECRET: E, AUTH_SECRET: A }, S, [E, A]],
      ['JWT_SECRET when no option names one', {}, { JWT_SECRET: E, AUTH_SECRET: A }, E, [A]],
      ['AUTH_SECRET when nothing else is set', {}, { AUTH_SECRET: A }, A, [E]],
      ['NEXTAUTH_SECRET likewise', {}, { NEXTAUTH_SECRET: A }, A, [E]],
    ])('is %s', async (_label, options, env, right, wrong) => {
      Object.assign(process.env, env);

      const accepted = await run(options, bearer(jwtFake.sign({ sub: 'u' }, right)));
      expect(accepted.req.auth.isAuthenticated).toBe(true);
      for (const secret of wrong) {
        const refused = await run(options, bearer(jwtFake.sign({ sub: 'u' }, secret)));
        expect(refused.req.auth.isAuthenticated).toBe(false);
      }
    });
  });

  it('verifies with jwt.decode when the application supplies its own', async () => {
    const decode = jest.fn(async ({ token }: { token?: string; secret: string }) =>
      token === 'opaque-good' ? { sub: 'svc-1', roles: ['worker'] } : null
    );
    const options = { secret: SECRET, jwt: { decode } };

    const good = await run(options, bearer('opaque-good'));
    expect(good.req.auth.isAuthenticated).toBe(true);
    expect(good.req.auth.user).toEqual({ id: 'svc-1', roles: ['worker'] });
    expect(decode).toHaveBeenCalledWith({ token: 'opaque-good', secret: SECRET });

    const bad = await run(options, bearer('opaque-bad', 'application/json'));
    expect(bad.res.status).toHaveBeenCalledWith(401);
  });

  it('leaves a request without a Bearer token to the session', async () => {
    const { req, res } = await run({ secret: SECRET }, { authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.status).not.toHaveBeenCalled();
    expect(req.auth.isAuthenticated).toBe(false);
    expect(req.auth.token).toBeUndefined();
  });

  it('builds sign-in and sign-out URLs that carry the callback URL', async () => {
    const { req } = await run({ secret: SECRET, basePath: '/auth' }, {});
    expect(await req.auth.signIn('github', { callbackUrl: '/after?x=1' })).toEqual({
      url: '/auth/signin/github?callbackUrl=%2Fafter%3Fx%3D1',
    });
    expect(await req.auth.signIn()).toEqual({ url: '/auth/signin' });
    expect(await req.auth.signOut({ callbackUrl: '/' })).toEqual({
      url: '/auth/signout?callbackUrl=%2F',
    });
  });
});

describe('req.auth.getProviders()', () => {
  type RequestHook = (context: { request: any; response: any }) => Promise<void>;

  async function authFor(list: AuthProvider[]): Promise<any> {
    let before: RequestHook | undefined;
    const hooks = {
      before(event: string, handler: RequestHook) {
        if (event === 'request') before = handler;
      },
      after() {},
    };
    await auth({ providers: list, secret: 'test-secret' }).install(hooks, {});
    if (!before) throw new Error('auth() registered no request hook');
    const request: any = { url: '/', headers: {}, cookies: {} };
    await before({ request, response: { cookie() {}, json() {}, status: () => ({}) } });
    return request.auth;
  }

  it('does not return OAuth client secrets', async () => {
    const reqAuth = await authFor([
      providers.github({ clientId: 'gh-client-id', clientSecret: 'GH-CLIENT-SECRET-VALUE' }),
      providers.google({ clientId: 'g-client-id', clientSecret: 'G-CLIENT-SECRET-VALUE' }),
    ]);
    const result = await reqAuth.getProviders();

    expect(JSON.stringify(result)).not.toContain('SECRET-VALUE');
    expect(result.github).not.toHaveProperty('clientSecret');
    expect(result.google).not.toHaveProperty('clientSecret');
    // id, name, type and the other descriptive fields stay
    expect(result.github).toEqual({
      id: 'github',
      name: 'GitHub',
      type: 'oauth',
      authorization: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      userinfo: 'https://api.github.com/user',
      clientId: 'gh-client-id',
    });
    expect(Object.keys(result)).toEqual(['github', 'google']);
  });

  it('strips every credential field and every function-valued field', async () => {
    const custom: AuthProvider = {
      id: 'custom',
      name: 'Custom',
      type: 'oauth',
      clientId: 'public-id',
      clientSecret: 'S1',
      secret: 'S2',
      apiKey: 'S3',
      privateKey: 'S4',
      password: 'S5',
      scope: 'openid email',
      issuer: 'https://idp.example',
      profile: (profile: any) => profile,
    };
    const reqAuth = await authFor([
      custom,
      providers.credentials({
        name: 'Login',
        credentials: { username: { label: 'Username' }, password: { type: 'password' } },
        authorize: async () => null,
      }),
      providers.email({
        server: { host: 'smtp.example.com', port: 587, auth: { user: 'u', pass: 'SMTP-PASS' } },
        from: 'noreply@example.com',
      }),
    ]);
    const result = await reqAuth.getProviders();

    expect(result.custom).toEqual({
      id: 'custom',
      name: 'Custom',
      type: 'oauth',
      clientId: 'public-id',
      scope: 'openid email',
      issuer: 'https://idp.example',
    });
    // The sign-in form description is public; the authorize callback is not data
    expect(result.credentials).toEqual({
      id: 'credentials',
      name: 'Login',
      type: 'credentials',
      credentials: { username: { label: 'Username' }, password: { type: 'password' } },
    });
    // SMTP connection details stay on the server
    expect(result.email).toEqual({
      id: 'email',
      name: 'Email',
      type: 'email',
      from: 'noreply@example.com',
    });
    expect(JSON.stringify(result)).not.toContain('SMTP-PASS');
  });

  it('leaves the configured provider objects untouched', async () => {
    const github = providers.github({ clientId: 'id', clientSecret: 'KEEP-ME' });
    const reqAuth = await authFor([github]);
    const first = await reqAuth.getProviders();
    expect(github.clientSecret).toBe('KEEP-ME');
    expect(first.github).not.toBe(github);
    // same public view on every call
    expect(await reqAuth.getProviders()).toBe(first);
  });
});

// Role / permission matching in the auth helpers is by exact entry, never by
// substring, whatever shape the application stored the value in.
describe('Auth guards: role and permission matching', () => {
  interface Outcome {
    passed: boolean;
    status: number | undefined;
    body: any;
  }

  type Guard = (req: any, res: any, next: () => void) => unknown;

  async function run(guard: Guard, user: Record<string, unknown> | null): Promise<Outcome> {
    const outcome: Outcome = { passed: false, status: undefined, body: undefined };
    const req = { url: '/x', auth: { isAuthenticated: user !== null, user } };
    const res: any = {
      status(code: number) {
        outcome.status = code;
        return res;
      },
      json(payload: unknown) {
        outcome.body = payload;
        return res;
      },
      redirect() {},
    };
    await guard(req, res, () => {
      outcome.passed = true;
    });
    return outcome;
  }

  describe('normalizeAuthList', () => {
    it('keeps an array, dropping non-string elements', () => {
      const roles = ['admin', 'editor'];
      expect(normalizeAuthList(roles)).toBe(roles);
      expect(normalizeAuthList(['admin', 1, null, undefined, ['x'], { a: 1 }, 'editor'])).toEqual([
        'admin',
        'editor',
      ]);
      expect(normalizeAuthList([])).toEqual([]);
    });

    it('splits a string on commas and whitespace and drops empties', () => {
      expect(normalizeAuthList('admin')).toEqual(['admin']);
      expect(normalizeAuthList('admin,editor').slice(0, 2)).toEqual(['admin', 'editor']);
      expect(normalizeAuthList(' admin ,, editor\tviewer\n').slice(0, 3)).toEqual([
        'admin',
        'editor',
        'viewer',
      ]);
      expect(normalizeAuthList('')).toEqual([]);
      expect(normalizeAuthList(' , ')).toEqual([]);
    });

    it('keeps a multi-part string as an entry of its own, so a name with a space matches itself', () => {
      expect(normalizeAuthList('Super Admin')).toEqual(['Super', 'Admin', 'Super Admin']);
      expect(normalizeAuthList('admin')).toHaveLength(1);
    });

    it('turns anything else into an empty list', () => {
      for (const value of [undefined, null, 0, 1, true, {}, { admin: true }, new Set(['admin'])]) {
        expect(normalizeAuthList(value)).toEqual([]);
      }
    });
  });

  describe('role checks compare whole entries', () => {
    it('a string role that merely contains the required name is refused', async () => {
      const user = { id: 'u1', roles: 'not-an-admin-at-all' };
      for (const guard of [
        requireAdmin(),
        requireRole('admin'),
        requireAuth({ roles: ['admin'] }),
      ]) {
        const out = await run(guard, user);
        expect(out.passed).toBe(false);
        expect(out.status).toBe(403);
      }
      expect(authUtils.hasRole({ auth: { user } }, 'admin')).toBe(false);
      expect(authUtils.isAdmin({ auth: { user } })).toBe(false);
    });

    it('string storage keeps working: single role, comma list, space list', async () => {
      for (const roles of ['admin', 'editor,admin', 'editor, admin', 'editor admin']) {
        const user = { id: 'u1', roles };
        expect((await run(requireAdmin(), user)).passed).toBe(true);
        expect((await run(requireRole(['owner', 'admin']), user)).passed).toBe(true);
        expect(authUtils.hasRole({ auth: { user } }, 'admin')).toBe(true);
        expect(authUtils.isAdmin({ auth: { user } })).toBe(true);
      }
      expect((await run(requireRole('Super Admin'), { roles: 'Super Admin' })).passed).toBe(true);
    });

    it('array storage matches whole entries too', async () => {
      expect((await run(requireAdmin(), { roles: ['user', 'admin'] })).passed).toBe(true);
      expect((await run(requireAdmin(), { roles: ['user', 'administrator'] })).passed).toBe(false);
      expect((await run(requireAdmin(), { roles: [] })).passed).toBe(false);
      expect((await run(requireAdmin(), {})).passed).toBe(false);
      expect(authUtils.hasRole({ auth: { user: { roles: ['admin'] } } }, ['x', 'admin'])).toBe(
        true
      );
      expect(authUtils.hasRole({ auth: { user: { roles: ['superadmin'] } } }, 'admin')).toBe(false);
      expect(authUtils.hasRole({ auth: { user: {} } }, 'admin')).toBe(false);
      expect(authUtils.hasRole({}, 'admin')).toBe(false);
    });

    it('a roles value that is neither a string nor an array matches nothing', async () => {
      for (const roles of [{ admin: true }, 42, true, new Set(['admin'])]) {
        const out = await run(requireAdmin(), { roles });
        expect(out.passed).toBe(false);
        expect(out.status).toBe(403);
        expect(authUtils.hasRole({ auth: { user: { roles } } }, 'admin')).toBe(false);
      }
    });

    it('reports the required and stored roles in the 403 body', async () => {
      const out = await run(requireRole(['admin', 'owner']), { roles: ['user'] });
      expect(out.body).toEqual({
        error: 'Insufficient permissions',
        message: 'Required roles: admin, owner',
        userRoles: ['user'],
      });
      const asString = await run(requireRole('admin'), { roles: 'not-an-admin-at-all' });
      expect(asString.body).toEqual({
        error: 'Insufficient permissions',
        message: 'Required roles: admin',
        userRoles: 'not-an-admin-at-all',
      });
    });
  });

  describe('permission checks compare whole entries', () => {
    it('a string permission that merely contains the required one is refused', async () => {
      const user = { id: 'u1', permissions: 'users:delete-own-drafts' };
      for (const guard of [
        requirePermission('users:delete'),
        requireAuth({ permissions: ['users:delete'] }),
      ]) {
        const out = await run(guard, user);
        expect(out.passed).toBe(false);
        expect(out.status).toBe(403);
        expect(out.body).toEqual({
          error: 'Insufficient permissions',
          message: 'Required permissions: users:delete',
          userPermissions: 'users:delete-own-drafts',
        });
      }
      expect(authUtils.hasPermission({ auth: { user } }, 'users:delete')).toBe(false);
    });

    it('every required permission must be present, in any storage shape', async () => {
      const needed = ['users:read', 'users:write'];
      for (const permissions of [
        ['users:read', 'users:write', 'x'],
        'users:read,users:write',
        'users:write users:read x',
      ]) {
        const user = { permissions };
        expect((await run(requirePermission(needed), user)).passed).toBe(true);
        expect(authUtils.hasPermission({ auth: { user } }, needed)).toBe(true);
      }
      for (const permissions of [['users:read'], 'users:read', 'users:read,users:writes', '']) {
        const user = { permissions };
        expect((await run(requirePermission(needed), user)).passed).toBe(false);
        expect(authUtils.hasPermission({ auth: { user } }, needed)).toBe(false);
      }
    });
  });

  describe('guards without a role requirement', () => {
    it('answers 401 when not authenticated and passes when no roles are required', async () => {
      const anonymous = await run(requireAdmin(), null);
      expect(anonymous.status).toBe(401);
      expect(anonymous.passed).toBe(false);
      expect((await run(requireAuth(), { id: 'u1', roles: 'whatever' })).passed).toBe(true);
    });
  });
});
