import { createApp } from '../../src/index.js';
import { Moro } from '../../src/moro.js';

// The worker entry is stubbed under jest, so no real threads spawn here.
// These tests cover the config wiring and lifecycle, not thread execution
// (that is covered by the dist smoke script).
describe('createApp({ workers }) configuration', () => {
  let app: Moro;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('eagerly initializes the worker pool when configured', async () => {
    app = await createApp({
      logging: { level: 'fatal' },
      workers: { count: 1, maxQueueSize: 10 },
    });

    // Initialization is async; give it a tick
    await new Promise(resolve => setTimeout(resolve, 50));

    expect((app as any).workerFacade.workerManager).toBeTruthy();
  });

  it('does not initialize workers when not configured, and close() does not spin them up', async () => {
    app = await createApp({ logging: { level: 'fatal' } });

    expect((app as any).workerFacade.workerManager).toBeNull();
    await app.close();

    // shutdown() must be a no-op — never initialize a pool just to tear it down
    expect((app as any).workerFacade.initialized).toBe(false);
  });

  it('respects workers.enabled = false', async () => {
    app = await createApp({
      logging: { level: 'fatal' },
      workers: { enabled: false, count: 2 },
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect((app as any).workerFacade.workerManager).toBeNull();
  });
});
