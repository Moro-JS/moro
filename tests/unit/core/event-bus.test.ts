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
});
