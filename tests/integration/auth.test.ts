// Auth Integration Tests - Better Auth Compatible
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { jest } from '@jest/globals';
import path from 'path';
import { createApp, MoroJSAuth, requireAuth, requireRole } from '../../src/index.js';
import {
  auth,
  providers,
  twoFactor,
  organization,
  bearerToken,
  accountLinking,
  rateLimit,
} from '../../src/core/middleware/built-in/auth/index.js';
import { forgetStartupWarnings } from '../../src/core/auth/morojs-adapter.js';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import * as packageUtils from '../../src/core/utilities/package-utils.js';
import request from 'supertest';
import { closeApp, createTestPort, delay } from '../setup.js';

// better-auth and jsonwebtoken are optional peers that are not installed in
// this repository. Where a test needs one, a stand-in with the same contract
// is resolved in its place (tests/fixtures).
const BETTER_AUTH_FAKE = path.resolve(__dirname, '../fixtures/better-auth-fake/index.cjs');
const JWT_FAKE = path.resolve(__dirname, '../fixtures/jsonwebtoken-fake/index.cjs');
const betterAuthFake: {
  instances: Array<{ options: Record<string, any>; requests: Array<{ pathname: string }> }>;
  SESSION_COOKIE: string;
  SESSION_TOKEN: string;
  ACTIVE_ORGANIZATION: string;
} = require(BETTER_AUTH_FAKE);
const jwtFake: {
  sign: (payload: Record<string, unknown>, secret: string, header?: object) => string;
} = require(JWT_FAKE);

describe('Auth Integration Tests (Better Auth)', () => {
  let app: any;
  let port: number;

  beforeEach(async () => {
    app = await createApp({
      logger: { level: 'error' }, // Reduce log noise in tests
    });
    port = createTestPort();
  });

  afterEach(async () => {
    // Close HTTP server if it exists
    try {
      if (app.core && app.core.httpServer) {
        await app.core.httpServer.close();
      }
    } catch (error) {
      // Ignore close errors
    }

    // Close Socket.IO if it exists
    try {
      if (app.core && app.core.io) {
        await new Promise<void>(resolve => {
          app.core.io.close(() => resolve());
        });
      }
    } catch (error) {
      // Ignore close errors
    }

    // Destroy the container to clean up intervals
    try {
      if (app.core && app.core.container && typeof app.core.container.destroy === 'function') {
        app.core.container.destroy();
      }
    } catch (error) {
      // Ignore destroy errors
    }

    await delay(100);
  });

  describe('Basic Auth Setup', () => {
    it('should setup auth middleware with GitHub provider', async () => {
      // Configure auth middleware
      app.use(
        auth({
          providers: [
            providers.github({
              clientId: 'test-client-id',
              clientSecret: 'test-client-secret',
            }),
          ],
          secret: 'test-secret',
        })
      );

      // Add a test route
      app.get('/test', (req: any) => {
        return {
          isAuthenticated: req.auth?.isAuthenticated || false,
          user: req.auth?.user || null,
        };
      });

      // Start server
      await new Promise<void>(resolve => {
        app.listen(port, () => {
          resolve();
        });
      });

      await delay(100);

      const response = await request(`http://localhost:${port}`).get('/test').expect(200);

      expect(response.body.isAuthenticated).toBe(false);
      expect(response.body.user).toBeNull();
    });

    it('should handle auth middleware properly', async () => {
      app.use(
        auth({
          providers: [
            providers.credentials({
              credentials: {
                username: { label: 'Username', type: 'text' },
                password: { label: 'Password', type: 'password' },
              },
              authorize: async () => null, // Mock authorize function
            }),
          ],
          secret: 'test-secret',
        })
      );

      // Add a test route that checks auth
      app.get('/protected', (req: any) => {
        return {
          hasAuth: !!req.auth,
          isAuthenticated: req.auth?.isAuthenticated || false,
        };
      });

      // Start server
      await new Promise<void>(resolve => {
        app.listen(port, () => {
          resolve();
        });
      });

      await delay(100);

      const response = await request(`http://localhost:${port}`).get('/protected').expect(200);

      expect(response.body.hasAuth).toBe(true);
      expect(response.body.isAuthenticated).toBe(false);
    });
  });

  describe('Auth API Routes', () => {
    it('should handle auth API routes', async () => {
      app.use(
        auth({
          providers: [
            providers.github({
              clientId: 'test-client-id',
              clientSecret: 'test-client-secret',
            }),
          ],
          secret: 'test-secret',
        })
      );

      // Start server
      await new Promise<void>(resolve => {
        app.listen(port, () => {
          resolve();
        });
      });

      await delay(100);

      // Test session endpoint (should exist from auth middleware)
      const sessionResponse = await request(`http://localhost:${port}`).get('/api/auth/session');

      // Auth middleware should handle the request (could be 200 or 404, both are valid)
      expect([200, 404]).toContain(sessionResponse.status);
    });
  });
});

