// MoroEventBus: on/emit delivery, once semantics, module-bus namespacing/isolation,
// and namespaced-listener cleanup via destroyModuleBus() / no-arg removeAllListeners().
import { MoroEventBus } from '../../../src/core/events/event-bus.js';

describe('MoroEventBus', () => {
  let bus: MoroEventBus;

  beforeEach(() => {
    bus = new MoroEventBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
  });

  describe('global on/emit', () => {
    it('delivers the payload (data + context) to listeners', async () => {
      const received: any[] = [];
      bus.on('user.created', payload => {
        received.push(payload);
      });

      const result = await bus.emit('user.created', { id: 7 }, { source: 'test' });

      expect(result).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].data).toEqual({ id: 7 });
      expect(received[0].context.source).toBe('test');
    });

    it('returns false (early exit) when there are no listeners', async () => {
      const result = await bus.emit('nobody.listening', { x: 1 });
      expect(result).toBe(false);
    });

    it('delivers to every registered listener', async () => {
      let a = 0;
      let b = 0;
      bus.on('e', () => {
        a++;
      });
      bus.on('e', () => {
        b++;
      });

      await bus.emit('e', null);

      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(bus.listenerCount('e')).toBe(2);
    });

    it('off() removes a specific listener', async () => {
      let count = 0;
      const listener = () => {
        count++;
      };
      bus.on('e', listener);
      await bus.emit('e', 1);
      bus.off('e', listener);
      await bus.emit('e', 1);

      expect(count).toBe(1);
      expect(bus.listenerCount('e')).toBe(0);
    });
  });

  describe('once', () => {
    it('fires exactly once and then auto-removes the listener', async () => {
      let count = 0;
      bus.once('boot', () => {
        count++;
      });
      expect(bus.listenerCount('boot')).toBe(1);

      await bus.emit('boot', 1);
      await bus.emit('boot', 1);
      await bus.emit('boot', 1);

      expect(count).toBe(1);
      expect(bus.listenerCount('boot')).toBe(0);
    });
  });

  describe('module bus namespacing', () => {
    it('registers listeners under a module: namespace and delivers payloads', async () => {
      const mod = bus.createModuleBus('billing');
      let data: any = null;
      mod.on('charge', p => {
        data = p.data;
      });

      // Registered under the namespaced key on the global emitter, not the bare name.
      expect(bus.listenerCount('module:billing:charge')).toBe(1);
      expect(bus.listenerCount('charge')).toBe(0);

      await mod.emit('charge', { amount: 100 });

      expect(data).toEqual({ amount: 100 });
      expect(mod.listenerCount('charge')).toBe(1);
    });

    it('isolates identically-named events across different modules', async () => {
      const a = bus.createModuleBus('a');
      const b = bus.createModuleBus('b');
      let aHits = 0;
      let bHits = 0;
      a.on('ping', () => {
        aHits++;
      });
      b.on('ping', () => {
        bHits++;
      });

      await a.emit('ping', 1);

      expect(aHits).toBe(1);
      expect(bHits).toBe(0);
    });

    it('reuses the same module bus instance for a given id', () => {
      const first = bus.createModuleBus('same');
      const second = bus.createModuleBus('same');
      expect(second).toBe(first);
    });
  });

  describe('destroyModuleBus / no-arg removeAllListeners cleanup', () => {
    it("removes all of a module's namespaced listeners from the global emitter", () => {
      const mod = bus.createModuleBus('cleanup');
      mod.on('a', () => {});
      mod.on('b', () => {});
      mod.once('c', () => {});

      expect(bus.listenerCount('module:cleanup:a')).toBe(1);
      expect(bus.listenerCount('module:cleanup:b')).toBe(1);
      expect(bus.listenerCount('module:cleanup:c')).toBe(1);

      bus.destroyModuleBus('cleanup');

      // The whole point of the fix: no namespaced listener leaks behind.
      expect(bus.listenerCount('module:cleanup:a')).toBe(0);
      expect(bus.listenerCount('module:cleanup:b')).toBe(0);
      expect(bus.listenerCount('module:cleanup:c')).toBe(0);
    });

    it('no-arg removeAllListeners() on a module bus clears its listeners', () => {
      const mod = bus.createModuleBus('m2');
      mod.on('x', () => {});
      mod.on('y', () => {});
      expect(bus.listenerCount('module:m2:x')).toBe(1);
      expect(bus.listenerCount('module:m2:y')).toBe(1);

      mod.removeAllListeners();

      expect(bus.listenerCount('module:m2:x')).toBe(0);
      expect(bus.listenerCount('module:m2:y')).toBe(0);
    });
  });

  describe('metrics', () => {
    it('counts only events that actually had listeners', async () => {
      bus.on('counted', () => {});
      await bus.emit('counted', 1);
      await bus.emit('counted', 1);
      await bus.emit('uncounted', 1); // no listener -> early return, not counted

      const metrics = bus.getMetrics();
      expect(metrics.eventsByType['counted']).toBe(2);
      expect(metrics.eventsByType['uncounted']).toBeUndefined();
      expect(metrics.totalEvents).toBe(2);
    });
  });

  describe('async listeners', () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));

    beforeEach(() => {
      unhandled.length = 0;
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
      jest.restoreAllMocks();
    });

    it('logs a rejection from an async listener and never leaves it unhandled', async () => {
      const logged = jest.spyOn((bus as any).logger, 'error').mockImplementation(() => {});
      const delivered: number[] = [];
      bus.on('job.done', async () => {
        throw new Error('listener failed');
      });
      bus.on('job.done', payload => {
        delivered.push(payload.data);
      });

      expect(await bus.emit('job.done', 1)).toBe(true);
      await settle();

      expect(unhandled).toEqual([]);
      // The listeners registered after the failing one still ran
      expect(delivered).toEqual([1]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain('job.done');
      expect(logged.mock.calls[0][2]).toMatchObject({
        event: 'job.done',
        error: 'listener failed',
      });
      expect(bus.getMetrics().errorRate).toBe(100);
    });

    it('logs a rejection from a once() listener and from a module bus listener', async () => {
      const logged = jest.spyOn((bus as any).logger, 'error').mockImplementation(() => {});
      bus.once('first', async () => {
        throw new Error('once failed');
      });
      bus.createModuleBus('orders').on('placed', () => Promise.reject(new Error('module failed')));

      await bus.emit('first', null);
      await bus.createModuleBus('orders').emit('placed', null);
      await settle();

      expect(unhandled).toEqual([]);
      expect(logged.mock.calls.map(call => (call[2] as any).error)).toEqual([
        'once failed',
        'module failed',
      ]);
    });

    it('logs nothing for an async listener that resolves or a listener that returns a value', async () => {
      const logged = jest.spyOn((bus as any).logger, 'error').mockImplementation(() => {});
      bus.on('fine', async () => {});
      bus.on('fine', (() => 'a value') as any);

      await bus.emit('fine', null);
      await settle();

      expect(unhandled).toEqual([]);
      expect(logged).not.toHaveBeenCalled();
      expect(bus.getMetrics().errorRate).toBe(0);
    });

    it('off() removes an async listener registered by reference', async () => {
      let calls = 0;
      const listener = async () => {
        calls++;
      };
      bus.on('tick', listener);
      bus.off('tick', listener);

      expect(await bus.emit('tick', null)).toBe(false);
      expect(calls).toBe(0);
    });
  });
});
