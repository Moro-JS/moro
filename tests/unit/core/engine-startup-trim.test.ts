// The start-up trim of the engine server: once per isolate, a moment after
// its first server is listening, the engine is asked to give back what
// loading the application left on the heap (engine.trimMemory()).
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  scheduleStartupTrim,
  resetStartupTrimForTesting,
} from '../../../src/core/http/moro-engine-server.js';

function timers() {
  const scheduled: Array<{ fn: () => void; ms: number; unrefed: boolean }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    const entry = { fn, ms, unrefed: false };
    scheduled.push(entry);
    return { unref: () => void (entry.unrefed = true) };
  };
  return { scheduled, setTimer };
}

describe('start-up trim', () => {
  beforeEach(() => resetStartupTrimForTesting());

  it('asks the engine once, a moment after the first server listens, on a timer that holds nothing open', () => {
    let trims = 0;
    const engine = { trimMemory: () => void trims++ };
    const { scheduled, setTimer } = timers();
    const deps = { setTimer, heapTotal: () => 24 * 1024 * 1024, env: {} };

    expect(scheduleStartupTrim(engine, deps)).toBe(true);
    // A second server of the same isolate (a second app, a listen() after close()).
    expect(scheduleStartupTrim(engine, deps)).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(250);
    expect(scheduled[0].unrefed).toBe(true);
    expect(trims).toBe(0);

    scheduled[0].fn();
    expect(trims).toBe(1);
  });

  it('leaves a large heap alone: the collection would cost more than it returns', () => {
    let trims = 0;
    const { scheduled, setTimer } = timers();
    scheduleStartupTrim(
      { trimMemory: () => void trims++ },
      { setTimer, heapTotal: () => 300 * 1024 * 1024, env: {} }
    );
    scheduled[0].fn();
    expect(trims).toBe(0);
  });

  it('does nothing on an engine without trimMemory(), and a later engine that has it is still served', () => {
    const { scheduled, setTimer } = timers();
    expect(scheduleStartupTrim({}, { setTimer, env: {} })).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(
      scheduleStartupTrim({ trimMemory: () => {} }, { setTimer, heapTotal: () => 1, env: {} })
    ).toBe(true);
  });

  it('MORO_STARTUP_TRIM=0 turns it off', () => {
    let trims = 0;
    const { scheduled, setTimer } = timers();
    expect(
      scheduleStartupTrim(
        { trimMemory: () => void trims++ },
        { setTimer, heapTotal: () => 1, env: { MORO_STARTUP_TRIM: '0' } }
      )
    ).toBe(false);
    expect(scheduled).toHaveLength(0);
    expect(trims).toBe(0);
  });

  it("a trim that throws is not the application's problem", () => {
    const { scheduled, setTimer } = timers();
    scheduleStartupTrim(
      {
        trimMemory: () => {
          throw new Error('no');
        },
      },
      { setTimer, heapTotal: () => 1, env: {} }
    );
    expect(() => scheduled[0].fn()).not.toThrow();
  });
});
