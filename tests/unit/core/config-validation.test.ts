// Configuration System Validation Tests
// Tests the current implementation to identify what works vs what needs fixing

import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from '../../../src/index.js';
import { inspect } from 'util';
import {
  initializeConfig,
  loadConfig,
  loadConfigWithOptions,
  resetConfig,
  validateConfig,
  ConfigValidationError,
  DEFAULT_CONFIG,
} from '../../../src/core/config/index.js';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';
import { MoroOptions } from '../../../src/types/core.js';
import { performance } from 'perf_hooks';

describe('Configuration System Validation', () => {
  // The config file is found through the working directory. Each test runs in
  // a directory this suite owns, never in the repository root, where a file
  // written here would be loaded (or removed) by suites running beside it.
  const projectRoot = process.cwd();
  const suiteDir = mkdtempSync(join(tmpdir(), 'moro-config-validation-'));
  const configPath = join(suiteDir, 'moro.config.js');
  const originalEnv = process.env;

  afterAll(() => {
    process.chdir(projectRoot);
    rmSync(suiteDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.chdir(suiteDir);
    process.env = { ...originalEnv };
    resetConfig();

    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  });

  afterEach(() => {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    process.env = originalEnv;
  });

  describe('Current Working Features', () => {
    it('should load basic configuration with defaults', () => {
      const config = loadConfig();

      expect(config.server.port).toBe(3001);
      expect(config.server.host).toBe('localhost');
      expect(config.database.redis).toBeUndefined(); // Redis only included when configured
      expect(config.logging.level).toBe('info');
    });

    it('should handle standard environment variables', () => {
      process.env.PORT = '8080';
      process.env.HOST = '0.0.0.0';
      process.env.NODE_ENV = 'production';

      const config = loadConfig();

      expect(config.server.port).toBe(8080);
      expect(config.server.host).toBe('0.0.0.0');
      // NODE_ENV is now handled separately, not part of server config
      expect(process.env.NODE_ENV).toBe('production');
    });

    it('should load MySQL config when MYSQL_HOST is set', () => {
      process.env.MYSQL_HOST = 'mysql.example.com';
      process.env.MYSQL_PORT = '3307';

      const config = loadConfig();

      expect(config.database.mysql).toBeDefined();
      expect(config.database.mysql?.host).toBe('mysql.example.com');
      expect(config.database.mysql?.port).toBe(3307);
    });

    it('should exclude MySQL config when MYSQL_HOST is not set', () => {
      const config = loadConfig();
      expect(config.database.mysql).toBeUndefined();
    });

    it('should load Redis config when REDIS_URL is set', () => {
      process.env.REDIS_URL = 'redis://test:6379';

      const config = loadConfig();

      expect(config.database.redis).toBeDefined();
      expect(config.database.redis?.url).toBe('redis://test:6379');
      expect(config.database.redis?.maxRetries).toBe(3);
      expect(config.database.redis?.retryDelay).toBe(1000);
      expect(config.database.redis?.keyPrefix).toBe('moro:');
    });

    it('should merge createApp options correctly', () => {
      const options: MoroOptions = {
        cors: false,
        server: { port: 7000 },
        logger: { level: 'error' },
      };

      const config = loadConfigWithOptions(options);

      expect(config.security.cors.enabled).toBe(false);
      expect(config.server.port).toBe(7000);
    });
  });

  describe('HTTP Engine Selection', () => {
    it('should leave engine unset in config (resolution defaults to moro)', () => {
      // engine is intentionally not stored with a default, so the framework can
      // distinguish an explicit choice from the 'moro' resolution default
      const config = loadConfig();
      expect(config.server.engine).toBeUndefined();
      // No default for the removed uWebSockets.js switch either.
      expect(config.server.useUWebSockets).toBeUndefined();
    });

    it('should accept engine via createApp options', () => {
      // 'uws' (uWebSockets.js, removed in 1.8.24) still validates: an existing
      // configuration must keep booting. The framework runs it on 'moro'.
      for (const engine of ['moro', 'node', 'uws'] as const) {
        resetConfig();
        const config = loadConfigWithOptions({ server: { engine } });
        expect(config.server.engine).toBe(engine);
      }
    });

    it('should accept engine via MORO_SERVER_ENGINE', () => {
      process.env.MORO_SERVER_ENGINE = 'node';
      expect(loadConfig().server.engine).toBe('node');
      // The removed engine's name is passed through, not dropped, so the
      // framework can say what it did with it.
      resetConfig();
      process.env.MORO_SERVER_ENGINE = 'uws';
      expect(loadConfig().server.engine).toBe('uws');
    });

    it("should map legacy 'auto'/'native' to 'moro'", () => {
      for (const legacy of ['auto', 'native'] as const) {
        resetConfig();
        const config = loadConfigWithOptions({ server: { engine: legacy as any } });
        expect(config.server.engine).toBe('moro');
      }
    });

    it('should reject invalid engine values', () => {
      expect(() => loadConfigWithOptions({ server: { engine: 'turbo' as any } })).toThrow();
    });

    it('should ignore invalid MORO_SERVER_ENGINE values (engine selection never fails the boot)', () => {
      process.env.MORO_SERVER_ENGINE = 'not-an-engine';
      const config = loadConfig();
      // Invalid env value is discarded: engine stays unset and resolution
      // applies the 'moro' default at boot
      expect(config.server.engine).toBeUndefined();
    });

    it('should normalize MORO_SERVER_ENGINE (trim, lowercase, legacy aliases)', () => {
      process.env.MORO_SERVER_ENGINE = ' UWS ';
      expect(loadConfig().server.engine).toBe('uws');
      resetConfig();
      process.env.MORO_SERVER_ENGINE = 'native';
      expect(loadConfig().server.engine).toBe('moro');
    });

    it('should keep accepting the removed useUWebSockets flag', () => {
      const config = loadConfigWithOptions({ server: { useUWebSockets: true } });
      expect(config.server.useUWebSockets).toBe(true);
      // engine stays unset; the framework boots such an app on 'moro' with a warning
      expect(config.server.engine).toBeUndefined();
    });
  });

  describe('Issues Identified', () => {
    it('FIXED: MORO_ prefixed environment variables working correctly', () => {
      process.env.MORO_PORT = '9000';
      process.env.MORO_HOST = '127.0.0.1';
      process.env.LOG_LEVEL = 'error';

      const config = loadConfig();

      // These work correctly now
      expect(config.server.port).toBe(9000);
      expect(config.server.host).toBe('127.0.0.1');
    });

    it('FIXED: External services only included when configured', () => {
      const config = loadConfig();

      // These should be undefined when not configured
      expect(config.external.stripe).toBeUndefined();
      expect(config.external.paypal).toBeUndefined();
      expect(config.external.smtp).toBeUndefined();
    });

    it('TESTING: Config precedence with createApp options', async () => {
      const configContent = `
        module.exports = {
          server: { port: 4000 }
        };
      `;
      writeFileSync(configPath, configContent);

      process.env.PORT = '5000'; // Beats the config file, loses to createApp options

      const app = await createApp({
        server: { port: 6000 }, // Applied last, so this is the port
        logger: { level: 'error' },
      });
      const config = (app as any).config;

      console.log(
        '🔍 Config precedence test - port is:',
        config.server.port,
        '(env=5000, options=6000, file=4000)'
      );

      // Test what actually happens
      expect(typeof config.server.port).toBe('number');
    });

    it('TESTING: Optional URL validation behavior', () => {
      process.env.DATABASE_URL = 'not-a-url';

      // Test what actually happens with invalid URLs
      const result = (() => {
        try {
          const config = loadConfig();
          return { success: true, config };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      })();

      console.log('🔍 URL validation test:', result.success ? 'Accepted' : 'Rejected');
      if (result.success && result.config) {
        console.log('   Database URL:', result.config.database.url);
      } else {
        console.log('   Error:', result.error);
      }
    });
  });

  describe('Partial database sections', () => {
    it('fills the keys left out of database.redis', () => {
      const config = loadConfigWithOptions({
        database: { redis: { url: 'redis://cache.internal:6379' } },
      });
      expect(config.database.redis).toEqual({
        url: 'redis://cache.internal:6379',
        maxRetries: 3,
        retryDelay: 1000,
        keyPrefix: 'moro:',
      });
    });

    it('fills the keys left out of database.mysql', () => {
      const config = loadConfigWithOptions({
        database: { mysql: { host: 'db.internal', database: 'app' } },
      });
      expect(config.database.mysql).toEqual({
        host: 'db.internal',
        port: 3306,
        database: 'app',
        connectionLimit: 10,
        acquireTimeout: 60000,
        timeout: 60000,
      });
    });

    it('fills the keys left out of database.postgresql', () => {
      const config = loadConfigWithOptions({
        database: { postgresql: { database: 'app', ssl: true } },
      });
      expect(config.database.postgresql).toEqual({
        host: 'localhost',
        port: 5432,
        database: 'app',
        connectionLimit: 10,
        ssl: true,
      });
    });

    it('starts an app created with a partial section', async () => {
      const app = await createApp({
        logger: { level: 'error' },
        database: { redis: { keyPrefix: 'myapp:' } },
      });
      expect(app.getConfig().database.redis).toEqual({
        url: 'redis://localhost:6379',
        maxRetries: 3,
        retryDelay: 1000,
        keyPrefix: 'myapp:',
      });
    });

    it('keeps every key that was written', () => {
      const redis = { url: 'redis://a:1', maxRetries: 0, retryDelay: 0, keyPrefix: '' };
      const mysql = {
        host: 'h',
        port: 3307,
        connectionLimit: 1,
        acquireTimeout: 1000,
        timeout: 2000,
      };
      const config = loadConfigWithOptions({ database: { redis, mysql } });
      expect(config.database.redis).toEqual(redis);
      expect(config.database.mysql).toEqual(mysql);
    });

    it('still rejects a key that is present and invalid', () => {
      expect(() =>
        loadConfigWithOptions({
          database: { redis: { url: 'redis://a:1', maxRetries: 'many' } },
        } as unknown as MoroOptions)
      ).toThrow("Configuration validation failed for 'database.redis.maxRetries'");
      expect(() =>
        loadConfigWithOptions({ database: { mysql: { port: 70000 } } } as MoroOptions)
      ).toThrow("Configuration validation failed for 'database.mysql.port'");
      expect(() =>
        loadConfigWithOptions({ database: { postgresql: { host: 5 } } } as unknown as MoroOptions)
      ).toThrow("Configuration validation failed for 'database.postgresql.host'");
    });
  });

  describe('NO_COLOR', () => {
    const liveColors = () => (globalLogger as any).options.enableColors;
    let colorsBefore: boolean;

    beforeEach(() => {
      colorsBefore = liveColors();
      delete process.env.NO_COLOR;
      delete process.env.LOG_COLORS;
      delete process.env.MORO_LOG_COLORS;
    });

    afterEach(() => {
      (globalLogger as any).options.enableColors = colorsBefore;
    });

    it('turns colours off by default when NO_COLOR is present and not empty', () => {
      process.env.NO_COLOR = '1';
      expect(loadConfig().logging.enableColors).toBe(false);
    });

    it('keeps colours off on the live logger after createApp()', async () => {
      process.env.NO_COLOR = '1';
      const app = await createApp({ logger: { level: 'error' } });

      expect((app as any).config.logging.enableColors).toBe(false);
      expect(liveColors()).toBe(false);
    });

    it('is ignored when empty or unset', () => {
      process.env.NO_COLOR = '';
      expect(loadConfig().logging.enableColors).toBe(true);

      delete process.env.NO_COLOR;
      expect(loadConfig().logging.enableColors).toBe(true);
    });

    it('keeps logging.redact and logging.escapeControlChars, and rejects other shapes', () => {
      const config = loadConfigWithOptions({
        logging: { redact: ['sessionKey'], escapeControlChars: false },
      } as MoroOptions);
      expect((config.logging as any).redact).toEqual(['sessionKey']);
      expect((config.logging as any).escapeControlChars).toBe(false);

      expect((loadConfigWithOptions({}).logging as any).redact).toBeUndefined();
      expect(() => loadConfigWithOptions({ logging: { redact: 'all' } } as any)).toThrow(
        /logging\.redact/
      );
    });

    it('loses to colours switched on explicitly in createApp options', async () => {
      process.env.NO_COLOR = '1';
      expect(loadConfigWithOptions({ logger: { enableColors: true } }).logging.enableColors).toBe(
        true
      );
      expect(
        loadConfigWithOptions({ logging: { enableColors: true } } as MoroOptions).logging
          .enableColors
      ).toBe(true);

      const app = await createApp({ logger: { level: 'error', enableColors: true } });
      expect((app as any).config.logging.enableColors).toBe(true);
      expect(liveColors()).toBe(true);
    });

    it('loses to LOG_COLORS=true', () => {
      process.env.NO_COLOR = '1';
      process.env.LOG_COLORS = 'true';
      expect(loadConfig().logging.enableColors).toBe(true);
    });
  });

  describe('Validation failure logging', () => {
    // error() is an instance property (a noop when the level disables it), so
    // the calls are read from the shared log(level, message, context) sink.
    function captureErrors() {
      globalLogger.setLevel('error');
      const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      return () =>
        logSpy.mock.calls
          .filter(c => c[0] === 'error')
          .map(c => ({ message: String(c[1]), context: c[2] }));
    }

    afterEach(() => {
      jest.restoreAllMocks();
      globalLogger.setLevel('fatal');
    });

    it('logs the field and the reason as the message, with no context argument', () => {
      const errors = captureErrors();
      const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      config.server.port = 99999;

      expect(() => validateConfig(config)).toThrow(
        "Configuration validation failed for 'server.port': Must be a number between 1 and 65535"
      );

      const failure = errors().find(e => e.message.includes('validation failed'));
      expect(failure).toBeDefined();
      expect(failure!.message).toContain(
        "Configuration validation failed for 'server.port': Must be a number between 1 and 65535"
      );
      // The reason must not travel as the logger context (it would be printed
      // inside the [brackets] in front of a message that ends at the colon).
      expect(failure!.context).toBeUndefined();
    });

    it('logs an unexpected validation error as one message', () => {
      const errors = captureErrors();

      const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      Object.defineProperty(config, 'server', {
        get() {
          throw new Error('boom');
        },
      });

      expect(() => validateConfig(config)).toThrow('Configuration validation failed: Error: boom');

      const failure = errors().find(e => e.message.includes('Unexpected configuration'));
      expect(failure).toBeDefined();
      expect(failure!.message).toContain('Unexpected configuration validation error: Error: boom');
      expect(failure!.context).toBeUndefined();
    });
  });

  describe('Settings carried into the validated configuration', () => {
    it('keeps server.gracefulShutdown and server.handleUncaught, and leaves them unset otherwise', () => {
      const config = loadConfigWithOptions({
        server: { gracefulShutdown: false, handleUncaught: true },
      });

      expect(config.server.gracefulShutdown).toBe(false);
      expect(config.server.handleUncaught).toBe(true);

      const defaults = loadConfig();
      expect('gracefulShutdown' in defaults.server).toBe(false);
      expect('handleUncaught' in defaults.server).toBe(false);
    });

    it('resolves server.timeouts.request to five minutes and leaves server.timeouts.idle to the server', () => {
      const defaults = loadConfigWithOptions({});
      expect(defaults.server.timeouts).toEqual({
        keepAlive: 5000,
        headers: 6000,
        request: 300000,
      });

      // 0 disables a timeout, so it has to survive as written
      const disabled = loadConfigWithOptions({ server: { timeouts: { idle: 0, request: 0 } } });
      expect(disabled.server.timeouts).toEqual({
        keepAlive: 5000,
        headers: 6000,
        idle: 0,
        request: 0,
      });

      const idleOnly = loadConfigWithOptions({ server: { timeouts: { idle: 20000 } } });
      expect(idleOnly.server.timeouts?.idle).toBe(20000);
      expect(idleOnly.server.timeouts?.request).toBe(300000);
    });

    it('keeps server.limits.responseBackpressureLimit as a size, unset by default, and rejects anything else', () => {
      expect(
        loadConfigWithOptions({ server: { limits: { responseBackpressureLimit: '8mb' } } }).server
          .limits?.responseBackpressureLimit
      ).toBe('8mb');
      expect(
        loadConfigWithOptions({ server: { limits: { responseBackpressureLimit: 0 } } }).server
          .limits?.responseBackpressureLimit
      ).toBe(0);
      expect('responseBackpressureLimit' in (loadConfigWithOptions({}).server.limits ?? {})).toBe(
        false
      );

      for (const value of ['plenty', -1, true]) {
        expect(() =>
          loadConfigWithOptions({
            server: { limits: { responseBackpressureLimit: value as any } },
          })
        ).toThrow(/server\.limits\.responseBackpressureLimit/);
      }
    });

    it('defaults server.limits.form.maxFields to 1000, takes a number of at least 1 and rejects anything else', () => {
      expect(loadConfigWithOptions({}).server.limits?.form).toEqual({ maxFields: 1000 });
      expect(DEFAULT_CONFIG.server.limits?.form?.maxFields).toBe(1000);

      const set = loadConfigWithOptions({ server: { limits: { form: { maxFields: 50 } } } });
      expect(set.server.limits?.form?.maxFields).toBe(50);
      // ...and the limits beside it keep their defaults
      expect(set.server.limits?.multipart?.maxParts).toBe(1000);

      // Another limit set alone leaves the default in place
      const other = loadConfigWithOptions({ server: { limits: { maxHeaders: 50 } } });
      expect(other.server.limits?.form?.maxFields).toBe(1000);

      for (const value of [0, -1, 'many']) {
        expect(() =>
          loadConfigWithOptions({ server: { limits: { form: { maxFields: value as any } } } })
        ).toThrow(/server\.limits\.form\.maxFields/);
      }
      for (const value of [5000, 'many', null]) {
        expect(() => loadConfigWithOptions({ server: { limits: { form: value as any } } })).toThrow(
          /server\.limits\.form/
        );
      }
    });

    it('reads MORO_FORM_MAX_FIELDS, and options given in code override it', () => {
      process.env.MORO_FORM_MAX_FIELDS = '250';
      expect(loadConfig().server.limits?.form?.maxFields).toBe(250);
      expect(
        loadConfigWithOptions({ server: { limits: { form: { maxFields: 20 } } } }).server.limits
          ?.form?.maxFields
      ).toBe(20);

      process.env.MORO_FORM_MAX_FIELDS = 'lots';
      expect(() => loadConfig()).toThrow(/server\.limits\.form\.maxFields/);
    });

    it('keeps server.limits.memoryBudget as a size or false, unset by default, and rejects anything else', () => {
      const budget = (value: any) =>
        loadConfigWithOptions({ server: { limits: { memoryBudget: value } } }).server.limits
          ?.memoryBudget;
      expect(budget('2gb')).toBe('2gb');
      expect(budget(512 * 1024 * 1024)).toBe(512 * 1024 * 1024);
      // false is "no budget", and has to survive as written
      expect(budget(false)).toBe(false);
      expect('memoryBudget' in (loadConfigWithOptions({}).server.limits ?? {})).toBe(false);

      for (const value of ['plenty', -1, true, null, {}]) {
        expect(() => budget(value)).toThrow(/server\.limits\.memoryBudget/);
      }
    });

    it('rejects a non-boolean server.gracefulShutdown', () => {
      expect(() => loadConfigWithOptions({ server: { gracefulShutdown: 'never' as any } })).toThrow(
        /server\.gracefulShutdown/
      );
    });

    it('accepts a non-negative, finite number of bytes for server.bodySizeLimit and server.maxUploadSize', () => {
      const config = loadConfigWithOptions({
        server: { bodySizeLimit: 1048576, maxUploadSize: 0 },
      });

      expect(config.server.bodySizeLimit).toBe(1048576);
      expect(config.server.maxUploadSize).toBe(0);

      for (const bad of [-1, NaN, Infinity]) {
        expect(() => loadConfigWithOptions({ server: { bodySizeLimit: bad } })).toThrow(
          /server\.bodySizeLimit/
        );
      }
      expect(() => loadConfigWithOptions({ server: { maxUploadSize: true as any } })).toThrow(
        "Configuration validation failed for 'server.maxUploadSize': Must be a string"
      );
    });

    it('keeps server.trustProxy in each accepted form, and leaves it unset otherwise', () => {
      const accepted: unknown[] = [
        true,
        false,
        0,
        2,
        'loopback',
        '10.0.0.0/8, 192.168.1.7',
        ['uniquelocal', 'fd00::/8', '::1', '203.0.113.4/32'],
      ];
      for (const trustProxy of accepted) {
        const config = loadConfigWithOptions({ server: { trustProxy } } as any);
        expect(config.server.trustProxy).toEqual(trustProxy);
      }

      // Not set is its own state, distinct from `false`
      expect('trustProxy' in loadConfig().server).toBe(false);
    });

    it('rejects a server.trustProxy that names no hop count, address or range', () => {
      const rejected: unknown[] = [
        -1,
        1.5,
        'yes',
        '10.0.0.0/33',
        'fe80::/129',
        ['10.0.0.1', 'proxy.internal'],
        [],
        { hops: 1 },
      ];
      for (const trustProxy of rejected) {
        expect(() => loadConfigWithOptions({ server: { trustProxy } } as any)).toThrow(
          /server\.trustProxy/
        );
      }
    });

    it('takes a RegExp as a WebSocket origin, alone or in a list, and hands it on as the same object', () => {
      const pattern = /^https:\/\/[a-z]+\.example$/;
      const withOrigin = (origin: unknown) =>
        validateConfig({
          ...loadConfig(),
          websocket: { enabled: false, options: { cors: { origin } } },
        } as any).websocket.options?.cors?.origin;

      expect(withOrigin(pattern)).toBe(pattern);

      const list = withOrigin(['https://app.example', pattern]) as unknown[];
      expect(list).toHaveLength(2);
      expect(list[0]).toBe('https://app.example');
      expect(list[1]).toBe(pattern);

      // Anything else in a list is still named by its position
      expect(() => withOrigin(['https://app.example', 42])).toThrow(
        /websocket\.options\.cors\.origin\[1\]/
      );
      expect(() => withOrigin({ host: 'app.example' })).toThrow(/websocket\.options\.cors\.origin/);

      // The HTTP CORS middleware has no RegExp form, so security.cors.origin keeps refusing one
      expect(() =>
        validateConfig({
          ...loadConfig(),
          security: {
            ...loadConfig().security,
            cors: { ...loadConfig().security.cors, origin: pattern },
          },
        } as any)
      ).toThrow(/security\.cors\.origin/);
    });

    it('hands jobs.leaderElection.redisClient on as the same object', () => {
      const redisClient = new (class FakeRedis {
        set = async () => 'OK';
      })();

      const config = loadConfigWithOptions({
        jobs: { leaderElection: { strategy: 'redis', redisClient } },
      });

      expect(config.jobs?.leaderElection?.redisClient).toBe(redisClient);
    });
  });

  describe('createApp() shorthands', () => {
    const defaults = DEFAULT_CONFIG;

    it('set only `enabled` in the boolean form and leave environment values alone', () => {
      process.env.AUTO_DISCOVERY_PATHS = './app/modules';
      process.env.AUTO_DISCOVERY_MAX_DEPTH = '2';
      process.env.VALIDATION_ENABLED = 'true';

      const config = loadConfigWithOptions({
        autoDiscover: true,
        validation: { abortEarly: true },
      });

      expect(config.modules.autoDiscovery).toEqual({
        ...defaults.modules.autoDiscovery,
        enabled: true,
        paths: ['./app/modules'],
        maxDepth: 2,
      });
      expect(config.modules.validation).toEqual({
        ...defaults.modules.validation,
        enabled: true,
        abortEarly: true,
      });
    });

    it('switch a section off with `false` and keep its other values', () => {
      process.env.AUTO_DISCOVERY_PATHS = './app/modules';

      const config = loadConfigWithOptions({
        autoDiscover: false,
        cors: false,
        helmet: false,
        compression: false,
      });

      expect(config.modules.autoDiscovery.enabled).toBe(false);
      expect(config.modules.autoDiscovery.paths).toEqual(['./app/modules']);
      expect(config.security.cors).toEqual({ ...defaults.security.cors, enabled: false });
      expect(config.security.helmet).toEqual({ ...defaults.security.helmet, enabled: false });
      expect(config.performance.compression).toEqual({
        ...defaults.performance.compression,
        enabled: false,
      });
    });

    it('give the schema defaults plus what they name when nothing else is set', () => {
      const booleans = loadConfigWithOptions({
        cors: true,
        helmet: true,
        compression: true,
        autoDiscover: true,
      });
      expect(booleans.security.cors).toEqual({ ...defaults.security.cors, enabled: true });
      expect(booleans.security.helmet).toEqual({ ...defaults.security.helmet, enabled: true });
      expect(booleans.performance.compression).toEqual({
        ...defaults.performance.compression,
        enabled: true,
      });
      expect(booleans.modules.autoDiscovery).toEqual({
        ...defaults.modules.autoDiscovery,
        enabled: true,
      });

      const objects = loadConfigWithOptions({
        cors: { origin: 'https://app.example' },
        helmet: { xFrameOptions: 'SAMEORIGIN' },
        compression: { level: 9 },
        autoDiscover: { paths: ['./mods'] },
        validation: { stripUnknown: false },
      });
      // An object names its keys and nothing else: `enabled` stays at its
      // default. CORS is the one exception: an origin that was written down
      // switches it on (see 'a configured CORS origin').
      expect(objects.security.cors).toEqual({
        ...defaults.security.cors,
        enabled: true,
        origin: 'https://app.example',
      });
      expect(objects.security.helmet).toEqual({
        ...defaults.security.helmet,
        xFrameOptions: 'SAMEORIGIN',
      });
      expect(objects.performance.compression).toEqual({
        ...defaults.performance.compression,
        level: 9,
      });
      expect(objects.modules.autoDiscovery).toEqual({
        ...defaults.modules.autoDiscovery,
        paths: ['./mods'],
      });
      expect(objects.modules.validation).toEqual({
        ...defaults.modules.validation,
        stripUnknown: false,
      });

      const legacy = loadConfigWithOptions({ modulesPath: './legacy-modules' });
      expect(legacy.modules.autoDiscovery).toEqual({
        ...defaults.modules.autoDiscovery,
        enabled: true,
        paths: ['./legacy-modules'],
      });
    });

    it('apply over the long form given in the same call, key by key', () => {
      const config = loadConfigWithOptions({
        security: {
          cors: { enabled: false, origin: 'https://app.example', credentials: true },
          helmet: { referrerPolicy: 'no-referrer' },
        },
        performance: { compression: { threshold: 4096 } },
        modules: { autoDiscovery: { maxDepth: 2 } },
        cors: true,
        helmet: { xFrameOptions: 'SAMEORIGIN' },
        compression: { level: 9 },
        modulesPath: './mods',
      });

      expect(config.security.cors.enabled).toBe(true);
      expect(config.security.cors.origin).toBe('https://app.example');
      expect(config.security.cors.credentials).toBe(true);
      expect(config.security.helmet.referrerPolicy).toBe('no-referrer');
      expect(config.security.helmet.xFrameOptions).toBe('SAMEORIGIN');
      expect(config.performance.compression.threshold).toBe(4096);
      expect(config.performance.compression.level).toBe(9);
      expect(config.modules.autoDiscovery.maxDepth).toBe(2);
      expect(config.modules.autoDiscovery.paths).toEqual(['./mods']);
    });
  });

  describe('a configured CORS origin', () => {
    it('switches CORS on, in the shorthand and in security.cors', () => {
      const origins = ['https://app.example', 'https://admin.example'];

      const shorthand = loadConfigWithOptions({ cors: { origin: origins, credentials: true } });
      expect(shorthand.security.cors).toEqual({
        ...DEFAULT_CONFIG.security.cors,
        enabled: true,
        origin: origins,
        credentials: true,
      });

      const longForm = loadConfigWithOptions({
        security: { cors: { origin: 'https://a.example' } },
      });
      expect(longForm.security.cors.enabled).toBe(true);
      expect(longForm.security.cors.origin).toBe('https://a.example');

      const allowAll = () => true;
      const byFunction = loadConfigWithOptions({ cors: { origin: allowAll } } as any);
      expect(byFunction.security.cors.enabled).toBe(true);
      expect(byFunction.security.cors.origin).toBe(allowAll);
    });

    it('stays off when `enabled: false` is given, wherever it is given', () => {
      // The contrast: the same origin with nothing said about `enabled`
      expect(
        loadConfigWithOptions({ cors: { origin: 'https://app.example' } }).security.cors.enabled
      ).toBe(true);

      const sameObject = loadConfigWithOptions({
        cors: { enabled: false, origin: 'https://app.example' },
      } as any);
      expect(sameObject.security.cors.enabled).toBe(false);
      expect(sameObject.security.cors.origin).toBe('https://app.example');

      const longFormOff = loadConfigWithOptions({
        security: { cors: { enabled: false } },
        cors: { origin: 'https://app.example' },
      });
      expect(longFormOff.security.cors.enabled).toBe(false);

      const shorthandOff = loadConfigWithOptions({
        security: { cors: { origin: 'https://app.example' } },
        cors: false,
      });
      expect(shorthandOff.security.cors.enabled).toBe(false);
      expect(shorthandOff.security.cors.origin).toBe('https://app.example');
    });

    it('stays off without an origin, and for `origin: false`', () => {
      // Other CORS keys alone do not ask for CORS
      const noOrigin = loadConfigWithOptions({ cors: { credentials: true } });
      expect(noOrigin.security.cors.enabled).toBe(false);

      const originOff = loadConfigWithOptions({ cors: { origin: false } });
      expect(originOff.security.cors.enabled).toBe(false);

      // ...and with an origin they do, so the pair above is a real contrast
      const withOrigin = loadConfigWithOptions({ cors: { origin: '*', credentials: true } });
      expect(withOrigin.security.cors.enabled).toBe(true);
    });
  });

  describe('Objects handed over inside the configuration', () => {
    it('accepts an options object that refers to itself', () => {
      const client: any = { name: 'redis' };
      client.self = client;

      const config = loadConfigWithOptions({
        modules: { session: { enabled: false, store: 'redis', storeOptions: { client } as any } },
      });

      expect((config.modules.session?.storeOptions as any).client).toBe(client);
    });

    it('locks a configuration that holds a self-referring object', () => {
      const client: any = { name: 'redis' };
      client.self = client;

      expect(() =>
        initializeConfig({
          logger: { level: 'error' },
          modules: { session: { enabled: false, store: 'redis', storeOptions: { client } as any } },
        })
      ).not.toThrow();
    });

    it('does not freeze a client object or a Buffer when the configuration is locked', () => {
      class Client {
        calls = 0;
        self = this;
        ping() {
          return ++this.calls;
        }
      }
      const redisClient = new Client();
      const key = Buffer.from('key');

      const config = initializeConfig({
        logger: { level: 'error' },
        server: { ssl: { key, cert: Buffer.from('cert') } },
        jobs: { leaderElection: { strategy: 'redis', redisClient } },
      });

      expect(Object.isFrozen(config.server)).toBe(true);
      expect(config.server.ssl?.key).toBe(key);
      expect(config.jobs?.leaderElection?.redisClient).toBe(redisClient);
      expect(redisClient.ping()).toBe(1);
    });
  });

  describe('ConfigValidationError', () => {
    function rejection(options: MoroOptions): ConfigValidationError {
      try {
        loadConfigWithOptions(options);
      } catch (error) {
        return error as ConfigValidationError;
      }
      throw new Error('expected the configuration to be rejected');
    }

    it('does not print a rejected TLS key or passphrase, and still hands it to code that reads error.value', () => {
      const ssl = { key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg', passphrase: 'hunter2' };
      const error = rejection({ server: { ssl } });

      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(inspect(error)).not.toContain('MIIEvQIBADANBg');
      expect(inspect(error)).not.toContain('hunter2');
      expect(JSON.stringify(error)).not.toContain('hunter2');
      expect(error.value).toBe(ssl);
      expect(rejection({ server: { port: 99999 } }).value).toBe(99999);
    });

    it('does not print a rejected database password', () => {
      const error = rejection({ database: { mysql: { password: 12345678 as any } } });

      expect(error.field).toBe('database.mysql.password');
      expect(inspect(error)).not.toContain('12345678');
      expect(error.value).toBe(12345678);
    });
  });

  describe('Start-up warnings', () => {
    // warn() is an instance property (a noop when the level disables it), so
    // the calls are read from the shared log(level, message, context) sink.
    function captureWarnings() {
      globalLogger.setLevel('warn');
      const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
      return (pattern: RegExp) =>
        logSpy.mock.calls
          .filter(c => c[0] === 'warn')
          .map(c => String(c[1]))
          .filter(message => pattern.test(message));
    }

    const ANY_NEW_WARNING =
      /is not applied|is deprecated|cannot be read as a size|Unknown configuration|converted, not rejected/;

    afterEach(() => {
      jest.restoreAllMocks();
      globalLogger.setLevel('fatal');
    });

    it('says nothing for a default configuration', () => {
      const warnings = captureWarnings();

      loadConfig();
      loadConfigWithOptions({});

      expect(warnings(ANY_NEW_WARNING)).toEqual([]);
    });

    it('says nothing for explicit, valid values', () => {
      const warnings = captureWarnings();

      loadConfigWithOptions({
        cors: true,
        helmet: { xFrameOptions: 'SAMEORIGIN' },
        compression: { level: 9 },
        autoDiscover: { enabled: true, paths: ['./app/modules'] },
        validation: { enabled: true },
        logger: { level: 'warn', anythingTheLoggerReads: true } as any,
        server: {
          port: '8080' as any,
          maxConnections: 0,
          timeout: 30000,
          timeouts: { request: 30000 },
          bodySizeLimit: '512kb',
          maxUploadSize: 5 * 1024 * 1024,
          limits: { maxHeaderSize: '16 kb', maxPendingBytes: 65536 },
          gracefulShutdown: true,
        },
        modules: {
          session: { enabled: false, store: 'redis', storeOptions: { tls: { servername: 'x' } } },
          billing: { plan: 'pro' },
        } as any,
        security: { csp: { enabled: false, directives: { scriptSrcElem: ["'self'"] } as any } },
        performance: { compression: { gzip: { memLevel: 9 } } },
        jobs: { leaderElection: { strategy: 'file', lockTimeout: 5000 } },
      });

      expect(warnings(ANY_NEW_WARNING)).toEqual([]);
    });

    it('applies server.timeout as the request timeout when server.timeouts.request is not given, and names the new key once', () => {
      const warnings = captureWarnings();

      const config = loadConfigWithOptions({ server: { timeout: 30000 } });

      expect(config.server.timeouts?.request).toBe(30000);
      expect(config.server.timeout).toBe(30000);
      const found = warnings(/server\.timeout is deprecated/);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('(30000 ms) is applied as server.timeouts.request');
    });

    it('prefers server.timeouts.request to server.timeout, an explicit 0 included, without a warning', () => {
      const warnings = captureWarnings();

      const unset = loadConfigWithOptions({ server: { timeout: 0 } });
      const both = loadConfigWithOptions({
        server: { timeout: 30000, timeouts: { request: 10000 } },
      });
      const disabled = loadConfigWithOptions({
        server: { timeout: 30000, timeouts: { request: 0 } },
      });

      // server.timeout: 0 is "not set": the default request timeout applies
      expect(unset.server.timeouts?.request).toBe(300000);
      expect(both.server.timeouts?.request).toBe(10000);
      expect(disabled.server.timeouts?.request).toBe(0);
      expect(warnings(/is deprecated|is not applied/)).toEqual([]);
    });

    it('names each size string the parser cannot read and the size in force', () => {
      const warnings = captureWarnings();

      const config = loadConfigWithOptions({
        server: {
          bodySizeLimit: '500k',
          maxUploadSize: '2 megabytes',
          limits: { maxHeaderSize: '16kb ' },
        },
      });

      const found = warnings(/cannot be read as a size/);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("server.bodySizeLimit '500k' -> 10485760 bytes in force");
      expect(found[0]).toContain("server.maxUploadSize '2 megabytes' -> 10485760 bytes in force");
      expect(found[0]).toContain("server.limits.maxHeaderSize '16kb ' -> 10485760 bytes in force");
      // Reported only: the strings are accepted exactly as before.
      expect(config.server.bodySizeLimit).toBe('500k');
      expect(config.server.limits?.maxHeaderSize).toBe('16kb ');
    });

    it('lists unknown keys in known sections once', () => {
      const warnings = captureWarnings();

      const config = loadConfigWithOptions({
        server: { prot: 4000 },
        security: { cors: { enabled: true, orgin: 'https://a.example' } },
      } as any);

      const found = warnings(/Unknown configuration/);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('server.prot, security.cors.orgin');
      // Reported only: the keys are dropped exactly as before.
      expect(config.server.port).toBe(3001);
      expect((config.security.cors as any).orgin).toBeUndefined();
    });

    it('does not call a key unknown when it lives in a free-form part of the configuration', () => {
      const warnings = captureWarnings();

      loadConfigWithOptions({
        cors: { optionsSuccessStatus: 200 },
        http2: { peerMaxConcurrentStreams: 10 },
        modules: {
          payments: { provider: 'stripe' },
          session: { enabled: false, store: 'memory', cookie: { priority: 'high' } },
        },
        security: { helmet: { contentSecurityPolicy: "default-src 'self'" } },
      } as any);

      expect(warnings(/Unknown configuration/)).toEqual([]);
    });

    it('names numeric settings given as null, an empty string or a boolean', () => {
      const warnings = captureWarnings();

      const config = loadConfigWithOptions({
        server: { maxConnections: null, timeouts: { request: '' }, port: true },
      } as any);

      const found = warnings(/converted, not rejected/);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('server.port true -> 1 in force');
      expect(found[0]).toContain('server.maxConnections null -> 0 in force');
      expect(found[0]).toContain("server.timeouts.request '' -> 0 in force");
      // Reported only: the values are converted exactly as before.
      expect(config.server.port).toBe(1);
      expect(config.server.maxConnections).toBe(0);
    });
  });

  describe('Performance Baseline', () => {
    it('should measure current config loading performance', () => {
      const iterations = 50;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        loadConfig();
        resetConfig();
      }

      const end = performance.now();
      const avgTime = (end - start) / iterations;

      console.log(`\n📊 Current Performance Baseline:`);
      console.log(`  • ${iterations} config loads: ${(end - start).toFixed(2)}ms`);
      console.log(`  • Average per load: ${avgTime.toFixed(3)}ms`);
      console.log(`  • Loads per second: ${(1000 / avgTime).toFixed(0)}`);

      expect(avgTime).toBeLessThan(20); // Current baseline
    });

    it('should measure createApp options merging performance', () => {
      const options: MoroOptions = {
        cors: false,
        server: { port: 8080 },
        database: {
          redis: {
            url: 'redis://test:6379',
            maxRetries: 3,
            retryDelay: 1000,
            keyPrefix: 'test:',
          },
        },
        performance: {
          compression: {
            enabled: false,
            level: 6,
            threshold: 1024,
          },
        },
        logger: { level: 'error' },
      };

      const iterations = 30;
      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        loadConfigWithOptions(options);
        resetConfig();
      }

      const end = performance.now();
      const avgTime = (end - start) / iterations;

      console.log(`\n📊 Options Merging Performance:`);
      console.log(`  • ${iterations} merges: ${(end - start).toFixed(2)}ms`);
      console.log(`  • Average per merge: ${avgTime.toFixed(3)}ms`);

      expect(avgTime).toBeLessThan(25); // Current baseline
    });
  });
});
