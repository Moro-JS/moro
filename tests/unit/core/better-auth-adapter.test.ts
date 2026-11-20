// Better Auth adapter (MoroJSAuth / createAuthMiddleware).
//
// better-auth is an optional peer that is not installed in this repository, so
// these tests point the adapter at a small stand-in with the same module shape
// (tests/fixtures/better-auth-fake). Like the real package, the stand-in
// serves its routes under the configured basePath and answers 404 anywhere
// else, and it records the exact request it was handed.
/* global Request */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import http from 'http';
import path from 'path';
import {
  createApp,
  createAuthMiddleware,
  MoroJSAuth,
  requireAuth,
  requireRole,
  providers,
  extendedProviders,
  twoFactor,
  organization,
  anonymous,
  bearerToken,
  accountLinking,
  rateLimit,
} from '../../../src/index.js';
import type { HttpRequest, HttpResponse } from '../../../src/index.js';
import { checkAuthStorage, forgetStartupWarnings } from '../../../src/core/auth/morojs-adapter.js';
import type { MoroJSAuthConfig } from '../../../src/core/auth/morojs-adapter.js';
import { resetConfig } from '../../../src/core/config/index.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import * as packageUtils from '../../../src/core/utilities/package-utils.js';
import { closeApp, createTestPort } from '../../setup.js';

const FAKE = path.resolve(__dirname, '../../fixtures/better-auth-fake/index.cjs');

interface FakeRequest {
  method: string;
  pathname: string;
  search: string;
  body: string;
  headers: Record<string, string>;
}
interface FakeInstance {
  options: Record<string, any>;
  requests: FakeRequest[];
  sessionLookups: Array<Record<string, string>>;
}
const fake: {
  instances: FakeInstance[];
  SESSION_COOKIE: string;
  STAFF_COOKIE: string;
  SESSION_TOKEN: string;
  ACTIVE_ORGANIZATION: string;
} = require(FAKE);

const baseConfig: MoroJSAuthConfig = {
  providers: [{ id: 'github', clientId: 'client-id', clientSecret: 'client-secret' }],
  secret: 'a-secret-that-is-long-enough-for-tests',
  baseURL: 'http://localhost:3000',
};
const ORIGIN = 'http://localhost:3000';

// `fake.session_token=<percent-encoded token>`, as the stand-in issues it
const SESSION_COOKIE = fake.SESSION_COOKIE;

// warn() is an instance property (a noop when the level disables it), so the
// calls are read from the shared log(level, message, context) sink.
function captureLogs() {
  globalLogger.setLevel('warn');
  const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  return (level: 'warn' | 'error', pattern: RegExp) =>
    logSpy.mock.calls
      .filter(c => c[0] === level)
      .map(c => String(c[1]))
      .filter(message => pattern.test(message));
}
function captureWarnings() {
  const logs = captureLogs();
  return (pattern: RegExp) => logs('warn', pattern);
}

