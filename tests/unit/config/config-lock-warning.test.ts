// @ts-nocheck
// Unit - configuration is one-per-process. A later createApp()/initializeConfig
// call that carries its own options must say loudly that they were ignored,
// instead of silently handing back the first app's config.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import {
  initializeConfig,
  initializeConfigAsync,
  resetConfig,
} from '../../../src/core/config/index.js';
import { MoroLogger } from '../../../src/core/logger/index.js';

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