// What app.use(auth(...)) does for a running application, on each server.
describe.each(['node', 'moro'] as const)('auth() on the %s server', engine => {
  const SECRET = 'a-secret-that-is-long-enough-for-tests';
  let app: any;
  let port: number;
  let installed: { betterAuth: boolean; jsonwebtoken: boolean };

  beforeEach(() => {
    betterAuthFake.instances.length = 0;
    forgetStartupWarnings();
    installed = { betterAuth: false, jsonwebtoken: true };
    jest.spyOn(packageUtils, 'resolveUserPackage').mockImplementation((name: string) => {
      if (installed.jsonwebtoken && name === 'jsonwebtoken') return JWT_FAKE;
      if (installed.betterAuth && name.startsWith('better-auth')) return BETTER_AUTH_FAKE;
      throw new Error(`Cannot find module '${name}'`);
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  // warn() is an instance property (a noop when the level disables it), so the
  // calls are read from the shared log(level, message, context) sink.
  function captureWarnings() {
    globalLogger.setLevel('warn');
    const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
    return (pattern: RegExp) =>
      logSpy.mock.calls
        .filter(c => c[0] === 'warn')
        .map(c => String(c[1]))
        .filter(message => pattern.test(message));
  }

  async function start(
    options: Parameters<typeof auth>[0],
    routes?: () => void,
    beforeInstall?: () => void
  ) {
    app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
    beforeInstall?.();
    await app.use(auth(options));
    app.get('/me', (req: any) => ({
      isAuthenticated: req.auth.isAuthenticated,
      user: req.auth.user ?? null,
      token: req.auth.token ?? null,
    }));
    app
      .get('/private')
      .before(requireAuth())
      .handler((req: any) => ({ id: req.auth.user.id }));
    app
      .get('/admin')
      .before(requireRole('admin'))
      .handler(() => ({ admin: true }));
    routes?.();
    port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
  }

  const get = (pathname: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: 'manual', headers });

  describe('Bearer tokens', () => {
    it('a valid token passes the guards, with and without Accept: application/json', async () => {
      await start({ secret: SECRET });
      const token = jwtFake.sign(
        { sub: 'user-7', email: 'ada@example.com', roles: ['admin'] },
        SECRET
      );

      for (const accept of ['*/*', 'application/json']) {
        const headers = { authorization: `Bearer ${token}`, accept };

        const me = (await (await get('/me', headers)).json()) as any;
        expect(me).toEqual({
          isAuthenticated: true,
          user: { id: 'user-7', email: 'ada@example.com', roles: ['admin'] },
          token,
        });

        const guarded = await get('/private', headers);
        expect(guarded.status).toBe(200);
        expect(await guarded.json()).toEqual({ id: 'user-7' });
        expect((await get('/admin', headers)).status).toBe(200);
      }

      // The role comes from the token: one without it is refused
      const plain = jwtFake.sign({ sub: 'user-8' }, SECRET);
      expect((await get('/admin', { authorization: `Bearer ${plain}` })).status).toBe(403);
      expect((await get('/private')).status).toBe(401);
    });

    it('a token that does not verify reaches no guarded route and is not exposed', async () => {
      await start({ secret: SECRET, jwt: { audience: 'api' } });
      const past = Math.floor(Date.now() / 1000) - 60;
      const tokens = {
        expired: jwtFake.sign({ sub: 'u', aud: 'api', exp: past }, SECRET),
        'wrong secret': jwtFake.sign({ sub: 'u', aud: 'api' }, 'another-secret'),
        'alg none': jwtFake.sign({ sub: 'u', aud: 'api' }, '', { alg: 'none', typ: 'JWT' }),
        'wrong audience': jwtFake.sign({ sub: 'u', aud: 'billing' }, SECRET),
      };

      for (const [what, token] of Object.entries(tokens)) {
        const authorization = `Bearer ${token}`;

        expect([what, (await get('/private', { authorization })).status]).toEqual([what, 401]);
        expect([
          what,
          (await get('/private', { authorization, accept: 'application/json' })).status,
        ]).toEqual([what, 401]);

        // On a route without a guard: unauthenticated, and no token to read
        const open = await get('/me', { authorization, accept: 'text/html' });
        expect(open.status).toBe(200);
        expect(await open.json()).toEqual({ isAuthenticated: false, user: null, token: null });

        // A client that asked for JSON is refused before the route
        const json = await get('/me', { authorization, accept: 'application/json' });
        expect(json.status).toBe(401);
        expect(((await json.json()) as any).success).toBe(false);
      }

      const good = jwtFake.sign({ sub: 'u', aud: 'api' }, SECRET);
      expect((await get('/private', { authorization: `Bearer ${good}` })).status).toBe(200);
    });

    it('an option names the secret even when JWT_SECRET is set', async () => {
      const saved = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'a-secret-from-the-environment';
      try {
        await start({ secret: SECRET });
        const authorization = `Bearer ${jwtFake.sign({ sub: 'u' }, SECRET)}`;
        expect((await get('/private', { authorization })).status).toBe(200);

        const fromEnv = `Bearer ${jwtFake.sign({ sub: 'u' }, 'a-secret-from-the-environment')}`;
        expect((await get('/private', { authorization: fromEnv })).status).toBe(401);
      } finally {
        if (saved === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = saved;
      }
    });
  });

  describe('sign-in routes', () => {
    const github = () => providers.github({ clientId: 'client-id', clientSecret: 'client-secret' });
    const signInOptions = () => ({
      secret: SECRET,
      baseURL: 'http://localhost:3000',
      providers: [github()],
    });

    it('do not exist without the better-auth package, and start-up says so once', async () => {
      let warnings!: ReturnType<typeof captureWarnings>;
      await start(signInOptions(), undefined, () => {
        warnings = captureWarnings();
      });

      for (const pathname of [
        '/api/auth/signin',
        '/api/auth/signin/github',
        '/api/auth/callback/github',
        '/api/auth/session',
        '/api/auth/signout',
        '/api/auth/ok',
      ]) {
        const res = await get(pathname);
        // The application's own 404, with a body: never an empty answer
        expect([pathname, res.status]).toEqual([pathname, 404]);
        expect((await res.text()).length).toBeGreaterThan(0);
      }

      expect(warnings(/'better-auth' package is not installed.*no sign-in routes/)).toHaveLength(1);

      // Tokens and guards do not need it
      const authorization = `Bearer ${jwtFake.sign({ sub: 'u' }, SECRET)}`;
      expect((await get('/private', { authorization })).status).toBe(200);
    });

    it('names the sign-in options that have nothing to act on', async () => {
      let warnings!: ReturnType<typeof captureWarnings>;
      await start(
        {
          secret: SECRET,
          callbacks: { signIn: async () => true },
          pages: { signIn: '/login' },
          jwt: { encode: async () => 'token' },
        },
        undefined,
        () => {
          warnings = captureWarnings();
        }
      );

      expect(warnings(/'callbacks' is not used/)).toHaveLength(1);
      expect(warnings(/'pages' is not used/)).toHaveLength(1);
      expect(warnings(/'jwt\.encode' is not used/)).toHaveLength(1);
    });

    it('says nothing when no sign-in was configured', async () => {
      let warnings!: ReturnType<typeof captureWarnings>;
      await start({ secret: SECRET }, undefined, () => {
        warnings = captureWarnings();
      });
      expect(warnings(/better-auth/)).toEqual([]);
      expect((await get('/api/auth/ok')).status).toBe(404);
    });

    it('are served by Better Auth when it is installed, and its session passes the guards', async () => {
      installed.betterAuth = true;
      const seen: string[] = [];
      app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
      // Registered before auth(): it runs for the sign-in routes too
      await app.use((req: any, res: any, next: () => void) => {
        res.setHeader('X-Before-Auth', 'yes');
        seen.push(req.path);
        next();
      });
      await app.use(auth(signInOptions()));
      app
        .get('/private')
        .before(requireAuth())
        .handler((req: any) => ({ id: req.auth.user.id }));
      port = createTestPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));

      const instance = betterAuthFake.instances[0] as (typeof betterAuthFake.instances)[number];
      expect(instance.options.socialProviders.github).toEqual({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      });
      expect(instance.options.secret).toBe(SECRET);

      const ok = await get('/api/auth/ok');
      expect(ok.status).toBe(200);
      expect(ok.headers.get('x-before-auth')).toBe('yes');

      // The URL req.auth.signIn() builds starts the sign-in
      const started = await get('/api/auth/signin/github?callbackUrl=%2Fprivate');
      expect(started.status).toBe(302);
      expect(started.headers.get('location')).toBe(
        'https://provider.example/authorize?client_id=client-id&next=%2Fprivate'
      );

      const callback = await get('/api/auth/callback/github?code=abc&state=xyz');
      expect(callback.status).toBe(302);
      const cookie = callback.headers.getSetCookie().map(c => c.split('; ')[0])[1] as string;
      expect(cookie).toBe(betterAuthFake.SESSION_COOKIE);

      expect((await get('/private')).status).toBe(401);
      const guarded = await get('/private', { cookie });
      expect(guarded.status).toBe(200);
      expect(await guarded.json()).toEqual({ id: 'u1' });

      // The session route answers with the session
      const session = await get('/api/auth/get-session', { cookie });
      expect(((await session.json()) as any).user.id).toBe('u1');

      // A Bearer token works on the same application
      const authorization = `Bearer ${jwtFake.sign({ sub: 'svc-1' }, SECRET)}`;
      expect(await (await get('/private', { authorization })).json()).toEqual({ id: 'svc-1' });

      expect(instance.requests.map(r => r.pathname)).toEqual([
        '/api/auth/ok',
        '/api/auth/sign-in/social',
        '/api/auth/callback/github',
        '/api/auth/get-session',
      ]);
      expect(seen).toContain('/api/auth/ok');
    });

    it("leave the application's own routes under the base path alone", async () => {
      installed.betterAuth = true;
      await start(signInOptions(), () => {
        app.get('/api/auth/whoami', (req: any) => ({ mine: true, hasAuth: Boolean(req.auth) }));
      });
      const instance = betterAuthFake.instances[0] as (typeof betterAuthFake.instances)[number];

      const own = await get('/api/auth/whoami');
      expect(await own.json()).toEqual({ mine: true, hasAuth: true });
      expect(instance.requests).toEqual([]);

      expect((await get('/api/auth/ok')).status).toBe(200);
      expect(instance.requests.map(r => r.pathname)).toEqual(['/api/auth/ok']);
    });

    it('are left to the application with mountRoutes: false', async () => {
      installed.betterAuth = true;
      await start({ ...signInOptions(), mountRoutes: false });

      expect((await get('/api/auth/ok')).status).toBe(404);
      // The session is still recognised
      const guarded = await get('/private', { cookie: betterAuthFake.SESSION_COOKIE });
      expect(guarded.status).toBe(200);
      expect(typeof MoroJSAuth).toBe('function');
    });
  });

  // twoFactor(), organization(), bearerToken(), accountLinking(), rateLimit():
  // passed to auth(), they configure Better Auth.
  describe('feature helpers', () => {
    const helperOptions = () => ({
      secret: SECRET,
      baseURL: 'http://localhost:3000',
      plugins: [organization(), bearerToken()],
      accountLinking: accountLinking(),
      rateLimit: rateLimit({ maxAttempts: 3 }),
      betterAuth: { database: {}, emailAndPassword: { enabled: true } },
    });

    it('are not active without the better-auth package, and start-up names them once', async () => {
      let warnings!: ReturnType<typeof captureWarnings>;
      await start(
        { secret: SECRET, plugins: [twoFactor(), bearerToken()], rateLimit: rateLimit() },
        undefined,
        () => {
          warnings = captureWarnings();
        }
      );

      expect(
        warnings(
          /twoFactor\(\), bearerToken\(\), rateLimit\(\) are not active.*npm install better-auth/
        )
      ).toHaveLength(1);
      // No provider was configured, so nothing is said about providers
      expect(warnings(/providers are configured/)).toEqual([]);
      expect((await get('/api/auth/ok')).status).toBe(404);

      // Tokens and guards do not need it
      const authorization = `Bearer ${jwtFake.sign({ sub: 'u' }, SECRET)}`;
      expect((await get('/private', { authorization })).status).toBe(200);
    });

    it('reach Better Auth as its plugins and options, with no provider configured', async () => {
      installed.betterAuth = true;
      await start(helperOptions());

      const { options } = betterAuthFake.instances[0] as (typeof betterAuthFake.instances)[number];
      expect(options.plugins).toEqual([
        {
          id: 'organization',
          options: { allowUserToCreateOrganization: true, organizationLimit: 10 },
        },
        { id: 'bearer', options: {} },
      ]);
      expect(options.account.accountLinking).toEqual({
        enabled: true,
        disableImplicitLinking: true,
      });
      expect(options.rateLimit).toEqual({
        enabled: true,
        customRules: { '/sign-in/*': { window: 300, max: 3 } },
      });
      // None of the helper keys is handed on under its own name
      expect(options).not.toHaveProperty('accountLinking');

      // The routes of the plugins are served by the routes auth() mounts
      expect((await get('/api/auth/ok')).status).toBe(200);
    });

    it('bearerToken(): a session token is accepted as a Bearer token, beside JWTs', async () => {
      installed.betterAuth = true;
      await start(helperOptions());

      const session = await get('/me', {
        authorization: `Bearer ${betterAuthFake.SESSION_TOKEN}`,
      });
      expect(await session.json()).toMatchObject({ isAuthenticated: true, user: { id: 'u1' } });
      expect(
        (await get('/private', { authorization: `Bearer ${betterAuthFake.SESSION_TOKEN}` })).status
      ).toBe(200);

      // A JWT signed with the secret authenticates from its claims, as without the helper
      const jwt = jwtFake.sign({ sub: 'svc-1' }, SECRET);
      expect(await (await get('/private', { authorization: `Bearer ${jwt}` })).json()).toEqual({
        id: 'svc-1',
      });
      // A token that is neither is refused
      const refused = await get('/private', {
        authorization: 'Bearer neither',
        accept: 'application/json',
      });
      expect(refused.status).toBe(401);

      // Without the helper a session token is not a Bearer token
      await closeApp(app);
      await start({ ...helperOptions(), plugins: [organization()] });
      expect(
        (await get('/private', { authorization: `Bearer ${betterAuthFake.SESSION_TOKEN}` })).status
      ).toBe(401);
    });

    it('organization(): req.auth.session carries the active organization', async () => {
      installed.betterAuth = true;
      await start(helperOptions(), () => {
        app.get('/organization', (req: any) => ({
          active: req.auth.session?.activeOrganizationId ?? null,
        }));
      });
      const res = await get('/organization', { cookie: betterAuthFake.SESSION_COOKIE });
      expect(await res.json()).toEqual({ active: betterAuthFake.ACTIVE_ORGANIZATION });
    });

    it('say at start-up what the database is missing', async () => {
      installed.betterAuth = true;
      const errors: string[] = [];
      await start(
        {
          ...helperOptions(),
          plugins: [twoFactor()],
          betterAuth: { database: { missingTables: ['twoFactor'] } },
        },
        undefined,
        () => {
          globalLogger.setLevel('warn');
          jest
            .spyOn(MoroLogger.prototype as any, 'log')
            .mockImplementation((...call: unknown[]) => {
              if (call[0] === 'error') errors.push(String(call[1]));
            });
        }
      );

      const said = errors.filter(message =>
        /the auth database does not have the tables and columns/.test(message)
      );
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/twoFactor\(\): table `twoFactor`, column `user\.twoFactorEnabled`/);
      expect(said[0]).toMatch(/Missing tables twoFactor.*npx auth migrate/);

      // The application runs; requests are unauthenticated until the tables exist
      expect(await (await get('/me')).json()).toMatchObject({ isAuthenticated: false });
      expect((await get('/api/auth/ok')).status).toBe(500);
    });

    describe('rateLimit() and the client address', () => {
      const limited = () => ({
        secret: SECRET,
        baseURL: 'http://localhost:3000',
        rateLimit: rateLimit({ maxAttempts: 5 }),
        betterAuth: { emailAndPassword: { enabled: true } },
      });
      const startWith = async (trustProxy: boolean | undefined) => {
        installed.betterAuth = true;
        app = await createApp({
          logger: { level: 'fatal' },
          server: { engine, ...(trustProxy !== undefined ? { trustProxy } : {}) },
        });
        const warnings = captureWarnings();
        await app.use(auth(limited()));
        port = createTestPort();
        await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
        return warnings;
      };
      const sixAttempts = async () => {
        const statuses: number[] = [];
        for (let n = 1; n <= 6; n++) {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${n}` },
            body: JSON.stringify({ email: 'ada@example.com', password: 'wrong' }),
          });
          statuses.push(res.status);
        }
        return statuses;
      };

      it('with server.trustProxy set, six forwarded addresses from one peer are one client', async () => {
        const warnings = await startWith(false);
        expect(await sixAttempts()).toEqual([401, 401, 401, 401, 401, 429]);
        expect(warnings(/rate limit of the auth routes/)).toEqual([]);
      });

      it('without it the forwarded address is what is counted, and start-up says so once', async () => {
        const warnings = await startWith(undefined);
        expect(await sixAttempts()).toEqual([401, 401, 401, 401, 401, 401]);
        expect(
          warnings(/rate limit of the auth routes is in force and `server\.trustProxy` is not set/)
        ).toHaveLength(1);
      });
    });

    it('say what has no equivalent once when a script created the handlers first', async () => {
      installed.betterAuth = true;
      const options = {
        ...helperOptions(),
        plugins: [bearerToken({ expiresIn: 600 })],
        rateLimit: rateLimit({ lockoutDuration: 600 }),
      };
      app = await createApp({ logger: { level: 'fatal' }, server: { engine, trustProxy: false } });
      const warnings = captureWarnings();
      // What a migration script does, then the application
      await MoroJSAuth(options);
      await app.use(auth(options));
      port = createTestPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
      // Answered once Better Auth has been set up for the application too
      expect((await get('/api/auth/ok')).status).toBe(200);
      expect(betterAuthFake.instances).toHaveLength(2);

      expect(warnings(/bearerToken\(\): 'expiresIn' is not applied/)).toHaveLength(1);
      expect(warnings(/rateLimit\(\): 'lockoutDuration' is not applied/)).toHaveLength(1);
    });

    it('are refused in the wrong place at compile time', () => {
      expect(typeof auth({ plugins: [twoFactor()], rateLimit: rateLimit() }).install).toBe(
        'function'
      );
      // @ts-expect-error rateLimit() is not a plugin
      auth({ plugins: [rateLimit()] });
      // @ts-expect-error accountLinking() is not the rate limit
      auth({ rateLimit: accountLinking() });
      // @ts-expect-error a plugin helper is not account linking
      auth({ accountLinking: bearerToken() });
    });
  });
});