describe('Better Auth adapter', () => {
  let app: any;
  let port: number;

  beforeEach(() => {
    fake.instances.length = 0;
    forgetStartupWarnings();
    jest.spyOn(packageUtils, 'resolveUserPackage').mockReturnValue(FAKE);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    globalLogger.setLevel('error');
    resetConfig();
    if (app) await closeApp(app);
    app = null;
  });

  async function listen(): Promise<void> {
    port = createTestPort();
    await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
  }

  // fetch() is a script's request: like a browser's, Node's states
  // `Sec-Fetch-Mode: cors` on every request it sends.
  const request = (pathname: string, init: Parameters<typeof fetch>[1] = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, { redirect: 'manual', ...init });

  /**
   * A request as a browser sends it when it navigates (a link, a redirect, a
   * submitted form): exactly the headers given, none added. A current browser
   * states `Sec-Fetch-Mode: navigate`; pass it, or leave it out for a client
   * that sends no fetch metadata.
   */
  const navigate = (
    pathname: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ) =>
    new Promise<{ status: number; location: string | undefined; cookies: string[]; text: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: pathname,
            method: init.method ?? 'GET',
            headers: {
              ...init.headers,
              ...(init.body !== undefined
                ? { 'content-length': Buffer.byteLength(init.body) }
                : {}),
            },
          },
          res => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                cookies: (res.headers['set-cookie'] ?? []).map(c => c.split('; ')[0] as string),
                text: Buffer.concat(chunks).toString('utf8'),
              })
            );
          }
        );
        req.on('error', reject);
        req.end(init.body);
      }
    );
  const FORM = 'application/x-www-form-urlencoded';

  /** Mount MoroJSAuth().handler by hand under `basePath`, the way the docs show. */
  async function mountHandler(config: MoroJSAuthConfig): Promise<FakeInstance> {
    const basePath = config.basePath ?? '/api/auth';
    const auth = await MoroJSAuth(config);
    // Typed as a route handler's own arguments: handler() takes them without a cast
    const forward = (req: HttpRequest, res: HttpResponse) => auth.handler(req, res);
    for (const method of ['get', 'post'] as const) {
      app[method](`${basePath}/:action`, forward);
      app[method](`${basePath}/:action/:provider`, forward);
    }
    return fake.instances[fake.instances.length - 1] as FakeInstance;
  }

  describe('configuration handed to Better Auth', () => {
    it('passes the base path, secret, base URL and the supported social providers', async () => {
      await MoroJSAuth({
        ...baseConfig,
        basePath: '/auth',
        providers: [
          { id: 'github', clientId: 'gh', clientSecret: 'gh-secret' },
          { id: 'google', clientId: 'go', clientSecret: 'go-secret' },
          { id: 'okta', clientId: 'ok', clientSecret: 'ok-secret' },
        ],
      });

      const { options } = fake.instances[0] as FakeInstance;
      expect(options.basePath).toBe('/auth');
      expect(options.secret).toBe(baseConfig.secret);
      expect(options.baseURL).toBe('http://localhost:3000');
      expect(options.trustedOrigins).toEqual(['http://localhost:3000']);
      expect(Object.keys(options.socialProviders).sort()).toEqual(['github', 'google']);
    });

    it('passes on every provider Better Auth knows, with the fields of its entry', async () => {
      const mapProfileToUser = () => ({});
      const auth = await MoroJSAuth({
        ...baseConfig,
        providers: [
          // An Auth.js-style entry, as providers.github() builds it
          {
            id: 'github',
            name: 'GitHub',
            type: 'oauth',
            authorization: 'https://github.com/login/oauth/authorize',
            token: 'https://github.com/login/oauth/access_token',
            userinfo: 'https://api.github.com/user',
            clientId: 'gh',
            clientSecret: 'gh-secret',
            scope: 'read:user user:email',
          },
          { id: 'gitlab', clientId: 'gl', clientSecret: 'gl-secret', issuer: 'https://gl.test' },
          {
            id: 'google',
            clientId: 'go',
            clientSecret: 'go-secret',
            hostedDomain: 'example.com',
            prompt: 'select_account',
            mapProfileToUser,
          },
          { id: 'microsoft', clientId: 'ms', clientSecret: 'ms-secret', tenant: 'contoso' },
        ],
      });

      const { socialProviders } = (fake.instances[0] as FakeInstance).options;
      expect(Object.keys(socialProviders)).toEqual(['github', 'gitlab', 'google', 'microsoft']);
      // The descriptive fields stay behind; the scope string becomes a list
      expect(socialProviders.github).toEqual({
        clientId: 'gh',
        clientSecret: 'gh-secret',
        scope: ['read:user', 'user:email'],
      });
      expect(socialProviders.gitlab).toEqual({ clientId: 'gl', clientSecret: 'gl-secret' });
      // Better Auth's own option names go through; MoroJS's names are translated
      expect(socialProviders.google).toEqual({
        clientId: 'go',
        clientSecret: 'go-secret',
        hd: 'example.com',
        prompt: 'select_account',
        mapProfileToUser,
      });
      expect(socialProviders.microsoft).toEqual({
        clientId: 'ms',
        clientSecret: 'ms-secret',
        tenantId: 'contoso',
      });
      expect(auth.providers).toEqual(['github', 'gitlab', 'google', 'microsoft']);
    });

    it('passes on what the provider helpers were given: scope, tenant, hosted domain', async () => {
      await MoroJSAuth({
        ...baseConfig,
        providers: [
          extendedProviders.github({ clientId: 'gh', clientSecret: 's', scope: 'read:user repo' }),
          extendedProviders.google({
            clientId: 'go',
            clientSecret: 's',
            hostedDomain: 'example.com',
          }),
          providers.microsoft({ clientId: 'ms', clientSecret: 's', tenant: 'contoso' }),
        ],
      });
      const { socialProviders } = (fake.instances[0] as FakeInstance).options;
      expect(socialProviders).toEqual({
        github: { clientId: 'gh', clientSecret: 's', scope: ['read:user', 'repo'] },
        google: { clientId: 'go', clientSecret: 's', hd: 'example.com' },
        microsoft: { clientId: 'ms', clientSecret: 's', tenantId: 'contoso' },
      });

      await MoroJSAuth({
        ...baseConfig,
        providers: [
          extendedProviders.microsoft({ clientId: 'ms', clientSecret: 's', tenant: 't1' }),
        ],
      });
      expect((fake.instances[1] as FakeInstance).options.socialProviders.microsoft.tenantId).toBe(
        't1'
      );
    });

    it('leaves out a provider Better Auth cannot build, and keeps the others', async () => {
      const warnings = captureWarnings();
      // Better Auth's cognito needs a domain, a region and a user pool id
      const auth = await MoroJSAuth({
        ...baseConfig,
        providers: [
          { id: 'cognito', clientId: 'cg', clientSecret: 's' },
          { id: 'github', clientId: 'gh', clientSecret: 's' },
        ],
      });

      expect(auth.providers).toEqual(['github']);
      expect(
        warnings(/provider 'cognito' was refused by Better Auth.*DOMAIN_AND_REGION_REQUIRED/)
      ).toHaveLength(1);

      await MoroJSAuth({
        ...baseConfig,
        providers: [
          {
            id: 'cognito',
            clientId: 'cg',
            clientSecret: 's',
            domain: 'd',
            region: 'r',
            userPoolId: 'p',
          },
        ],
      });
      expect(Object.keys((fake.instances[1] as FakeInstance).options.socialProviders)).toEqual([
        'cognito',
      ]);
    });

    it('passes on the session settings Better Auth has', async () => {
      await MoroJSAuth({
        ...baseConfig,
        session: {
          maxAge: 3600,
          updateAge: 600,
          freshAge: 300,
          cookieCache: { enabled: true, maxAge: 60 },
        },
      });
      expect((fake.instances[0] as FakeInstance).options.session).toEqual({
        expiresIn: 3600,
        updateAge: 600,
        freshAge: 300,
        cookieCache: { enabled: true, maxAge: 60 },
      });

      // Without session settings: thirty days, refreshed daily, as before
      await MoroJSAuth(baseConfig);
      expect((fake.instances[1] as FakeInstance).options.session).toEqual({
        expiresIn: 30 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
      });
    });

    it('hands the `betterAuth` options straight through', async () => {
      const database = { kind: 'a database adapter' };
      const plugin = { id: 'a-plugin' };
      await MoroJSAuth({
        ...baseConfig,
        debug: true,
        useSecureCookies: true,
        session: { maxAge: 3600 },
        betterAuth: {
          database,
          emailAndPassword: { enabled: true },
          plugins: [plugin],
          session: { cookieCache: { enabled: true } },
          socialProviders: { discord: { clientId: 'dc', clientSecret: 'dc-secret' } },
          advanced: { cookiePrefix: 'app' },
        },
      });

      const { options } = fake.instances[0] as FakeInstance;
      expect(options.database).toBe(database);
      expect(options.emailAndPassword).toEqual({ enabled: true });
      expect(options.plugins).toEqual([plugin]);
      // Merged with what the Auth.js-style keys produced
      expect(options.session).toEqual({
        expiresIn: 3600,
        updateAge: 24 * 60 * 60,
        cookieCache: { enabled: true },
      });
      expect(Object.keys(options.socialProviders)).toEqual(['github', 'discord']);
      expect(options.advanced).toEqual({
        cookiePrefix: 'app',
        useSecureCookies: true,
        ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-moro-client-ip'] },
      });
      // `debug` turns on Better Auth's own debug logging
      expect(options.logger).toEqual({ level: 'debug' });
      // The adapter's own values are not overridden
      expect(options.secret).toBe(baseConfig.secret);
      expect(options.basePath).toBe('/api/auth');
    });

    it('warns in production when the base URL falls back to localhost', async () => {
      const saved = { ...process.env };
      delete process.env.BASE_URL;
      delete process.env.AUTH_URL;
      process.env.NODE_ENV = 'production';
      try {
        const warnings = captureWarnings();
        const { baseURL: _baseURL, ...withoutBaseURL } = baseConfig;

        await MoroJSAuth(withoutBaseURL);
        expect((fake.instances[0] as FakeInstance).options.baseURL).toBe('http://localhost:3000');
        expect(warnings(/no `baseURL` is configured.*http:\/\/localhost:3000/)).toHaveLength(1);

        // Configured, in code or in the environment: nothing to say
        await MoroJSAuth(baseConfig);
        process.env.BASE_URL = 'https://app.example.com';
        await MoroJSAuth(withoutBaseURL);
        expect((fake.instances[2] as FakeInstance).options.baseURL).toBe('https://app.example.com');
        expect(warnings(/no `baseURL` is configured/)).toHaveLength(1);
      } finally {
        process.env = saved;
      }
    });

    it('leaves the client-address headers alone when the application names them', async () => {
      await MoroJSAuth({
        ...baseConfig,
        betterAuth: { advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } } },
      });
      expect((fake.instances[0] as FakeInstance).options.advanced.ipAddress).toEqual({
        ipAddressHeaders: ['cf-connecting-ip'],
      });
    });

    it('names, once at start-up, every key it cannot translate and what to use instead', async () => {
      const warnings = captureWarnings();
      await MoroJSAuth({
        ...baseConfig,
        providers: [
          { id: 'github', clientId: 'gh', clientSecret: 'gh-secret' },
          { id: 'okta', type: 'oidc', clientId: 'ok', clientSecret: 'ok-secret' },
          { id: 'credentials', type: 'credentials', authorize: async () => null },
        ],
        callbacks: { signIn: async () => true },
        events: { signIn: async () => undefined },
        pages: { signIn: '/login' },
        adapter: {},
        session: { strategy: 'jwt', maxAge: 3600 },
      });

      expect(warnings(/'callbacks' is not used.*databaseHooks/)).toHaveLength(1);
      expect(warnings(/'events' is not used.*databaseHooks/)).toHaveLength(1);
      expect(warnings(/'pages' is not used.*errorURL/)).toHaveLength(1);
      expect(warnings(/'adapter' is not used.*betterAuth: \{ database \}/)).toHaveLength(1);
      expect(warnings(/'session\.strategy' is not used/)).toHaveLength(1);
      expect(
        warnings(/provider 'okta' is not a Better Auth social provider.*genericOAuth/)
      ).toHaveLength(1);
      expect(warnings(/provider 'credentials'.*emailAndPassword/)).toHaveLength(1);
      // Neither key reached Better Auth
      const { options } = fake.instances[0] as FakeInstance;
      for (const key of ['callbacks', 'events', 'pages', 'adapter']) {
        expect(options).not.toHaveProperty(key);
      }
      expect(options.session).not.toHaveProperty('strategy');

      // A configuration it translates in full draws no warning
      const before = warnings(/Better Auth adapter/).length;
      expect(before).toBe(7);
      await MoroJSAuth({ ...baseConfig, session: { maxAge: 3600 } });
      expect(warnings(/Better Auth adapter/)).toHaveLength(before);
    });
  });

  // twoFactor(), organization(), anonymous(), bearerToken(), accountLinking()
  // and rateLimit(): what each one hands to Better Auth. The plugin modules
  // resolve to the stand-in, whose factories return { id, options }.
  describe('feature helpers', () => {
    const optionsFor = async (config: Partial<MoroJSAuthConfig>) => {
      await MoroJSAuth({ ...baseConfig, ...config });
      return (fake.instances[fake.instances.length - 1] as FakeInstance).options;
    };
    const pluginOf = (options: Record<string, any>, id: string) =>
      (options.plugins as Array<{ id: string; options: Record<string, any> }>).find(
        entry => entry.id === id
      );
    const database = { kind: 'a migrated database' };

    it('load each plugin from the application and hand it the options the helper stands for', async () => {
      const options = await optionsFor({
        plugins: [
          twoFactor({ issuer: 'Acme', backupCodesCount: 4, trustDeviceDuration: 3600 }),
          organization({ maxOrganizationsPerUser: 3 }),
          anonymous(),
          bearerToken(),
        ],
        betterAuth: { database },
      });

      expect(options.plugins).toEqual([
        {
          id: 'two-factor',
          options: {
            issuer: 'Acme',
            backupCodeOptions: { amount: 4 },
            trustDeviceMaxAge: 3600,
          },
        },
        {
          id: 'organization',
          options: { allowUserToCreateOrganization: true, organizationLimit: 3 },
        },
        { id: 'anonymous', options: {} },
        { id: 'bearer', options: {} },
      ]);
    });

    it('fill in the documented defaults', async () => {
      const options = await optionsFor({
        plugins: [twoFactor(), organization()],
        betterAuth: { database },
      });
      expect(pluginOf(options, 'two-factor')?.options).toEqual({
        issuer: 'MoroJS App',
        backupCodeOptions: { amount: 10 },
        trustDeviceMaxAge: 2592000,
      });
      expect(pluginOf(options, 'organization')?.options).toEqual({
        allowUserToCreateOrganization: true,
        organizationLimit: 10,
      });
    });

    it('turn a feature off through the option Better Auth has for it', async () => {
      const options = await optionsFor({
        plugins: [
          twoFactor({ totp: false, backupCodes: false, trustDevice: false }),
          organization({ allowUserCreate: false }),
          anonymous({ linkOnSignUp: false }),
        ],
        betterAuth: { database, appName: 'Shop' },
      });
      expect(pluginOf(options, 'two-factor')?.options).toEqual({
        // No issuer was asked for: the application's name, not the helper's
        issuer: 'Shop',
        totpOptions: { disable: true },
        backupCodeOptions: { amount: 0 },
        trustDeviceMaxAge: 0,
      });
      expect(pluginOf(options, 'organization')?.options).toMatchObject({
        allowUserToCreateOrganization: false,
      });
      expect(pluginOf(options, 'anonymous')?.options).toEqual({
        disableDeleteAnonymousUser: true,
      });
    });

    it("hand a helper's `betterAuth` options to its plugin, over the derived ones", async () => {
      const onLinkAccount = async () => undefined;
      const sendOTP = async () => undefined;
      const options = await optionsFor({
        plugins: [
          twoFactor({
            issuer: 'Acme',
            betterAuth: { otpOptions: { sendOTP }, backupCodeOptions: { length: 12 } },
          }),
          organization({ betterAuth: { organizationLimit: 1, creatorRole: 'admin' } }),
          anonymous({ betterAuth: { onLinkAccount } }),
          bearerToken({ betterAuth: { requireSignature: true } }),
        ],
        betterAuth: { database },
      });
      expect(pluginOf(options, 'two-factor')?.options).toEqual({
        issuer: 'Acme',
        otpOptions: { sendOTP },
        // Merged with the derived amount
        backupCodeOptions: { amount: 10, length: 12 },
        trustDeviceMaxAge: 2592000,
      });
      expect(pluginOf(options, 'organization')?.options).toEqual({
        allowUserToCreateOrganization: true,
        organizationLimit: 1,
        creatorRole: 'admin',
      });
      expect(pluginOf(options, 'anonymous')?.options).toEqual({ onLinkAccount });
      expect(pluginOf(options, 'bearer')?.options).toEqual({ requireSignature: true });
    });

    it('keep the plugins the application passes by hand, and add theirs after', async () => {
      const admin = { id: 'admin' };
      const options = await optionsFor({
        plugins: [bearerToken()],
        betterAuth: { plugins: [admin] },
      });
      expect(options.plugins).toEqual([admin, { id: 'bearer', options: {} }]);
    });

    it('leave a plugin the application also passes by hand to the application, with one warning', async () => {
      const warnings = captureWarnings();
      const byHand = { id: 'two-factor', options: { issuer: 'By hand' } };
      const options = await optionsFor({
        plugins: [twoFactor({ issuer: 'From the helper' }), bearerToken(), bearerToken()],
        betterAuth: { database, plugins: [byHand] },
      });

      expect(options.plugins).toEqual([byHand, { id: 'bearer', options: {} }]);
      expect(
        warnings(
          /twoFactor\(\): `betterAuth\.plugins` already holds Better Auth's 'two-factor' plugin/
        )
      ).toHaveLength(1);
      expect(warnings(/bearerToken\(\) was passed more than once/)).toHaveLength(1);
    });

    it('map accountLinking() onto account.accountLinking', async () => {
      const linking = async (helper: ReturnType<typeof accountLinking>) =>
        (await optionsFor({ accountLinking: helper })).account.accountLinking;

      // The helper's default: linking by hand only
      expect(await linking(accountLinking())).toEqual({
        enabled: true,
        disableImplicitLinking: true,
      });
      expect(await linking(accountLinking({ autoLinkSameEmail: true }))).toEqual({
        enabled: true,
        disableImplicitLinking: false,
      });
      expect(await linking(accountLinking({ allowManualLink: false }))).toEqual({ enabled: false });

      // Better Auth cannot turn off only the manual kind
      const warnings = captureWarnings();
      expect(
        await linking(accountLinking({ autoLinkSameEmail: true, allowManualLink: false }))
      ).toEqual({ enabled: true, disableImplicitLinking: false });
      expect(warnings(/accountLinking\(\): 'allowManualLink: false' is not applied/)).toHaveLength(
        1
      );
    });

    it('merge accountLinking() with what the application sets in betterAuth.account', async () => {
      const options = await optionsFor({
        accountLinking: accountLinking(),
        betterAuth: {
          account: {
            encryptOAuthTokens: true,
            accountLinking: { trustedProviders: ['github'], disableImplicitLinking: false },
          },
        },
      });
      expect(options.account).toEqual({
        encryptOAuthTokens: true,
        accountLinking: {
          enabled: true,
          // What the application names itself is the value used
          disableImplicitLinking: false,
          trustedProviders: ['github'],
        },
      });
    });

    it("map rateLimit() onto a rule for Better Auth's sign-in routes, and turn its limiter on", async () => {
      expect((await optionsFor({ rateLimit: rateLimit() })).rateLimit).toEqual({
        enabled: true,
        customRules: { '/sign-in/*': { window: 300, max: 5 } },
      });

      const options = await optionsFor({
        rateLimit: rateLimit({ maxAttempts: 3, window: 60 }),
        betterAuth: {
          rateLimit: { storage: 'database', customRules: { '/sign-up/*': { window: 60, max: 2 } } },
        },
      });
      expect(options.rateLimit).toEqual({
        enabled: true,
        storage: 'database',
        customRules: {
          '/sign-in/*': { window: 60, max: 3 },
          '/sign-up/*': { window: 60, max: 2 },
        },
      });
    });

    it('name, once at start-up, each option Better Auth has no equivalent for', async () => {
      const warnings = captureWarnings();
      await optionsFor({
        plugins: [
          organization({ organizationRoles: false }),
          anonymous({ sessionDuration: 3600 }),
          bearerToken({ expiresIn: 600, refreshTokens: false, refreshTokenExpiresIn: 86400 }),
        ],
        rateLimit: rateLimit({ lockoutDuration: 600 }),
        betterAuth: { database },
      });

      expect(warnings(/organization\(\): 'organizationRoles: false' is not applied/)).toHaveLength(
        1
      );
      expect(
        warnings(/anonymous\(\): 'sessionDuration' is not applied.*2592000 seconds/)
      ).toHaveLength(1);
      expect(warnings(/bearerToken\(\): 'expiresIn' is not applied.*session\.maxAge/)).toHaveLength(
        1
      );
      expect(warnings(/bearerToken\(\): 'refreshTokens' is not applied/)).toHaveLength(1);
      expect(warnings(/bearerToken\(\): 'refreshTokenExpiresIn' is not applied/)).toHaveLength(1);
      expect(warnings(/rateLimit\(\): 'lockoutDuration' is not applied/)).toHaveLength(1);
      expect(warnings(/Better Auth adapter/)).toHaveLength(6);
    });

    it('say each of those once in a process, however often the handlers are created', async () => {
      const warnings = captureWarnings();
      const config = {
        plugins: [bearerToken({ expiresIn: 600 }), anonymous({ sessionDuration: 3600 })],
        rateLimit: rateLimit({ lockoutDuration: 600 }),
        callbacks: { signIn: async () => true },
        betterAuth: { database },
      };
      // A script that prepares the database, then the application itself
      await optionsFor(config);
      await optionsFor(config);

      expect(warnings(/bearerToken\(\): 'expiresIn' is not applied/)).toHaveLength(1);
      expect(warnings(/anonymous\(\): 'sessionDuration' is not applied/)).toHaveLength(1);
      expect(warnings(/rateLimit\(\): 'lockoutDuration' is not applied/)).toHaveLength(1);
      expect(warnings(/'callbacks' is not used/)).toHaveLength(1);

      // A different message is still said
      await optionsFor({ ...config, rateLimit: rateLimit({ lockoutDuration: 601, window: 30 }) });
      expect(warnings(/rateLimit\(\): 'lockoutDuration' is not applied/)).toHaveLength(2);
    });

    it('say nothing about options that were left at their defaults', async () => {
      const warnings = captureWarnings();
      const options = await optionsFor({
        plugins: [twoFactor(), organization(), anonymous(), bearerToken()],
        accountLinking: accountLinking(),
        rateLimit: rateLimit(),
        session: { maxAge: 7 * 24 * 60 * 60 },
        betterAuth: { database },
      });
      expect(options.plugins).toHaveLength(4);
      expect(warnings(/Better Auth adapter/)).toEqual([]);
    });

    it('put a helper passed in the wrong place where it belongs, and say so', async () => {
      const warnings = captureWarnings();
      const options = await optionsFor({
        // A JavaScript caller; the types refuse this
        plugins: [rateLimit({ maxAttempts: 2 }), accountLinking(), { id: 'admin' }] as any,
      });
      expect(options.rateLimit.customRules['/sign-in/*']).toEqual({ window: 300, max: 2 });
      expect(options.account.accountLinking).toEqual({
        enabled: true,
        disableImplicitLinking: true,
      });
      expect(options.plugins).toBeUndefined();
      expect(
        warnings(/rateLimit\(\) was passed in `plugins`; it belongs under `rateLimit`/)
      ).toHaveLength(1);
      expect(
        warnings(/accountLinking\(\) was passed in `plugins`; it belongs under `accountLinking`/)
      ).toHaveLength(1);
      expect(
        warnings(
          /an entry of `plugins` is not one of twoFactor\(\).*betterAuth: \{ plugins: \[\.\.\.\] \}/
        )
      ).toHaveLength(1);
    });

    it('refuse a helper object in the wrong place at compile time', () => {
      const config: MoroJSAuthConfig = {
        ...baseConfig,
        plugins: [twoFactor(), organization(), anonymous(), bearerToken()],
        accountLinking: accountLinking(),
        rateLimit: rateLimit(),
      };
      expect(config.plugins).toHaveLength(4);

      // @ts-expect-error rateLimit() is not a plugin
      const inPlugins: MoroJSAuthConfig = { plugins: [rateLimit()] };
      // @ts-expect-error twoFactor() is not the rate limit
      const asRateLimit: MoroJSAuthConfig = { rateLimit: twoFactor() };
      // @ts-expect-error rateLimit() is not account linking
      const asAccountLinking: MoroJSAuthConfig = { accountLinking: rateLimit() };
      expect([inPlugins, asRateLimit, asAccountLinking]).toHaveLength(3);
    });

    it('load no plugin module for an application that uses no helper', async () => {
      await optionsFor({ betterAuth: { database } });
      const resolved = (packageUtils.resolveUserPackage as jest.Mock).mock.calls.map(c => c[0]);
      expect(resolved.filter(name => String(name).startsWith('better-auth/plugins'))).toEqual([]);

      await optionsFor({ plugins: [bearerToken()] });
      const after = (packageUtils.resolveUserPackage as jest.Mock).mock.calls.map(c => c[0]);
      // Only the module of the plugin that is used
      expect(after.filter(name => String(name).startsWith('better-auth/plugins'))).toEqual([
        'better-auth/plugins/bearer',
      ]);
    });

    it('say what to install when the installed better-auth does not have the plugin', async () => {
      (packageUtils.resolveUserPackage as jest.Mock).mockImplementation((name: unknown) => {
        if (String(name).startsWith('better-auth/plugins')) {
          throw new Error(`Package subpath './plugins' is not defined by "exports"`);
        }
        return FAKE;
      });

      await expect(MoroJSAuth({ ...baseConfig, plugins: [organization()] })).rejects.toThrow(
        /organization\(\) needs the 'organization' plugin of the 'better-auth' package.*npm install better-auth@latest/
      );
      // Nothing was started without it
      expect(fake.instances).toHaveLength(0);
    });

    it('find a plugin in the `better-auth/plugins` barrel when it has no module of its own', async () => {
      (packageUtils.resolveUserPackage as jest.Mock).mockImplementation((name: unknown) => {
        if (String(name).startsWith('better-auth/plugins/')) {
          throw new Error(`Package subpath is not defined by "exports"`);
        }
        return FAKE;
      });
      const options = await optionsFor({ plugins: [anonymous()] });
      expect(options.plugins).toEqual([{ id: 'anonymous', options: {} }]);
    });

    it('say at start-up that the data of the helpers is held in memory when there is no database', async () => {
      const logs = captureLogs();
      await optionsFor({ plugins: [twoFactor(), organization(), anonymous(), bearerToken()] });

      const said = logs('warn', /keep their data in Better Auth's database and none is configured/);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/twoFactor\(\), organization\(\), anonymous\(\) keep their data/);
      expect(said[0]).toMatch(/betterAuth: \{ database \}/);
      expect(said[0]).toMatch(/table `twoFactor`, column `user\.twoFactorEnabled`/);
      // bearerToken() stores nothing
      expect(said[0]).not.toMatch(/bearerToken/);

      // ...and nothing for a helper that stores nothing
      await optionsFor({ plugins: [bearerToken()], rateLimit: rateLimit() });
      expect(logs('warn', /none is configured/)).toHaveLength(1);
    });

    it('say at start-up what the database is missing, once the routes are being served', async () => {
      const logs = captureLogs();
      const config = {
        ...baseConfig,
        plugins: [twoFactor(), organization()],
        betterAuth: { database: { missingTables: ['twoFactor', 'organization', 'member'] } },
      };

      // On its own MoroJSAuth() says nothing: a script may be using its
      // instance to create those very tables
      const handlers = await MoroJSAuth(config);
      expect(typeof handlers.handler).toBe('function');
      expect(logs('error', /auth database/)).toEqual([]);

      app = await createApp({ logger: { level: 'fatal' } });
      globalLogger.setLevel('warn');
      await app.use(createAuthMiddleware(config));

      const said = logs('error', /the auth database does not have the tables and columns/);
      expect(said).toHaveLength(1);
      // What Better Auth reports, on one line, with the command that fixes it
      expect(said[0]).toMatch(/Missing tables twoFactor, organization, member/);
      expect(said[0]).toMatch(/npx auth migrate/);
      expect(said[0]).not.toMatch(/\n/);
      expect(said[0]).toMatch(/organization\(\): tables `organization`, `member`, `invitation`/);

      // The application still starts, and an auth route answers 500 as JSON
      app.get('/plain', () => ({ ok: true }));
      await listen();
      expect((await request('/plain')).status).toBe(200);
      const refused = await request('/api/auth/ok');
      expect(refused.status).toBe(500);
      expect(await refused.json()).toEqual({
        error: 'Internal server error',
        message: 'Authentication error',
      });

      // A database that has everything draws no message
      await closeApp(app);
      app = await createApp({ logger: { level: 'fatal' } });
      globalLogger.setLevel('warn');
      await app.use(
        createAuthMiddleware({ ...baseConfig, plugins: [twoFactor()], betterAuth: { database } })
      );
      expect(logs('error', /auth database/)).toHaveLength(1);
      expect(logs('warn', /Better Auth adapter/)).toEqual([]);
    });

    it('do not hold start-up when the database does not answer the check', async () => {
      const handlers = await MoroJSAuth({
        ...baseConfig,
        plugins: [twoFactor()],
        betterAuth: { database: { neverAnswers: true } },
      });

      jest.useFakeTimers();
      try {
        let finished = false;
        const checked = checkAuthStorage(handlers).then(() => {
          finished = true;
        });
        await jest.advanceTimersByTimeAsync(2000);
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(1500);
        await checked;
        expect(finished).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // Each of the two servers runs request hooks, global middleware and the
  // router itself, so what createAuthMiddleware() installs is checked on both.
  describe.each(['node', 'moro'] as const)('createAuthMiddleware() on the %s server', engine => {
    const start = async (config: MoroJSAuthConfig = baseConfig, routes?: () => void) => {
      app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
      await app.use(createAuthMiddleware(config));
      app.get('/me', (req: any) => ({
        isAuthenticated: req.auth.isAuthenticated,
        user: req.auth.user,
        fromGetUser: req.auth.getUser(),
        session: req.auth.session,
        signIn: req.auth.signIn('github', { callbackUrl: '/dashboard' }),
        signOut: req.auth.signOut(),
      }));
      app
        .get('/dashboard')
        .before(requireAuth())
        .handler((req: any) => ({ hello: req.auth.user.name }));
      app
        .get('/editors')
        .before(requireRole('editor'))
        .handler(() => ({ ok: true }));
      routes?.();
      await listen();
      return fake.instances[0] as FakeInstance;
    };

    it('attaches an unauthenticated req.auth when there is no session', async () => {
      await start();
      const res = await request('/me');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        isAuthenticated: false,
        user: null,
        fromGetUser: null,
        session: null,
        signIn: { url: '/api/auth/signin/github?provider=github&callbackUrl=%2Fdashboard' },
        signOut: { url: '/api/auth/signout' },
      });
    });

    it('attaches the session user when the request carries a session cookie', async () => {
      const instance = await start();
      const res = await request('/me', { headers: { cookie: SESSION_COOKIE } });
      const body = (await res.json()) as any;

      expect(body.isAuthenticated).toBe(true);
      expect(body.user).toEqual({ id: 'u1', name: 'Ada', email: 'ada@example.com', image: null });
      expect(body.fromGetUser).toEqual(body.user);
      expect(body.session).toEqual({ user: body.user, expires: '2030-01-01T00:00:00.000Z' });

      // The lookup was given the request's own cookie header
      const lookups = instance.sessionLookups;
      expect(lookups[lookups.length - 1]?.cookie).toBe(SESSION_COOKIE);
    });

    it("serves Better Auth's routes under the base path, with no route mounted by hand", async () => {
      const instance = await start();

      const ok = await request('/api/auth/ok');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });

      const session = await request('/api/auth/get-session?disableCookieCache=true', {
        headers: { cookie: SESSION_COOKIE },
      });
      expect(((await session.json()) as any).user.id).toBe('u1');

      // A path of any depth is Better Auth's to answer, and so is its 404
      expect((await request('/api/auth/two-factor/totp/verify', { method: 'POST' })).status).toBe(
        404
      );

      expect(instance.requests.map(r => `${r.method} ${r.pathname}${r.search}`)).toEqual([
        'GET /api/auth/ok',
        'GET /api/auth/get-session?disableCookieCache=true',
        'POST /api/auth/two-factor/totp/verify',
      ]);
      // Each was handed over once, and without a second session lookup for req.auth
      expect(instance.sessionLookups).toEqual([]);

      // Everything outside the base path is the application's
      expect((await request('/api/authors')).status).toBe(404);
      expect((await request('/api/auth/ok', { method: 'OPTIONS' })).status).not.toBe(200);
      expect(instance.requests).toHaveLength(3);
    });

    it('tells Better Auth the address of the client, which only the server knows', async () => {
      const instance = await start();

      // What Better Auth keys its rate limits by: without it every client is one
      await request('/api/auth/ok');
      await request('/api/auth/signin/github');
      // A client cannot name its own address
      await request('/api/auth/ok', { headers: { 'x-moro-client-ip': '203.0.113.9' } });

      const addresses = instance.requests.map(r => r.headers['x-moro-client-ip']);
      expect(addresses).toHaveLength(3);
      for (const address of addresses) {
        expect(address).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
      }
      expect(instance.options.advanced.ipAddress.ipAddressHeaders).toEqual([
        'x-forwarded-for',
        'x-moro-client-ip',
      ]);
    });

    // server.trustProxy says whether X-Forwarded-For can be believed. Set, the
    // address Better Auth counts is req.ip and nothing a request claims.
    describe('the client address with server.trustProxy', () => {
      const startWith = async (
        trustProxy: boolean | number | undefined,
        config: MoroJSAuthConfig = baseConfig
      ) => {
        app = await createApp({
          logger: { level: 'fatal' },
          server: { engine, ...(trustProxy !== undefined ? { trustProxy } : {}) },
        });
        globalLogger.setLevel('warn');
        await app.use(createAuthMiddleware(config));
        await listen();
        return fake.instances[fake.instances.length - 1] as FakeInstance;
      };
      const forwarded = (address: string) => ({ headers: { 'x-forwarded-for': address } });
      const wrongPassword = (address: string) =>
        request('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
          body: JSON.stringify({ email: 'ada@example.com', password: 'wrong' }),
        });
      const sixAttempts = async () => {
        const statuses: number[] = [];
        for (let n = 1; n <= 6; n++) statuses.push((await wrongPassword(`203.0.113.${n}`)).status);
        return statuses;
      };
      const limited = { ...baseConfig, rateLimit: rateLimit({ maxAttempts: 5 }) };

      it('false: a forwarding header a client sends is not handed to Better Auth', async () => {
        const instance = await startWith(false);
        await request('/api/auth/ok', forwarded('203.0.113.9'));
        await request('/api/auth/signin/github', forwarded('203.0.113.9'));

        expect(instance.requests).toHaveLength(2);
        for (const seen of instance.requests) {
          expect(seen.headers['x-forwarded-for']).toBeUndefined();
          expect(seen.headers['x-moro-client-ip']).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
        }

        // An application that names the address source itself keeps its requests whole
        await closeApp(app);
        const own = await startWith(false, {
          ...baseConfig,
          betterAuth: { advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } } },
        });
        await request('/api/auth/ok', forwarded('203.0.113.9'));
        expect((own.requests[0] as FakeRequest).headers['x-forwarded-for']).toBe('203.0.113.9');
      });

      it('a hop count: Better Auth is given the client the trusted proxy reported', async () => {
        const instance = await startWith(1);
        // This test's own connection is the one trusted proxy
        await request('/api/auth/ok', forwarded('198.51.100.1, 203.0.113.9'));

        const seen = instance.requests[0] as FakeRequest;
        expect(seen.headers['x-moro-client-ip']).toBe('203.0.113.9');
        expect(seen.headers['x-forwarded-for']).toBeUndefined();
      });

      it('set: six sign-in attempts under six forwarded addresses are one client to the limit', async () => {
        const logs = captureLogs();
        await startWith(false, limited);
        expect(await sixAttempts()).toEqual([401, 401, 401, 401, 401, 429]);
        expect(logs('warn', /rate limit of the auth routes/)).toEqual([]);
      });

      it('unset: each forwarded address is counted on its own, and start-up says so once', async () => {
        const logs = captureLogs();
        const instance = await startWith(undefined, limited);
        expect(await sixAttempts()).toEqual([401, 401, 401, 401, 401, 401]);
        // The header reached Better Auth as it came, as before
        expect((instance.requests[0] as FakeRequest).headers['x-forwarded-for']).toBe(
          '203.0.113.1'
        );

        const said = logs('warn', /rate limit of the auth routes is in force/);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(/`server\.trustProxy` is not set/);
        expect(said[0]).toMatch(/X-Forwarded-For/);

        // Nothing more is said where nothing is limited, or where the
        // application names the proxies Better Auth should trust
        await closeApp(app);
        forgetStartupWarnings();
        await startWith(undefined);
        await closeApp(app);
        await startWith(undefined, {
          ...limited,
          betterAuth: { advanced: { ipAddress: { trustedProxies: ['10.0.0.0/8'] } } },
        });
        expect(logs('warn', /rate limit of the auth routes is in force/)).toHaveLength(1);
      });

      it('unset in production, where Better Auth limits by itself: the same warning', async () => {
        const saved = { ...process.env };
        process.env.NODE_ENV = 'production';
        try {
          const logs = captureLogs();
          await startWith(undefined);
          expect(logs('warn', /rate limit of the auth routes is in force/)).toHaveLength(1);

          // Turned off by the application: nothing is limited, nothing to say
          await closeApp(app);
          forgetStartupWarnings();
          await startWith(undefined, {
            ...baseConfig,
            betterAuth: { rateLimit: { enabled: false } },
          });
          expect(logs('warn', /rate limit of the auth routes is in force/)).toHaveLength(1);
        } finally {
          process.env = saved;
        }
      });
    });

    it('completes a sign-in from the URL req.auth.signIn() returns, and signs out again', async () => {
      const instance = await start();
      const { signIn } = (await (await request('/me')).json()) as any;

      // The browser is sent to the sign-in URL
      const started = await request(signIn.url);
      expect(started.status).toBe(302);
      expect(started.headers.get('location')).toBe(
        'https://provider.example/authorize?client_id=client-id&next=%2Fdashboard'
      );
      expect(started.headers.getSetCookie().some(c => c.startsWith('fake.state=abc'))).toBe(true);
      // Better Auth was asked the way its own client asks
      const asked = instance.requests[0] as FakeRequest;
      expect(`${asked.method} ${asked.pathname}`).toBe('POST /api/auth/sign-in/social');
      expect(asked.headers['content-type']).toBe('application/json');
      expect(JSON.parse(asked.body)).toEqual({ provider: 'github', callbackURL: '/dashboard' });

      // The provider sends the browser back; the session cookie is issued
      const callback = await request('/api/auth/callback/github?code=abc&state=xyz');
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('/dashboard');
      const cookie = callback.headers.getSetCookie().map(c => c.split('; ')[0])[1] as string;
      expect(cookie).toBe(SESSION_COOKIE);

      // req.auth and the guards recognise it
      const me = (await (await request('/me', { headers: { cookie } })).json()) as any;
      expect(me.isAuthenticated).toBe(true);
      const dashboard = await request('/dashboard', { headers: { cookie } });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.json()).toEqual({ hello: 'Ada' });
      expect((await request('/dashboard')).status).toBe(401);

      // A form on the application's own pages posts to the sign-out URL
      const signedOut = await navigate(`${me.signOut.url}?callbackUrl=%2Fgoodbye`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': FORM, 'sec-fetch-mode': 'navigate' },
        body: '',
      });
      expect(signedOut.status).toBe(302);
      expect(signedOut.location).toBe('/goodbye');
      expect(signedOut.cookies).toEqual(['fake.session_token=', 'fake.session_data=']);
    });

    it('starts a sign-in from a posted form too, and leaves a script the JSON answer', async () => {
      await start();

      const form = await navigate('/api/auth/signin/github', {
        method: 'POST',
        headers: { 'content-type': FORM, 'sec-fetch-mode': 'navigate' },
        body: 'callbackUrl=%2Faccount',
      });
      expect(form.status).toBe(302);
      expect(form.location).toBe(
        'https://provider.example/authorize?client_id=client-id&next=%2Faccount'
      );

      // fetch() from a page: a redirect would send the fetch itself to the provider
      const script = await request('/api/auth/signin/github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callbackUrl: '/account' }),
      });
      expect(script.status).toBe(200);
      expect(await script.json()).toEqual({
        url: 'https://provider.example/authorize?client_id=client-id&next=%2Faccount',
        redirect: true,
      });

      expect((await request('/api/auth/signin/unknown')).status).toBe(404);
    });

    it('answers a script with what Better Auth answered and a submitted form with a redirect', async () => {
      const instance = await start();

      // Better Auth's own client: JSON in, JSON out, the Location header kept
      const social = await request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: '/dashboard' }),
      });
      expect(social.status).toBe(200);
      const answer = (await social.json()) as any;
      expect(answer.redirect).toBe(true);
      expect(social.headers.get('location')).toBe(answer.url);

      const byScript = await request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'correct horse',
          callbackURL: '/in',
        }),
      });
      expect(byScript.status).toBe(200);
      expect(((await byScript.json()) as any).user.id).toBe('u1');

      // A browser submitting a form is navigating: it needs the redirect
      const form = 'email=ada%40example.com&password=correct+horse&callbackURL=%2Fin';
      const byForm = await navigate('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': FORM, 'sec-fetch-mode': 'navigate' },
        body: form,
      });
      expect(byForm.status).toBe(302);
      expect(byForm.location).toBe('/in');
      expect(byForm.cookies).toEqual([SESSION_COOKIE]);
      // The form reached Better Auth as a form
      const relayed = instance.requests[instance.requests.length - 1] as FakeRequest;
      expect(relayed.headers['content-type']).toBe(FORM);
      expect(relayed.body).toBe(form);

      // So is a client that sends no fetch metadata and posts a form
      const plainForm = await navigate('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: form,
      });
      expect(plainForm.status).toBe(302);

      // A fetch() that posts a form is not navigating, and says so
      const fetched = await request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: form,
      });
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('location')).toBe('/in');

      // A failure is relayed as it is, to either
      const refused = await navigate('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': FORM, 'sec-fetch-mode': 'navigate' },
        body: 'email=ada%40example.com&password=wrong',
      });
      expect(refused.status).toBe(401);
    });

    it('ends the session on a GET only for a navigation the browser calls same-origin', async () => {
      const instance = await start();
      const cookie = SESSION_COOKIE;

      // No statement of where the navigation came from: only a POST will do
      const bare = await request('/api/auth/signout', { headers: { cookie } });
      expect(bare.status).toBe(405);
      expect(bare.headers.get('allow')).toBe('POST');
      const crossSite = await request('/api/auth/signout', {
        headers: { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      });
      expect(crossSite.status).toBe(405);
      expect(instance.requests).toEqual([]);

      // A form posted from another site is Better Auth's to refuse
      const foreignForm = await navigate('/api/auth/signout', {
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://elsewhere.example',
          'content-type': FORM,
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'cross-site',
        },
        body: '',
      });
      expect(foreignForm.status).toBe(403);
      expect((instance.requests[0] as FakeRequest).headers.origin).toBe(
        'https://elsewhere.example'
      );

      const sameOrigin = await request(
        '/api/auth/signout?callbackUrl=https%3A%2F%2Felsewhere.example%2F',
        { headers: { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' } }
      );
      expect(sameOrigin.status).toBe(302);
      // Not a path on this site and not a trusted origin
      expect(sameOrigin.headers.get('location')).toBe('/');
      expect(sameOrigin.headers.getSetCookie().map(c => c.split('; ')[0])).toContain(
        'fake.session_token='
      );

      // A script gets Better Auth's own answer
      const byScript = await request('/api/auth/signout', {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(byScript.status).toBe(200);
      expect(await byScript.json()).toEqual({ success: true });
    });

    it('offers the configured providers at the sign-in URL without a provider', async () => {
      await start({
        ...baseConfig,
        providers: [
          { id: 'github', clientId: 'gh', clientSecret: 'gh-secret' },
          { id: 'gitlab', clientId: 'gl', clientSecret: 'gl-secret' },
        ],
      });

      const asJson = await request('/api/auth/signin?callbackUrl=%2Fdashboard');
      expect(asJson.status).toBe(200);
      expect(await asJson.json()).toEqual({
        providers: [
          {
            id: 'github',
            signInUrl: '/api/auth/signin/github?provider=github&callbackUrl=%2Fdashboard',
          },
          {
            id: 'gitlab',
            signInUrl: '/api/auth/signin/gitlab?provider=gitlab&callbackUrl=%2Fdashboard',
          },
        ],
      });

      const page = await request('/api/auth/signin?callbackUrl=%22%3E%3Cscript%3E', {
        headers: { accept: 'text/html' },
      });
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      const html = await page.text();
      expect(html).toContain('href="/api/auth/signin/gitlab?provider=gitlab&amp;callbackUrl=');
      expect(html).not.toContain('"><script>');
    });

    it('goes straight to the provider when there is only one', async () => {
      await start();
      const res = await request('/api/auth/signin?callbackUrl=%2Fdashboard');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        '/api/auth/signin/github?provider=github&callbackUrl=%2Fdashboard'
      );
    });

    it('gives req.auth.user the fields the application keeps on its users', async () => {
      await start();
      const cookie = fake.STAFF_COOKIE;

      const me = (await (await request('/me', { headers: { cookie } })).json()) as any;
      expect(me.user).toEqual({
        id: 'u2',
        name: 'Grace',
        email: 'grace@example.com',
        image: null,
        emailVerified: true,
        role: 'admin,editor',
        // A single `role` text is also what the guards read as `roles`
        roles: 'admin,editor',
        permissions: ['reports:read'],
        tenant: 'acme',
      });
      expect((await request('/editors', { headers: { cookie } })).status).toBe(200);
      expect((await request('/editors', { headers: { cookie: SESSION_COOKIE } })).status).toBe(403);
    });

    it('puts the active organization of organization() on req.auth.session', async () => {
      await start({ ...baseConfig, plugins: [organization()], betterAuth: { database: {} } });
      const res = await request('/me', { headers: { cookie: SESSION_COOKIE } });
      const body = (await res.json()) as any;
      expect(body.isAuthenticated).toBe(true);
      expect(body.session.activeOrganizationId).toBe(fake.ACTIVE_ORGANIZATION);

      // Without the plugin the session has no such field
      await closeApp(app);
      await start();
      const plain = (await (
        await request('/me', { headers: { cookie: SESSION_COOKIE } })
      ).json()) as any;
      expect(plain.session).toEqual({ user: plain.user, expires: '2030-01-01T00:00:00.000Z' });
    });

    it('relays a refusal that has a JSON content type and no body', async () => {
      await start({ ...baseConfig, plugins: [organization()], betterAuth: { database: {} } });
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', slug: 'acme' }),
      };

      // No session: Better Auth's 401, not a 500 from reading the empty body
      const refused = await request('/api/auth/organization/create', init);
      expect(refused.status).toBe(401);
      expect(await refused.text()).toBe('');

      const created = await request('/api/auth/organization/create', {
        ...init,
        headers: { ...init.headers, cookie: SESSION_COOKIE, origin: ORIGIN },
      });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({
        id: fake.ACTIVE_ORGANIZATION,
        name: 'Acme',
        slug: 'acme',
      });
    });

    it('accepts a session token as a Bearer token with bearerToken(), and not without it', async () => {
      const authorization = `Bearer ${fake.SESSION_TOKEN}`;
      await start({ ...baseConfig, plugins: [bearerToken()] });
      expect((await request('/dashboard', { headers: { authorization } })).status).toBe(200);
      expect(
        (
          (await (
            await request('/api/auth/get-session', { headers: { authorization } })
          ).json()) as any
        ).user.id
      ).toBe('u1');

      await closeApp(app);
      await start();
      expect((await request('/dashboard', { headers: { authorization } })).status).toBe(401);
    });

    it('leaves a route the application has under the base path to the application', async () => {
      // An application that mounted the handler by hand before the routes were served
      let byHand!: FakeInstance;
      let handled = 0;
      const mounted = await start(baseConfig, () => {
        const pending = MoroJSAuth(baseConfig).then(auth => {
          byHand = fake.instances[fake.instances.length - 1] as FakeInstance;
          return auth;
        });
        const forward = async (req: HttpRequest, res: HttpResponse) => {
          handled++;
          return (await pending).handler(req, res);
        };
        for (const method of ['get', 'post'] as const) {
          app[method]('/api/auth/:action', forward);
          app[method]('/api/auth/:action/:provider', forward);
        }
      });

      expect((await request('/api/auth/ok')).status).toBe(200);
      const signIn = await request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github' }),
      });
      expect(signIn.status).toBe(200);
      expect((await request('/api/auth/callback/github?code=1')).status).toBe(302);

      // Answered once each, by the application's own routes
      expect(handled).toBe(3);
      expect(byHand.requests.map(r => r.pathname)).toEqual([
        '/api/auth/ok',
        '/api/auth/sign-in/social',
        '/api/auth/callback/github',
      ]);
      expect(mounted.requests).toEqual([]);

      // What the application has no route for still reaches Better Auth
      expect((await request('/api/auth/one/two/three')).status).toBe(404);
      expect(mounted.requests.map(r => r.pathname)).toEqual(['/api/auth/one/two/three']);
    });

    it('serves no routes with mountRoutes: false, leaving them to MoroJSAuth().handler', async () => {
      let byHand!: FakeInstance;
      const instance = await start({ ...baseConfig, mountRoutes: false }, () => {
        const pending = MoroJSAuth(baseConfig).then(auth => {
          byHand = fake.instances[fake.instances.length - 1] as FakeInstance;
          return auth;
        });
        const forward = async (req: HttpRequest, res: HttpResponse) =>
          (await pending).handler(req, res);
        app.get('/api/auth/:action/:provider', forward);
      });

      const res = await request('/api/auth/ok');
      expect(res.status).toBe(404);
      // Better Auth's handler was never called: the 404 is the app's own
      expect(instance.requests).toEqual([]);
      expect(((await (await request('/me')).json()) as any).isAuthenticated).toBe(false);

      // The handler mounted by hand answers the URL req.auth.signIn() returns
      const { signIn } = (await (await request('/me')).json()) as any;
      const started = await request(signIn.url);
      expect(started.status).toBe(302);
      expect(started.headers.get('location')).toBe(
        'https://provider.example/authorize?client_id=client-id&next=%2Fdashboard'
      );
      expect(byHand.requests.map(r => r.pathname)).toEqual(['/api/auth/sign-in/social']);
      expect(instance.requests).toEqual([]);
    });

    it('serves them under a custom base path', async () => {
      const instance = await start({ ...baseConfig, basePath: '/auth' });

      expect((await request('/auth/ok')).status).toBe(200);
      expect((await request('/api/auth/ok')).status).toBe(404);
      const { signIn, signOut } = (await (await request('/me')).json()) as any;
      expect(signIn.url).toBe('/auth/signin/github?provider=github&callbackUrl=%2Fdashboard');
      expect(signOut.url).toBe('/auth/signout');
      expect((await request(signIn.url)).status).toBe(302);
      expect(instance.requests.map(r => r.pathname)).toEqual(['/auth/ok', '/auth/sign-in/social']);
    });

    it('takes its place among the middleware when app.use() is not awaited', async () => {
      app = await createApp({ logger: { level: 'fatal' }, server: { engine } });
      // Not awaited: Better Auth is still loading when the guard is registered
      void app.use(createAuthMiddleware(baseConfig));
      await app.use(requireAuth());
      app.get('/private', () => ({ ok: true }));
      await listen();

      // The sign-in routes are ahead of the guard that protects everything else
      expect((await request('/api/auth/ok')).status).toBe(200);
      expect((await request('/private')).status).toBe(401);
      expect((await request('/private', { headers: { cookie: SESSION_COOKIE } })).status).toBe(200);
    });
  });

  describe('MoroJSAuth().handler mounted on routes under the base path', () => {
    it('hands Better Auth the full request path, once', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      const instance = await mountHandler(baseConfig);
      await listen();

      const ok = await request('/api/auth/ok');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });

      const session = await request('/api/auth/get-session?disableCookieCache=true', {
        headers: { cookie: SESSION_COOKIE },
      });
      expect(session.status).toBe(200);
      expect(((await session.json()) as any).user.id).toBe('u1');

      expect(instance.requests.map(r => `${r.method} ${r.pathname}${r.search}`)).toEqual([
        'GET /api/auth/ok',
        'GET /api/auth/get-session?disableCookieCache=true',
      ]);
    });

    it('relays the social sign-in start and sign-out, with body and cookies intact', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      const instance = await mountHandler(baseConfig);
      await listen();

      const signIn = await request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: '/dashboard' }),
      });
      // A script asked: Better Auth's own answer, the Location header included
      expect(signIn.status).toBe(200);
      expect(signIn.headers.get('location')).toBe(
        'https://provider.example/authorize?client_id=client-id&next=%2Fdashboard'
      );
      expect(((await signIn.json()) as any).redirect).toBe(true);
      expect(signIn.headers.getSetCookie().some(c => c.startsWith('fake.state=abc'))).toBe(true);

      const signOut = await request('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: SESSION_COOKIE, origin: ORIGIN },
        body: '{}',
      });
      expect(signOut.status).toBe(200);
      expect(await signOut.json()).toEqual({ success: true });
      expect(signOut.headers.getSetCookie().map(c => c.split('=')[0])).toEqual([
        'fake.session_token',
        'fake.session_data',
      ]);

      expect(instance.requests.map(r => `${r.method} ${r.pathname}`)).toEqual([
        'POST /api/auth/sign-in/social',
        'POST /api/auth/sign-out',
      ]);
      expect(JSON.parse((instance.requests[0] as FakeRequest).body)).toEqual({
        provider: 'github',
        callbackURL: '/dashboard',
      });
      expect((instance.requests[1] as FakeRequest).headers.cookie).toBe(SESSION_COOKIE);
    });

    it('relays the session cookie as issued, so the session it names is found again', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      await app.use(createAuthMiddleware(baseConfig));
      app.get('/me', (req: any) => ({ user: req.auth.user }));
      await mountHandler(baseConfig);
      await listen();

      const callback = await request('/api/auth/callback/github?code=abc&state=xyz');
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('/dashboard');

      // name=value exactly as Better Auth wrote it: not percent-encoded again
      const issued = callback.headers.getSetCookie().map(c => c.split('; ')[0]);
      expect(issued).toEqual(['fake.state=', SESSION_COOKIE]);
      const attributes = callback.headers.getSetCookie()[1]?.split('; ').slice(1).sort();
      expect(attributes).toEqual(['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Lax']);

      // Sent back the way a browser does, it authenticates the request
      const cookie = issued[1] as string;
      const me = await request('/me', { headers: { cookie } });
      expect(((await me.json()) as any).user).toEqual({
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        image: null,
      });
      const session = await request('/api/auth/get-session', { headers: { cookie } });
      expect(((await session.json()) as any).user.id).toBe('u1');
    });

    it('works under a custom base path', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      const instance = await mountHandler({ ...baseConfig, basePath: '/auth' });
      await listen();

      expect((await request('/auth/ok')).status).toBe(200);
      expect((await request('/auth/callback/github?code=1')).status).toBe(302);
      expect(instance.requests.map(r => `${r.pathname}${r.search}`)).toEqual([
        '/auth/ok',
        '/auth/callback/github?code=1',
      ]);
    });

    it('keeps working with a request transformer that puts the base path back itself', async () => {
      const seen: string[] = [];
      app = await createApp({ logger: { level: 'fatal' } });
      const instance = await mountHandler({
        ...baseConfig,
        morojs: {
          transformers: {
            request: (webRequest: Request) => {
              const url = new URL(webRequest.url);
              // What the transformer is given has the base path removed
              seen.push(url.pathname);
              url.pathname = `/api/auth${url.pathname}`;
              return new Request(url, webRequest);
            },
          },
        },
      });
      await listen();

      expect((await request('/api/auth/ok')).status).toBe(200);
      const signIn = await request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github' }),
      });
      expect(signIn.status).toBe(200);

      expect(seen).toEqual(['/ok', '/sign-in/social']);
      // Under the base path exactly once, not /api/auth/api/auth/...
      expect(instance.requests.map(r => r.pathname)).toEqual([
        '/api/auth/ok',
        '/api/auth/sign-in/social',
      ]);
      expect(JSON.parse((instance.requests[1] as FakeRequest).body)).toEqual({
        provider: 'github',
      });
    });

    it('restores the base path after a request transformer that leaves the path alone', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      const instance = await mountHandler({
        ...baseConfig,
        morojs: {
          transformers: {
            request: (webRequest: Request) => {
              webRequest.headers.set('x-tenant', 'acme');
              return webRequest;
            },
          },
        },
      });
      await listen();

      expect((await request('/api/auth/ok')).status).toBe(200);
      expect(instance.requests).toHaveLength(1);
      expect((instance.requests[0] as FakeRequest).pathname).toBe('/api/auth/ok');
      expect((instance.requests[0] as FakeRequest).headers['x-tenant']).toBe('acme');
    });

    it('hands on a query string the runtime delivered already parsed, beside a URL without one', async () => {
      const auth = await MoroJSAuth(baseConfig);
      const instance = fake.instances[0] as FakeInstance;
      const answer = { status: 0, location: '' };
      const res: any = {
        headersSent: false,
        status: (code: number) => ((answer.status = code), res),
        setHeader: () => undefined,
        cookie: () => undefined,
        redirect: (url: string) => ((answer.location = url), undefined),
        json: () => undefined,
        send: () => undefined,
        end: () => undefined,
      };

      // As a Lambda REST API or load balancer event arrives: the path alone
      await auth.handler(
        {
          url: '/api/auth/callback/github',
          method: 'GET',
          headers: {},
          query: { code: 'abc', state: 'x y&z' },
        },
        res
      );
      expect(instance.requests[0]).toMatchObject({
        pathname: '/api/auth/callback/github',
        search: '?code=abc&state=x+y%26z',
      });
      expect(answer).toEqual({ status: 302, location: '/dashboard' });

      // A URL that has its query string is taken as it is
      await auth.handler(
        {
          url: '/api/auth/callback/github?code=abc',
          method: 'GET',
          headers: {},
          query: { code: 'abc', added: 'by-middleware' },
        },
        res
      );
      expect((instance.requests[1] as FakeRequest).search).toBe('?code=abc');
    });

    it('does not mistake a route that merely starts with the same letters for the base path', async () => {
      app = await createApp({ logger: { level: 'fatal' } });
      const instance = await mountHandler({ ...baseConfig, basePath: '/api' });
      await listen();

      // "/api-key/..." is a Better Auth route name, not the "/api" base path
      await request('/api/api-key');
      expect((instance.requests[0] as FakeRequest).pathname).toBe('/api/api-key');
    });
  });

  describe('MoroJSAuth().auth session lookup', () => {
    it('reads the session from the cookie header', async () => {
      const auth = await MoroJSAuth(baseConfig);

      expect(await auth.auth({ url: '/anything', headers: {} })).toBeNull();
      expect(
        await auth.auth({ url: '/api/auth/get-session', headers: { cookie: SESSION_COOKIE } })
      ).toEqual({
        user: { id: 'u1', name: 'Ada', email: 'ada@example.com', image: null },
        expires: '2030-01-01T00:00:00.000Z',
      });
    });

    it('builds the cookie header from req.cookies when the header is absent', async () => {
      const auth = await MoroJSAuth(baseConfig);

      const token = SESSION_COOKIE.slice(SESSION_COOKIE.indexOf('=') + 1);
      const session = await auth.auth({
        url: '/',
        headers: {},
        cookies: { theme: 'dark', 'fake.session_token': token },
      });
      expect(session?.user.id).toBe('u1');

      const lookups = (fake.instances[0] as FakeInstance).sessionLookups;
      expect(lookups[lookups.length - 1]?.cookie).toBe(`theme=dark; ${SESSION_COOKIE}`);
    });

    it('does not call the request transformer', async () => {
      const transformer = jest.fn((webRequest: Request) => webRequest);
      const auth = await MoroJSAuth({
        ...baseConfig,
        morojs: { transformers: { request: transformer } },
      });

      await auth.auth({ url: '/', headers: { cookie: SESSION_COOKIE } });
      expect(transformer).not.toHaveBeenCalled();
    });
  });
});
