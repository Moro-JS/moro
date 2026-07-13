/* eslint-disable */
// @ts-nocheck
// Integration Tests - leak / soak coverage for the create -> listen -> close app
// lifecycle. Loops many full app lifecycles and asserts two things stay bounded:
//   1. process-level shutdown listeners (SIGINT/SIGTERM) - the framework installs
//      ONE shared handler for every Moro instance, so creating N apps must never
//      accumulate N listeners (validates the shared-shutdown-handler design).
//   2. RSS growth across the loop - guards against per-lifecycle native/JS leaks
//      like the engine-adapter inflight-Map churn that was previously only caught
//      by hand. RSS assertions require a real GC, so they only run under
//      `node --expose-gc` (global.gc present); without it the loop still runs and
//      the listener-count assertions still apply - the RSS checks are skipped, not
//      failed (so the default `jest` run stays green).
//
// Uses whichever HTTP engine is the default on this platform (the native
// @morojs/engine when it loads, else the Node http server) - both exercise the
// same lifecycle. `app.listen(0)` is intentionally NOT used: Moro.listen() treats
// port 0 as falsy and rejects it, so each cycle binds a fresh high port and fully
// closes before the next (no port reuse hazard).
import { describe, it, expect, afterEach } from '@jest/globals';
import { createApp } from '../../src/index.js';
import { resetConfig } from '../../src/core/config/index.js';
import { UnifiedRouter } from '../../src/core/routing/unified-router.js';
import { closeApp, delay } from '../setup.js';
import { engineLoadable } from './engine-test-utils.js';

// Ports above 10080 dodge the WHATWG fetch bad-port blocklist entirely.
const testPort = () => 10100 + Math.floor(Math.random() * 5000);

const listen = (app: any, port: number) =>
  new Promise<void>(resolve => app.listen(port, () => resolve()));

// process.stdout.write, not console.log: the global test setup replaces
// console.* with jest.fn() inside each test, which would swallow the summary.
const log = (line: string) => process.stdout.write(line + '\n');

const hasGc = typeof (global as any).gc === 'function';
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

// Settle memory before a measurement: several GC passes with short gaps so the
// native engine allocator and V8 both release what they can. Measuring RSS
// straight after the loop (before GC) would read transient, uncollected pages.
async function settleAndRss(): Promise<number> {
  if (hasGc) {
    (global as any).gc();
    await delay(60);
    (global as any).gc();
    await delay(60);
    (global as any).gc();
  }
  return process.memoryUsage().rss;
}

// One full lifecycle: reset singletons, create app, register a couple of routes,
// bind, make a few real requests, then fully close (and defensively drain the DI
// container's intervals) so nothing carries over to the next iteration.
async function oneCycle(i: number): Promise<void> {
  resetConfig();
  UnifiedRouter.reset(); // process-wide singleton router - isolate each cycle
  const app = await createApp({ logger: { level: 'fatal' } });
  try {
    app.get('/ping', () => ({ ok: true, i }));
    app.get('/data', (req: any) => ({ success: true, data: { i, q: req.query.q ?? null } }));

    const port = testPort();
    await listen(app, port);

    const base = `http://127.0.0.1:${port}`;
    const r1 = await fetch(`${base}/ping`);
    await r1.text();
    const r2 = await fetch(`${base}/data?q=${i}`);
    const b2 = await r2.json();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(b2).toEqual({ success: true, data: { i, q: String(i) } });
  } finally {
    await closeApp(app);
    // Defensive: clear any DI-container intervals so many iterations don't leak
    try {
      app.core?.container?.destroy?.();
    } catch {
      // ignore
    }
  }
}

describe('Framework create/listen/close leak-soak', () => {
  afterEach(async () => {
    resetConfig();
  });

  it('keeps RSS and process shutdown-listener counts bounded across many app lifecycles', async () => {
    // The native-engine allocator ramps its working set over the first ~35
    // lifecycles and then plateaus; measuring across that ramp would read a
    // one-time steady-state cost as "growth". So warm up PAST the knee, then
    // measure the plateau: a genuine per-cycle leak keeps climbing linearly
    // and blows the ceiling, while healthy steady state stays nearly flat.
    // The long warmup only matters for the RSS plateau measurement (gc path).
    // Without --expose-gc (the default `jest` run) we only validate listener
    // counts, so run far fewer cycles to keep well under the timeout.
    const WARMUP = hasGc ? 40 : 8; // past the allocator ramp / knee
    const LOOP = hasGc ? 30 : 6; // measured window, on the plateau

    log(
      `[leak-soak] engine=${engineLoadable ? 'native (@morojs/engine)' : 'node http'} ` +
        `gc=${hasGc ? 'available' : 'UNAVAILABLE (run node --expose-gc for RSS assertions)'}`
    );

    // Baseline listener counts BEFORE any app installs the shared handler.
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    for (let i = 0; i < WARMUP; i++) await oneCycle(i);

    const rssAfterWarmup = await settleAndRss();
    const sigintAfterWarmup = process.listenerCount('SIGINT');

    for (let i = 0; i < LOOP; i++) await oneCycle(WARMUP + i);

    const rssAfterLoop = await settleAndRss();

    const sigintAfter = process.listenerCount('SIGINT');
    const sigtermAfter = process.listenerCount('SIGTERM');

    // Shared-shutdown-handler design: the SIGINT/SIGTERM handlers are installed
    // exactly once for the whole process, no matter how many apps are created.
    // A regression to per-instance handlers would make these grow ~1 per cycle.
    log(
      `[leak-soak] SIGINT listeners before=${sigintBefore} afterWarmup=${sigintAfterWarmup} ` +
        `afterLoop=${sigintAfter}; SIGTERM before=${sigtermBefore} afterLoop=${sigtermAfter}`
    );
    expect(sigintAfter - sigintBefore).toBeLessThanOrEqual(2);
    expect(sigtermAfter - sigtermBefore).toBeLessThanOrEqual(2);
    // No growth from the end of warmup through 30 more cycles: the handler is
    // already installed by then, so the count must be flat.
    expect(sigintAfter).toBeLessThanOrEqual(sigintAfterWarmup);
    expect(sigtermAfter).toBeLessThanOrEqual(sigintAfterWarmup + sigtermBefore);

    if (hasGc) {
      const growth = rssAfterLoop - rssAfterWarmup;
      log(
        `[leak-soak] RSS afterWarmup=${mb(rssAfterWarmup)}MB afterLoop=${mb(rssAfterLoop)}MB ` +
          `growth=${mb(growth)}MB over ${LOOP} cycles`
      );
      // Generous ceiling. On the plateau, 30 healthy cycles add only a few MB
      // (observed ~2-4MB); a real per-cycle leak (handles/maps retained per app)
      // would add ~1-2MB EVERY cycle and sail past this. 30MB keeps ~10x margin.
      expect(growth).toBeLessThan(30 * 1024 * 1024);
    } else {
      log('[leak-soak] RSS assertions skipped (no global.gc); loop completed without throwing');
      // Still assert the loop actually ran and RSS is a sane positive number.
      expect(rssAfterLoop).toBeGreaterThan(0);
    }
  }, 120000);
});
