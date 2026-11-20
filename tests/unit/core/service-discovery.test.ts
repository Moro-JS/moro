// ServiceRegistry: a health check is abandoned after its timeout and the
// service is dropped; a sweep never starts while the previous one is still
// running; service names are percent-encoded into Consul URLs.
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { ServiceRegistry } from '../../../src/core/networking/service-discovery.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait for `work`, but no longer than `ms`. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise(resolve => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work, limit]);
  clearTimeout(timer);
}

/** A fetch that never answers, and rejects only when its signal aborts. */
function hangingFetch() {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(
    (_input: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason));
      }) as any
  );
}

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry | undefined;

  afterEach(() => {
    registry?.destroy();
    registry = undefined;
    jest.restoreAllMocks();
  });

  describe('health checks', () => {
    it('gives up on an endpoint that does not answer and drops the service', async () => {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));
      const fetchSpy = hangingFetch();

      registry = new ServiceRegistry({ type: 'memory' });
      await registry.register({ name: 'slow', host: '127.0.0.1', port: 9, health: '/health' });
      await registry.register({ name: 'unchecked', host: '127.0.0.1', port: 9 });

      await settleWithin((registry as any).performHealthChecks(), 1000);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:9/health');
      // The request is bound to a 5 second abort signal
      expect(timeout).toHaveBeenCalledWith(5000);
      expect((fetchSpy.mock.calls[0][1] as any).signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(registry.getAllServices())).toEqual(['unchecked']);
    });

    it('keeps a service whose endpoint answers', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, statusText: 'OK' } as any);

      registry = new ServiceRegistry({ type: 'memory' });
      await registry.register({ name: 'up', host: '127.0.0.1', port: 9, health: '/health' });

      await (registry as any).performHealthChecks();

      expect(Object.keys(registry.getAllServices())).toEqual(['up']);
    });

    it('does not start a sweep while the previous one is still running', async () => {
      let answer: (response: unknown) => void = () => undefined;
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise(resolve => {
            answer = resolve;
          }) as any
      );

      registry = new ServiceRegistry({ type: 'memory', healthCheckInterval: 5 });
      await registry.register({ name: 'slow', host: '127.0.0.1', port: 9, health: '/health' });

      // Many intervals elapse while the first request is outstanding
      await sleep(80);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Once it finishes, the next interval sweeps again
      answer({ ok: true, statusText: 'OK' });
      await sleep(40);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('Consul URLs', () => {
    const consulUrl = 'http://consul.test:8500';

    it('percent-encodes the service name when discovering', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => [] } as any);

      registry = new ServiceRegistry({ type: 'consul', consulUrl });
      await registry.discover('billing/../../agent/self?x=1#y');

      expect(fetchSpy.mock.calls[0][0]).toBe(
        `${consulUrl}/v1/health/service/billing%2F..%2F..%2Fagent%2Fself%3Fx%3D1%23y?passing=true`
      );
    });

    it('percent-encodes the service name when deregistering', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as any);

      registry = new ServiceRegistry({ type: 'consul', consulUrl });
      await registry.deregister('billing/../force-leave/node-1');

      expect(fetchSpy.mock.calls[0][0]).toBe(
        `${consulUrl}/v1/agent/service/deregister/billing%2F..%2Fforce-leave%2Fnode-1`
      );
    });

    it('deregisters the instances it registered, by their Consul ID', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as any);

      registry = new ServiceRegistry({ type: 'consul', consulUrl });
      await registry.register({ name: 'billing', host: '10.0.0.5', port: 8080 });
      await registry.register({ name: 'billing', host: '10.0.0.6', port: 8080 });
      fetchSpy.mockClear();

      await registry.deregister('billing');
      expect(fetchSpy.mock.calls.map(call => call[0])).toEqual([
        `${consulUrl}/v1/agent/service/deregister/billing-10.0.0.5-8080`,
        `${consulUrl}/v1/agent/service/deregister/billing-10.0.0.6-8080`,
      ]);

      // Nothing is left to deregister under that name
      fetchSpy.mockClear();
      await registry.deregister('billing');
      expect(fetchSpy.mock.calls.map(call => call[0])).toEqual([
        `${consulUrl}/v1/agent/service/deregister/billing`,
      ]);
    });

    it('leaves an ordinary service name as written', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => [] } as any);

      registry = new ServiceRegistry({ type: 'consul', consulUrl });
      await registry.discover('user-service_v2.internal');

      expect(fetchSpy.mock.calls[0][0]).toBe(
        `${consulUrl}/v1/health/service/user-service_v2.internal?passing=true`
      );
    });
  });
});
