// @ts-nocheck
// Unit - initializeConfig() sets the configuration up once: a later call
// that carries its own options must say loudly that they were ignored,
// instead of silently handing back the existing config. Apps do not go
// through that rule: each one is created with a configuration of its own.
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import { MoroLogger, logger as globalLogger } from '../../../src/core/logger/index.js';

// The config module's own logger is a child of the global logger, created
// when the module is first imported, and a child compiles a level that is
// switched off into a no-op method. The shared test setup pins the global
// level to 'fatal', so the module is imported here, after lowering it,
// rather than statically - otherwise whether error() does anything depends
// on hook ordering (it did, in the full coverage run).
let initializeConfig: any;
let initializeConfigAsync: any;
let createAppConfig: any;
let createAppConfigAsync: any;
let getGlobalConfig: any;
let resetConfig: any;

beforeAll(async () => {
  globalLogger.setLevel('error');
  ({
    initializeConfig,
    initializeConfigAsync,
    createAppConfig,
    createAppConfigAsync,
    getGlobalConfig,
    resetConfig,
  } = await import('../../../src/core/config/index.js'));
});

afterAll(() => {
  globalLogger.setLevel('fatal');
});

// error() is an instance property (a noop when the level disables it), so the
// tests spy on the shared private log(level, message, ...) sink instead.
function spyErrors() {
  const logSpy = jest.spyOn(MoroLogger.prototype as any, 'log').mockImplementation(() => {});
  return () => logSpy.mock.calls.filter(c => c[0] === 'error').map(c => String(c[1]));
}

describe('configuration lock', () => {
  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  it('logs at ERROR and names the ignored keys when a second init passes options', async () => {
    const errors = spyErrors();

    const first = await initializeConfigAsync({ server: { port: 4101 } });
    expect(first.server.port).toBe(4101);

    const second = await initializeConfigAsync({
      server: { port: 4102, ssl: { keyFile: '/k', certFile: '/c' } },
      logger: { level: 'fatal' },
      performance: { clustering: { enabled: true } },
    });
    // Still the first configuration: initializeConfig() sets it up once
    expect(second).toBe(first);
    expect(second.server.port).toBe(4101);

    const hit = errors().find(m => m.includes('ignoring options'));
    expect(hit).toBeDefined();
    expect(hit).toContain('server');
    expect(hit).toContain('performance');
    expect(hit).not.toContain('logger'); // logger is applied early, not a config key
  });

  it('stays quiet when a later init passes no options (same for the sync path)', async () => {
    const errors = spyErrors();
    await initializeConfigAsync({ server: { port: 4103 } });
    await initializeConfigAsync();
    initializeConfig(undefined);
    initializeConfig({ logger: { level: 'fatal' } });
    expect(errors().find(m => m.includes('ignoring options'))).toBeUndefined();

    initializeConfig({ server: { port: 1 } });
    expect(errors().find(m => m.includes('ignoring options'))).toBeDefined();
  });
});

describe('the configuration of each app', () => {
  afterEach(() => {
    resetConfig();
    jest.restoreAllMocks();
  });

  it('is built from that app’s own options, and the newest one is the global configuration', async () => {
    const errors = spyErrors();

    const first = await createAppConfigAsync({ server: { port: 4111, bodySizeLimit: '1kb' } });
    const second = await createAppConfigAsync({ server: { port: 4112 } });
    const third = createAppConfig();

    expect(first.server.port).toBe(4111);
    expect(first.server.bodySizeLimit).toBe('1kb');
    expect(second.server.port).toBe(4112);
    expect(second.server.bodySizeLimit).not.toBe('1kb');
    expect(third.server.port).not.toBe(4112);
    expect(third).not.toBe(second);
    expect(getGlobalConfig()).toBe(third);

    // Every one of them is immutable, and nothing was ignored
    expect(Object.isFrozen(first.server)).toBe(true);
    expect(Object.isFrozen(second.server)).toBe(true);
    expect(errors().find(m => m.includes('ignoring options'))).toBeUndefined();
  });

  it('is the one initializeConfig() set up, for the first app created after it only', () => {
    const errors = spyErrors();

    const direct = initializeConfig({ server: { port: 4113 } });
    const first = createAppConfig();
    expect(first).toBe(direct);
    expect(errors().find(m => m.includes('ignoring options'))).toBeUndefined();

    const second = createAppConfig({ server: { port: 4114 } });
    expect(second.server.port).toBe(4114);
    expect(first.server.port).toBe(4113);
    expect(getGlobalConfig()).toBe(second);
  });

  it('names the options of the first app when a configuration was already set up for it', () => {
    const errors = spyErrors();

    const direct = initializeConfig({ server: { port: 4115 } });
    const first = createAppConfig({ server: { port: 4116 } });

    expect(first).toBe(direct);
    const hit = errors().find(m => m.includes('ignoring options'));
    expect(hit).toBeDefined();
    expect(hit).toContain('server');
  });
});
