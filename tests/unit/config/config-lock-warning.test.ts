// @ts-nocheck
// Unit - configuration is one-per-process. A later createApp()/initializeConfig
// call that carries its own options must say loudly that they were ignored,
// instead of silently handing back the first app's config.
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
let resetConfig: any;

beforeAll(async () => {
  globalLogger.setLevel('error');
  ({ initializeConfig, initializeConfigAsync, resetConfig } =
    await import('../../../src/core/config/index.js'));
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
    // Still the first app's config - this is the documented one-per-process rule
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
