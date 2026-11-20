// Unit tests - MiddlewareManager.install(): what happens when a middleware's
// own install() fails. install() is not awaited, so a failure must be logged
// with the middleware's name, and must still surface as a rejection so a
// middleware that could not install is never silently missing.
import { describe, it, expect, jest } from '@jest/globals';
import { MiddlewareManager } from '../../../src/core/middleware/index.js';
import type { MiddlewareInterface } from '../../../src/types/hooks.js';

const named = (name: string, install: MiddlewareInterface['install']): MiddlewareInterface => ({
  name,
  version: '1.0.0',
  metadata: { name, version: '1.0.0' },
  install,
});

/**
 * An install() result whose rejection the test delivers by hand: the manager
 * attaches its handler to it exactly as it would to a promise, and the test
 * then observes what that handler does with a failure.
 */
function pendingInstall() {
  let onRejected: ((reason: unknown) => unknown) | undefined;
  const result = {
    then(_onFulfilled: unknown, rejected?: (reason: unknown) => unknown) {
      onRejected = rejected;
      return result;
    },
  };
  return {
    result: result as unknown as Promise<void>,
    reject: (reason: unknown) => (onRejected as (reason: unknown) => unknown)(reason),
  };
}

describe('MiddlewareManager.install', () => {
  it('logs an error naming the middleware when its async install rejects', () => {
    const manager = new MiddlewareManager();
    const error = jest.spyOn((manager as any).logger, 'error').mockImplementation(() => {});
    const failure = new Error('signing secret missing');
    const install = pendingInstall();

    manager.install(named('needs-secret', () => install.result));
    expect(error).not.toHaveBeenCalled();

    // The failure is passed on unchanged, so it still reaches the process as
    // a rejection: a middleware that could not install stays a start-up failure
    expect(() => install.reject(failure)).toThrow(failure);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "Middleware 'needs-secret' failed to install: signing secret missing",
      'Installation'
    );
  });

  it('logs nothing when install succeeds, sync or async', async () => {
    const manager = new MiddlewareManager();
    const error = jest.spyOn((manager as any).logger, 'error').mockImplementation(() => {});

    manager.install(named('sync-ok', () => {}));
    manager.install(named('async-ok', async () => {}));
    await new Promise(resolve => setImmediate(resolve));

    expect(error).not.toHaveBeenCalled();
    expect(manager.getInstalled()).toEqual(['sync-ok', 'async-ok']);
  });

  it('still throws synchronously when install throws synchronously', () => {
    const manager = new MiddlewareManager();

    expect(() =>
      manager.install(
        named('sync-fail', () => {
          throw new Error('bad options');
        })
      )
    ).toThrow('bad options');
  });
});
