// Integration Test - Config File Loading
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp, middleware } from '../../src/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { MoroLogger, logger as globalLogger } from '../../src/core/logger/index.js';
import { createTestPort, closeApp } from '../setup.js';
import { WebSocket } from 'ws';
import { engineLoadable } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import {
  resetConfig,
  loadConfig,
  ConfigFileLoadError,
  DEFAULT_CONFIG,
} from '../../src/core/config/index.js';

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

describe('Config File Integration', () => {
  // The config file is found through the working directory. Each test runs in
  // a directory this suite owns, never in the repository root, where a file
  // written here would be loaded (or removed) by suites running beside it.
  const suiteDir = mkdtempSync(join(tmpdir(), 'moro-config-suite-'));
  const configPath = join(suiteDir, 'moro.config.js');
  const originalEnv = process.env;

  beforeEach(() => {
    process.chdir(suiteDir);
  });

  afterAll(() => {
    rmSync(suiteDir, { recursive: true, force: true });
  });

  // A project directory of its own for one test, holding the given
  // moro.config.js (or none). Each directory is a different path, so every
  // test loads the file it wrote, not one a previous test already loaded.
  const projectRoot = process.cwd();
  const tempProjects: string[] = [];
  function inProject(configSource?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'moro-config-file-'));
    tempProjects.push(dir);
    if (configSource !== undefined) {
      writeFileSync(join(dir, 'moro.config.js'), configSource);
    }
    process.chdir(dir);
    return join(process.cwd(), 'moro.config.js');
  }

  afterEach(() => {
    // Clean up test config file
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    process.chdir(projectRoot);
    for (const dir of tempProjects.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    // Restore environment
    process.env = originalEnv;
  });

  it('should work without config file (existing behavior)', async () => {
    // Clean environment first
    delete process.env.PORT;
    delete process.env.HOST;

    // Set env var
    process.env.PORT = '4000';

    resetConfig();
    const app = await createApp({ logger: { level: 'error' } });
    const config = (app as any).config;

    expect(config.server.port).toBe(4000);
  });

  it('should load and apply config file values', async () => {
    // Clean environment first
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;

    // Set environment for the test
    process.env.NODE_ENV = 'staging';

    // Create config file (no longer includes environment)
    const configContent = `
      module.exports = {
        server: {
          port: 3500,
          host: '0.0.0.0'
        },
        logging: {
          level: 'warn'
        }
      };
    `;

    writeFileSync(configPath, configContent);

    resetConfig();
    const app = await createApp({ logger: { level: 'error' } });
    const config = (app as any).config;

    // Config file values should be applied
    expect(config.server.port).toBe(3500);
    expect(config.server.host).toBe('0.0.0.0');
    // Environment is now controlled by NODE_ENV, not config
    expect(process.env.NODE_ENV).toBe('staging');
    expect(config.logging.level).toBe('error');
  });

  it('should gracefully handle invalid config files', async () => {
    // Create invalid config file
    const configContent = `
      module.exports = "invalid config";
    `;

    writeFileSync(configPath, configContent);

    // Should not throw error, just fall back to env vars
    await expect(createApp({ logger: { level: 'error' } })).resolves.toBeDefined();
  });

  it('should handle config file with syntax errors', async () => {
    // Create config file with syntax error
    const configContent = `
      module.exports = {
        server: {
          port: 3000
          // missing comma - syntax error
          host: 'localhost'
        }
      };
    `;

    writeFileSync(configPath, configContent);

    // Should not throw error, just fall back to env vars
    await expect(createApp({ logger: { level: 'error' } })).resolves.toBeDefined();
  });

  it('replaces an object that is not plain data instead of merging it key by key', async () => {
    // The file and createApp() both hand over a Buffer and a self-referring
    // object under the same keys.
    inProject(`
      const client = { name: 'from-file' };
      client.self = client;
      module.exports = {
        modules: {
          session: { enabled: false, store: 'redis', storeOptions: { client, pem: Buffer.from('file') } }
        }
      };
    `);

    const client: any = { name: 'from-options' };
    client.self = client;
    const pem = Buffer.from('options');

    resetConfig();
    const app = await createApp({
      logger: { level: 'error' },
      modules: {
        session: { enabled: false, store: 'redis', storeOptions: { client, pem } as any },
      },
    });
    const storeOptions = (app as any).config.modules.session.storeOptions;

    expect(storeOptions.pem).toBe(pem);
    expect(Buffer.isBuffer(storeOptions.pem)).toBe(true);
    expect(storeOptions.client.name).toBe('from-options');
  });
  it('keeps a RegExp WebSocket origin from the config file usable once the configuration is locked', async () => {
    // A global RegExp writes its lastIndex on every test(): it must be handed
    // on as it is, neither merged key by key nor frozen.
    inProject(`
      module.exports = {
        websocket: {
          enabled: false,
          options: { cors: { origin: ['https://app.example', /^https:\\/\\/[a-z]+\\.example$/g] } }
        }
      };
    `);

    resetConfig();
    const app = await createApp({ logger: { level: 'error' } });
    const origin = (app as any).getConfig().websocket.options.cors.origin;

    expect(origin[0]).toBe('https://app.example');
    expect(origin[1]).toBeInstanceOf(RegExp);
    expect(origin[1].test('https://admin.example')).toBe(true);
    expect(origin[1].lastIndex).toBeGreaterThan(0);
    origin[1].lastIndex = 0;
    expect(origin[1].test('http://admin.example')).toBe(false);
  });

  (engineLoadable ? it : it.skip)(
    'hands websocket.compression from the config file to the native engine as createApp() options do',
    async () => {
      const engine: any = loadNativeEngine();
      const serve = jest.spyOn(engine.module, 'serve');
      const handed = () => (serve.mock.calls[serve.mock.calls.length - 1]?.[1] as any).wsDeflate;
      const apps: any[] = [];
      const start = async (options: Record<string, any>) => {
        resetConfig();
        const app: any = await createApp({ logger: { level: 'error' }, ...options });
        apps.push(app);
        expect(app.engine.server).toBe('engine');
        return app;
      };
      try {
        // No file: what the option alone hands to the engine
        inProject();
        await start({ websocket: { enabled: true, compression: true } });
        const fromOptions = handed();
        expect(fromOptions).toEqual({ sharedCompressor: true });

        // The same setting in the file, and nothing in createApp()
        inProject(`
          module.exports = { websocket: { enabled: true, compression: true } };
        `);
        const app = await start({});
        expect(handed()).toEqual(fromOptions);
        expect(app.core.httpServer.wsCompression).toBe(true);

        // On the wire: a client that offers permessage-deflate gets it
        const port = createTestPort();
        await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
        const accepted = await new Promise<unknown>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
          ws.once('upgrade', res => {
            const header = res.headers['sec-websocket-extensions'];
            ws.once('open', () => {
              ws.terminate();
              resolve(header);
            });
          });
          ws.once('error', reject);
        });
        expect(accepted).toMatch(/^permessage-deflate\b/);

        // createApp() options are merged over the file: `false` there wins
        await start({ websocket: { compression: false } });
        expect(handed()).toBeUndefined();
      } finally {
        serve.mockRestore();
        for (const app of apps) await closeApp(app);
      }
    }
  );

  describe('createApp() shorthands with a config file', () => {
    const fileConfig = `
      module.exports = {
        security: {
          cors: { enabled: true, origin: ['https://app.example'], credentials: true, methods: ['GET'] },
          helmet: { enabled: true, xFrameOptions: 'SAMEORIGIN', referrerPolicy: 'no-referrer' }
        },
        performance: { compression: { enabled: true, level: 9, threshold: 4096 } },
        modules: {
          autoDiscovery: { enabled: false, paths: ['./app/modules'], maxDepth: 2 },
          validation: { enabled: true, stripUnknown: false }
        }
      };
    `;

    beforeEach(() => {
      delete process.env.AUTO_DISCOVERY_PATHS;
      delete process.env.AUTO_DISCOVERY_MAX_DEPTH;
      inProject(fileConfig);
      resetConfig();
    });

    it('the boolean form switches a section on and keeps what the file says', async () => {
      const app = await createApp({
        logger: { level: 'error' },
        cors: true,
        helmet: true,
        compression: true,
        autoDiscover: true,
      });
      const config = (app as any).config;

      expect(config.security.cors).toEqual({
        ...DEFAULT_CONFIG.security.cors,
        enabled: true,
        origin: ['https://app.example'],
        credentials: true,
        methods: ['GET'],
      });
      expect(config.security.helmet.xFrameOptions).toBe('SAMEORIGIN');
      expect(config.security.helmet.referrerPolicy).toBe('no-referrer');
      expect(config.performance.compression).toEqual({
        ...DEFAULT_CONFIG.performance.compression,
        enabled: true,
        level: 9,
        threshold: 4096,
      });
      expect(config.modules.autoDiscovery.enabled).toBe(true);
      expect(config.modules.autoDiscovery.paths).toEqual(['./app/modules']);
      expect(config.modules.autoDiscovery.maxDepth).toBe(2);
    });

    it('the object form overrides the keys it names and keeps the others', async () => {
      const app = await createApp({
        logger: { level: 'error' },
        cors: { origin: 'https://other.example' },
        helmet: { xFrameOptions: 'DENY' },
        compression: { level: 3 },
        autoDiscover: { maxDepth: 4 },
        validation: { abortEarly: true },
      });
      const config = (app as any).config;

      expect(config.security.cors.origin).toBe('https://other.example');
      expect(config.security.cors.enabled).toBe(true);
      expect(config.security.cors.credentials).toBe(true);
      expect(config.security.cors.methods).toEqual(['GET']);
      expect(config.security.helmet.xFrameOptions).toBe('DENY');
      expect(config.security.helmet.referrerPolicy).toBe('no-referrer');
      expect(config.security.helmet.enabled).toBe(true);
      expect(config.performance.compression.level).toBe(3);
      expect(config.performance.compression.threshold).toBe(4096);
      expect(config.performance.compression.enabled).toBe(true);
      // The file switched discovery off; an object that does not name `enabled` leaves it off
      expect(config.modules.autoDiscovery.enabled).toBe(false);
      expect(config.modules.autoDiscovery.maxDepth).toBe(4);
      expect(config.modules.autoDiscovery.paths).toEqual(['./app/modules']);
      expect(config.modules.validation.abortEarly).toBe(true);
      expect(config.modules.validation.stripUnknown).toBe(false);
      expect(config.modules.validation.enabled).toBe(true);
    });

    it('the object form reaches the middleware together with what the file says', async () => {
      const app = await createApp({
        logger: { level: 'error' },
        cors: { origin: 'https://other.example' },
      });
      app.get('/ping', () => ({ ok: true }));
      const port = createTestPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ping`, {
          headers: { Origin: 'https://other.example' },
        });
        // origin from the shorthand, credentials from the file
        expect(res.headers.get('access-control-allow-origin')).toBe('https://other.example');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      } finally {
        await closeApp(app);
      }
    });

    it('`false` switches a section off and keeps what the file says', async () => {
      const app = await createApp({ logger: { level: 'error' }, cors: false, autoDiscover: false });
      const config = (app as any).config;

      expect(config.security.cors.enabled).toBe(false);
      expect(config.security.cors.origin).toEqual(['https://app.example']);
      expect(config.modules.autoDiscovery.enabled).toBe(false);
      expect(config.modules.autoDiscovery.paths).toEqual(['./app/modules']);
    });

    it('modulesPath sets the path, switches discovery on and keeps the rest', async () => {
      const app = await createApp({
        logger: { level: 'error' },
        modulesPath: './legacy-modules',
        autoDiscover: false,
      });
      const config = (app as any).config;

      expect(config.modules.autoDiscovery.paths).toEqual(['./legacy-modules']);
      expect(config.modules.autoDiscovery.enabled).toBe(true);
      expect(config.modules.autoDiscovery.maxDepth).toBe(2);
    });
  });

  describe('a config file that cannot be loaded', () => {
    const broken = {
      'a syntax error': `module.exports = { server: { port: 3000 host: 'localhost' } };`,
      'a missing import': `const helper = require('./does-not-exist.js'); module.exports = { server: { port: 28443 } };`,
    };
    let nodeEnv: string | undefined;

    beforeEach(() => {
      nodeEnv = process.env.NODE_ENV;
      delete process.env.PORT;
      resetConfig();
    });

    afterEach(() => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    });

    for (const [what, source] of Object.entries(broken)) {
      it(`stops start-up in production (${what})`, async () => {
        const configFile = inProject(source);
        process.env.NODE_ENV = 'production';

        const failure = await createApp({ logger: { level: 'fatal' } }).then(
          () => null,
          error => error
        );

        expect(failure).toBeInstanceOf(ConfigFileLoadError);
        expect(failure.file).toBe(configFile);
        expect(failure.message).toContain(configFile);
        // The original error travels as the cause and is quoted in the message
        expect(failure.cause.message).toEqual(expect.any(String));
        expect(failure.message).toContain(failure.cause.message);
      });

      it(`starts on environment variables and defaults outside production (${what})`, async () => {
        inProject(source);
        process.env.NODE_ENV = 'development';

        const app = await createApp({ logger: { level: 'fatal' } });

        expect((app as any).config.server.port).toBe(3001);
      });
    }

    it('stops the synchronous loader in production too', () => {
      inProject(broken['a missing import']);
      process.env.NODE_ENV = 'production';

      expect(() => loadConfig()).toThrow(ConfigFileLoadError);

      process.env.NODE_ENV = 'development';
      expect(loadConfig().server.port).toBe(3001);
    });

    it('is not an error in any mode when there is no config file', async () => {
      inProject();
      process.env.NODE_ENV = 'production';
      expect(loadConfig().server.port).toBe(3001);
      await expect(createApp({ logger: { level: 'fatal' } })).resolves.toBeDefined();

      resetConfig();
      process.env.NODE_ENV = 'development';
      await expect(createApp({ logger: { level: 'fatal' } })).resolves.toBeDefined();
    });

    it('loads a valid config file in production', async () => {
      inProject(`module.exports = { server: { port: 28443 } };`);
      process.env.NODE_ENV = 'production';

      const app = await createApp({ logger: { level: 'fatal' } });

      expect((app as any).config.server.port).toBe(28443);
    });
  });

  // The file is looked for in the working directory unless MORO_CONFIG_FILE
  // names it.
  describe('where the config file is looked for', () => {
    let nodeEnv: string | undefined;
    const scriptStartedWith = process.argv[1];

    beforeEach(() => {
      nodeEnv = process.env.NODE_ENV;
      delete process.env.PORT;
      resetConfig();
    });

    afterEach(() => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      delete process.env.MORO_CONFIG_FILE;
      process.argv[1] = scriptStartedWith as string;
    });

    /** A config file of its own name, outside any project directory */
    function pinnedFile(source: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'moro-config-pinned-'));
      tempProjects.push(dir);
      const file = join(dir, 'service.config.cjs');
      writeFileSync(file, source);
      return file;
    }

    it('loads the file MORO_CONFIG_FILE names and not the one in the working directory', async () => {
      const pinned = pinnedFile(`module.exports = { server: { port: 28611 } };`);
      inProject(`module.exports = { server: { port: 28622 } };`);
      process.env.MORO_CONFIG_FILE = pinned;

      expect(loadConfig().server.port).toBe(28611);
      resetConfig();
      const app = await createApp({ logger: { level: 'fatal' } });
      expect((app as any).config.server.port).toBe(28611);

      // A relative path is taken from the working directory
      resetConfig();
      writeFileSync(
        join(process.cwd(), 'other.config.cjs'),
        `module.exports = { server: { port: 28633 } };`
      );
      process.env.MORO_CONFIG_FILE = 'other.config.cjs';
      expect(loadConfig().server.port).toBe(28633);
    });

    it('does not fall back to the working directory when the named file is missing', async () => {
      inProject(`module.exports = { server: { port: 28622 } };`);
      const missing = join(tmpdir(), 'moro-config-pinned-missing', 'service.config.cjs');
      process.env.MORO_CONFIG_FILE = missing;

      process.env.NODE_ENV = 'development';
      expect(loadConfig().server.port).toBe(3001);

      resetConfig();
      process.env.NODE_ENV = 'production';
      const failure = await createApp({ logger: { level: 'fatal' } }).then(
        () => null,
        error => error
      );
      expect(failure).toBeInstanceOf(ConfigFileLoadError);
      expect(failure.file).toBe(missing);
      expect(failure.message).toContain('MORO_CONFIG_FILE');
    });

    it('says once that a file came from a working directory the application was not started from', async () => {
      await jest.isolateModulesAsync(async () => {
        // A loader of its own: what it has said so far is per process
        const { loadConfigFileSync } = await import('../../src/core/config/file-loader.js');
        const isolated = await import('../../src/core/logger/index.js');
        isolated.logger.setLevel('info');
        const log = jest
          .spyOn(isolated.MoroLogger.prototype as any, 'log')
          .mockImplementation(() => {});
        const said = () =>
          log.mock.calls
            .filter(call => call[0] === 'info')
            .map(call => String(call[1]))
            .filter(message => message.includes('through the working directory'));
        try {
          // Started the usual way: the script is inside the working directory
          inProject(`module.exports = { server: { port: 28644 } };`);
          mkdirSync(join(process.cwd(), 'dist'));
          writeFileSync(join(process.cwd(), 'dist', 'index.js'), '');
          process.argv[1] = join(process.cwd(), 'dist', 'index.js');
          expect(loadConfigFileSync()).toEqual({ server: { port: 28644 } });
          expect(said()).toEqual([]);

          // Named on purpose: nothing to point out wherever it was started
          process.argv[1] = scriptStartedWith as string;
          process.env.MORO_CONFIG_FILE = pinnedFile(`module.exports = { server: { port: 1 } };`);
          loadConfigFileSync();
          expect(said()).toEqual([]);
          delete process.env.MORO_CONFIG_FILE;

          // Started from a directory that is not the application's
          const found = inProject(`module.exports = { server: { port: 28655 } };`);
          expect(loadConfigFileSync()).toEqual({ server: { port: 28655 } });
          loadConfigFileSync();
          expect(said()).toHaveLength(1);
          expect(said()[0]).toContain(`configuration file ${found}`);
          expect(said()[0]).toContain(process.cwd());
          expect(said()[0]).toContain(scriptStartedWith as string);
          expect(said()[0]).toContain('MORO_CONFIG_FILE');
        } finally {
          log.mockRestore();
        }
      });
    });
  });

  // Sections of the configuration that switch on a built-in middleware when
  // they are enabled: the global rate limit, CSP, session and CSRF, and the
  // keys of security.helmet.
  describe('configuration sections that install a built-in middleware', () => {
    const BACKENDS: Array<'node' | 'moro'> = engineLoadable ? ['node', 'moro'] : ['node'];
    let app: any;

    beforeEach(() => {
      inProject();
      resetConfig();
      UnifiedRouter.reset();
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      globalLogger.setLevel('error');
      if (app) await closeApp(app);
      app = undefined;
    });

    async function boot(
      options: Record<string, any>,
      register: (a: any) => void | Promise<void>
    ): Promise<string> {
      app = await createApp({ logger: { level: 'fatal' }, autoDiscover: false, ...options } as any);
      await register(app);
      const port = createTestPort();
      await new Promise<void>(resolve => app.listen(port, '127.0.0.1', () => resolve()));
      return `http://127.0.0.1:${port}`;
    }

    // warn() is an instance property (a noop below the active level), so raise
    // the level and read the shared log(level, message) sink.
    function captureWarnings(): (pattern: RegExp) => string[] {
      globalLogger.setLevel('warn');
      const spy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      return pattern =>
        spy.mock.calls
          .filter(call => call[0] === 'warn')
          .map(call => String(call[1]))
          .filter(message => pattern.test(message));
    }

    const cookiePair = (res: FetchResponse, name: string): string | undefined =>
      res.headers
        .getSetCookie()
        .map(cookie => cookie.split(';')[0] as string)
        .find(pair => pair.startsWith(`${name}=`));

    describe.each(BACKENDS)('on the %s server', backend => {
      const server = { engine: backend };

      it('security.rateLimit.global refuses a client that is past its limit', async () => {
        const base = await boot(
          {
            server,
            security: { rateLimit: { global: { enabled: true, requests: 2, window: 60000 } } },
          },
          a => a.get('/ping', () => ({ ok: true }))
        );

        const statuses: number[] = [];
        let last: FetchResponse | undefined;
        for (let i = 0; i < 3; i++) {
          last = await fetch(`${base}/ping`);
          statuses.push(last.status);
          if (i < 2) await last.arrayBuffer();
        }

        expect(statuses).toEqual([200, 200, 429]);
        expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(await last?.json()).toMatchObject({ success: false });
      });

      it('security.csp sends the configured policy', async () => {
        const base = await boot(
          {
            server,
            security: {
              csp: {
                enabled: true,
                // Laid over the default directives one by one; null leaves one out
                directives: { defaultSrc: ["'none'"], imgSrc: ["'self'", 'data:'], frameSrc: null },
                reportOnly: true,
                reportUri: '/csp-reports',
              },
            },
          },
          a => a.get('/page', () => ({ ok: true }))
        );

        const res = await fetch(`${base}/page`);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-security-policy-report-only')).toBe(
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
            "media-src 'self'; report-uri /csp-reports"
        );
        expect(res.headers.get('content-security-policy')).toBeNull();
      });

      it('modules.session keeps a session under the configured cookie name', async () => {
        const base = await boot(
          {
            server,
            modules: {
              session: { enabled: true, name: 'app.sid', secret: 'a-test-only-session-secret' },
            },
          },
          a =>
            a.get('/visits', (req: any) => {
              req.session.visits = (req.session.visits ?? 0) + 1;
              return { visits: req.session.visits };
            })
        );

        const first = await fetch(`${base}/visits`);
        expect(await first.json()).toEqual({ visits: 1 });
        const cookie = cookiePair(first, 'app.sid');
        expect(cookie).toBeDefined();

        const second = await fetch(`${base}/visits`, { headers: { cookie: cookie as string } });
        expect(await second.json()).toEqual({ visits: 2 });
      });

      it('security.csrf refuses an unsafe request without the token and takes one with it', async () => {
        const base = await boot(
          {
            server,
            security: {
              csrf: {
                enabled: true,
                secret: 'a-test-only-csrf-secret',
                cookieName: 'xsrf',
                headerName: 'x-xsrf',
              },
            },
          },
          a => {
            a.get('/form', async (req: any) => ({ token: await req.csrfToken() }));
            a.post('/submit', () => ({ saved: true }));
          }
        );
        const post = (headers: Record<string, string>) =>
          fetch(`${base}/submit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: '{}',
          });

        const refused = await post({});
        expect(refused.status).toBe(403);
        await refused.arrayBuffer();

        const form = await fetch(`${base}/form`);
        const { token } = (await form.json()) as { token: string };
        const cookie = cookiePair(form, 'xsrf');
        expect(cookie).toBeDefined();

        const accepted = await post({ cookie: cookie as string, 'x-xsrf': token });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ saved: true });
      });

      it('security.helmet sends the headers its keys describe', async () => {
        const base = await boot(
          {
            server,
            security: {
              helmet: {
                enabled: true,
                hsts: false,
                noSniff: false,
                xFrameOptions: 'SAMEORIGIN',
                referrerPolicy: 'no-referrer',
                contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
                xDownloadOptions: false,
              },
            },
          },
          a => a.get('/page', () => ({ ok: true }))
        );

        const res = await fetch(`${base}/page`);

        expect({
          hsts: res.headers.get('strict-transport-security'),
          noSniff: res.headers.get('x-content-type-options'),
          frame: res.headers.get('x-frame-options'),
          referrer: res.headers.get('referrer-policy'),
          csp: res.headers.get('content-security-policy'),
          download: res.headers.get('x-download-options'),
          // Not named in the configuration: sent as by default
          crossDomain: res.headers.get('x-permitted-cross-domain-policies'),
        }).toEqual({
          hsts: null,
          noSniff: null,
          frame: 'SAMEORIGIN',
          referrer: 'no-referrer',
          csp: "default-src 'none'",
          download: null,
          crossDomain: 'none',
        });
      });
    });

    it('adds a request hook only for a section that is enabled', async () => {
      await boot({}, a => a.get('/ping', () => ({ ok: true })));
      expect(app.hooks.hasHooks('request')).toBe(false);
      expect(app.hooks.hasHooks('response')).toBe(false);
      await closeApp(app);

      resetConfig();
      UnifiedRouter.reset();
      await boot({ security: { csp: { enabled: true } } }, a =>
        a.get('/ping', () => ({ ok: true }))
      );
      expect(app.hooks.hasHooks('request')).toBe(true);
      // CSP has nothing to do after the response
      expect(app.hooks.hasHooks('response')).toBe(false);
    });

    it('runs the rate limit ahead of the session, and leaves the CSP header to security.csp', async () => {
      const base = await boot(
        {
          security: {
            rateLimit: { global: { enabled: true, requests: 1, window: 60000 } },
            csp: { enabled: true, directives: { scriptSrc: ["'self'", 'https://cdn.example'] } },
            helmet: { enabled: true },
          },
          modules: {
            session: { enabled: true, name: 'app.sid', secret: 'a-test-only-session-secret' },
          },
        },
        a => a.get('/page', () => ({ ok: true }))
      );

      const served = await fetch(`${base}/page`);
      await served.arrayBuffer();
      const refused = await fetch(`${base}/page`);
      await refused.arrayBuffer();

      expect(served.status).toBe(200);
      expect(cookiePair(served, 'app.sid')).toBeDefined();
      // helmet runs later and would replace it with its own default policy
      expect(served.headers.get('content-security-policy')).toContain(
        "script-src 'self' https://cdn.example;"
      );
      expect(served.headers.get('x-frame-options')).toBe('DENY');

      // Refused before a session was started for it
      expect(refused.status).toBe(429);
      expect(refused.headers.getSetCookie()).toEqual([]);
    });

    it("leaves an application's own registration of the same built-in as the one that runs", async () => {
      const warnings = captureWarnings();
      const base = await boot(
        {
          logger: { level: 'warn' },
          modules: {
            session: { enabled: true, name: 'from.config', secret: 'a-test-only-session-secret' },
          },
          security: { csp: { enabled: true, directives: { defaultSrc: ["'none'"] } } },
        },
        async a => {
          await a.use(middleware.session({ name: 'from.app', secret: 'another-test-only-secret' }));
          a.get('/page', (req: any) => ({ hasSession: typeof req.session === 'object' }));
        }
      );

      const res = await fetch(`${base}/page`);

      expect(await res.json()).toEqual({ hasSession: true });
      expect(res.headers.getSetCookie().map(cookie => cookie.split('=')[0])).toEqual(['from.app']);
      // The section the application did not take over is still applied
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none';");

      const said = warnings(/modules\.session/);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("'session'");
      expect(warnings(/security\.csp/)).toEqual([]);
    });

    it('says once that the limit is counted on a proxy when server.trustProxy is not set', async () => {
      const warnings = captureWarnings();
      const base = await boot(
        {
          logger: { level: 'warn' },
          security: { rateLimit: { global: { enabled: true, requests: 100, window: 60000 } } },
        },
        a => a.get('/ping', () => ({ ok: true }))
      );
      const viaProxy = { headers: { 'x-forwarded-for': '203.0.113.9' } };

      await (await fetch(`${base}/ping`)).arrayBuffer();
      expect(warnings(/server\.trustProxy/)).toEqual([]);

      await (await fetch(`${base}/ping`, viaProxy)).arrayBuffer();
      await (await fetch(`${base}/ping`, viaProxy)).arrayBuffer();

      const said = warnings(/server\.trustProxy/);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain('security.rateLimit.global');
      expect(said[0]).toContain('100 requests per 60000 ms');
    });

    it('counts the limit per client when server.trustProxy names the proxy', async () => {
      const warnings = captureWarnings();
      const base = await boot(
        {
          logger: { level: 'warn' },
          server: { trustProxy: 'loopback' },
          security: { rateLimit: { global: { enabled: true, requests: 1, window: 60000 } } },
        },
        a => a.get('/ping', (req: any) => ({ ip: req.ip }))
      );
      const from = async (client: string) => {
        const res = await fetch(`${base}/ping`, { headers: { 'x-forwarded-for': client } });
        const body = (await res.json()) as { ip?: string };
        return { status: res.status, ip: body.ip };
      };

      expect(await from('203.0.113.1')).toEqual({ status: 200, ip: '203.0.113.1' });
      expect((await from('203.0.113.1')).status).toBe(429);
      // Another client behind the same proxy has a limit of its own
      expect(await from('203.0.113.2')).toEqual({ status: 200, ip: '203.0.113.2' });
      expect(warnings(/server\.trustProxy/)).toEqual([]);
    });

    it('a config file that names a CORS origin switches CORS on', async () => {
      inProject(`
        module.exports = {
          security: { cors: { origin: ['https://app.example'], credentials: true } }
        };
      `);
      resetConfig();
      const base = await boot({}, a => a.get('/ping', () => ({ ok: true })));

      expect(app.getConfig().security.cors.enabled).toBe(true);
      const res = await fetch(`${base}/ping`, { headers: { Origin: 'https://app.example' } });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    // A config file is code: its CORS origin can be a function, and that
    // function is the one asked about every request.
    describe.each(BACKENDS)(
      'a CORS origin function in the config file, on the %s server',
      backend => {
        afterEach(() => {
          delete (globalThis as any).__moroCorsOriginCalls;
        });

        it('is called with the Origin and the request, and its answer is the one given', async () => {
          inProject(`
          const allowed = new Set(['https://app.example']);
          module.exports = {
            security: {
              cors: {
                origin: (requestOrigin, req) => {
                  (globalThis.__moroCorsOriginCalls ||= []).push([requestOrigin, req.url]);
                  if (req.url === '/health') return requestOrigin || '*';
                  return allowed.has(requestOrigin) ? requestOrigin : false;
                },
                credentials: true,
              },
            },
          };
        `);
          resetConfig();
          const base = await boot({ server: { engine: backend } }, a => {
            a.get('/ping', () => ({ ok: true }));
            a.get('/health', () => ({ ok: true }));
          });

          // The function itself is what the configuration holds, and it switched CORS on
          expect(typeof app.getConfig().security.cors.origin).toBe('function');
          expect(app.getConfig().security.cors.enabled).toBe(true);

          const allowed = await fetch(`${base}/ping`, {
            headers: { Origin: 'https://app.example' },
          });
          expect(allowed.status).toBe(200);
          expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
          expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

          const refused = await fetch(`${base}/ping`, {
            headers: { Origin: 'https://other.example' },
          });
          expect(refused.status).toBe(403);
          expect(refused.headers.get('access-control-allow-origin')).toBeNull();

          // Decided per request: the same origin is let in where the function says so
          const open = await fetch(`${base}/health`, {
            headers: { Origin: 'https://other.example' },
          });
          expect(open.status).toBe(200);
          expect(open.headers.get('access-control-allow-origin')).toBe('https://other.example');

          expect((globalThis as any).__moroCorsOriginCalls).toEqual([
            ['https://app.example', '/ping'],
            ['https://other.example', '/ping'],
            ['https://other.example', '/health'],
          ]);
        });
      }
    );
  });
});
