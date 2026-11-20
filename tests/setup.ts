// Test Setup - Global configuration and utilities for MoroJS tests
import { jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import { destroyGlobalLogger, logger } from '../src/core/logger/index.js';
import { UnifiedRouter } from '../src/core/routing/unified-router.js';
import { ObjectPoolManager } from '../src/core/pooling/object-pool-manager.js';

// Set up minimal test environment configuration for MoroJS
process.env.NODE_ENV = 'test';
process.env.MORO_SERVER_PORT = '0'; // Use dynamic port
process.env.MORO_SERVER_HOST = 'localhost';

// In CI or when running coverage, use fatal level to minimize logging and save memory
// Otherwise use error level for minimal output
// Note: we intentionally do NOT set MORO_LOG_LEVEL env var here — config-sources
// writes it into config.logging.level, which leaks into tests that assert on
// the resolved config's default values. Using logger.setLevel() directly is
// enough to silence output without polluting the config system.
if (process.env.CI === 'true' || process.argv.includes('--coverage')) {
  logger.setLevel('fatal');

  // Completely disable the global logger to prevent memory accumulation
  // This won't affect tests because they don't assert on logger behavior
  // (tests that need logging create their own mock loggers)
  logger.debug = jest.fn();
  logger.info = jest.fn();
  logger.warn = jest.fn();
  logger.error = jest.fn();
  logger.fatal = jest.fn();
} else {
  logger.setLevel('error');
}

// Extend Jest timeout for integration tests.
// Deliberately generous: integration suites boot a real server (sometimes the
// native engine) inside the test body, and under `test:coverage` — where
// instrumentation plus parallel workers saturate the machine — a boot that
// normally takes milliseconds can take seconds. These tests assert protocol
// correctness, not latency, so a high ceiling costs nothing on green runs and
// removes a whole class of load-dependent flakes. Per-socket/per-request
// timeouts inside tests must stay BELOW this so failures surface with their own
// diagnostic rather than a bare Jest timeout.
jest.setTimeout(30000);

// Global test utilities
declare global {
  var testPort: number;
}

// Monotonic port allocator, namespaced per Jest worker so it's collision-free
// both WITHIN a worker (monotonic) and ACROSS parallel workers (each worker gets
// its own 1000-port band via JEST_WORKER_ID). This is what lets the suite run
// with maxWorkers > 1 without random-port clashes. (New tests can still prefer
// app.listen(0) + reading the bound port.)
//
// Some ports in those bands cannot be used and are stepped over: the ones
// fetch() refuses to connect to whatever is listening (the WHATWG "bad ports"
// list; a test that landed on one failed with "bad port"), and the ones macOS
// itself listens on: 5000 and 7000 (AirPlay Receiver), the first port of
// workers 2 and 4, and 8021 (the ftp-proxy launch daemon, on loopback), which
// was the 22nd port of whichever test file ran in worker 5.
const FETCH_BAD_PORTS = [
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
];
const UNUSABLE_TEST_PORTS = new Set([...FETCH_BAD_PORTS, 5000, 7000, 8021]);

/** The first port at or after `port` that a test may listen on and fetch from. */
export const usableTestPort = (port: number): number => {
  while (UNUSABLE_TEST_PORTS.has(port)) port++;
  return port;
};

const __workerId = parseInt(process.env.JEST_WORKER_ID || '1', 10);
let __nextTestPort = 3000 + __workerId * 1000;
const allocTestPort = () => {
  const port = usableTestPort(__nextTestPort);
  __nextTestPort = port + 1;
  return port;
};
globalThis.testPort = allocTestPort();

// Mock console methods for cleaner test output (optional)
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  // Reset singletons before each test to ensure test isolation
  UnifiedRouter.reset();
  ObjectPoolManager.reset();

  // Reset console mocks before each test
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterEach(async () => {
  // Clean up logger resources FIRST to prevent Jest open handles
  // destroy() clears all timeouts and flushes buffer
  try {
    destroyGlobalLogger();
  } catch {
    // Ignore cleanup errors
  }

  // Restore console methods after each test
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

// Global cleanup after all tests complete
afterAll(async () => {
  // Final cleanup of logger resources
  // destroy() clears all timeouts and flushes buffer
  try {
    destroyGlobalLogger();
  } catch {
    // Ignore cleanup errors
  }
});

// Global test helpers
export const createTestPort = () => allocTestPort();

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Wait until `condition` is truthy, polling until a deadline.
 *
 * Prefer this over `await delay(n)` before an assertion. A fixed sleep is
 * simultaneously too slow on an idle machine and too short on a loaded one —
 * it is the usual source of load-dependent flakes. Polling returns as soon as
 * the condition holds (usually faster than the sleep it replaces) while still
 * tolerating a slow run.
 *
 * Throws with the supplied description on timeout, so a failure reads as
 * "waited for X" rather than a bare assertion mismatch.
 */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 25, description = 'condition' } = {}
): Promise<void> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${description}`);
    }
    await delay(interval);
  }
};

/**
 * Properly close a Moro app instance with logger cleanup
 * Use this in tests instead of app.core.httpServer.close()
 */
export const closeApp = async (app: any): Promise<void> => {
  try {
    // Close HTTP server with timeout to prevent hanging
    if (app && app.core && app.core.httpServer) {
      await Promise.race([
        new Promise<void>(resolve => {
          // The engine server takes a callback; the Node servers return a promise.
          const closing = app.core.httpServer.close(() => resolve());
          if (closing && typeof closing.then === 'function') {
            closing.then(
              () => resolve(),
              () => resolve()
            );
          }
        }),
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, 1000); // 1 second timeout
          t.unref?.(); // don't keep the event loop / Jest alive
        }),
      ]);
    }

    // Destroy logger to clear all timeouts and prevent open handles
    // destroy() already flushes the buffer internally
    if (app && app.logger && typeof app.logger.destroy === 'function') {
      app.logger.destroy();
    }
  } catch (error) {
    // Ignore close errors in tests
  }
};

export const waitForServer = async (port: number, maxAttempts = 10): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) return true;
    } catch {
      // Server not ready yet
    }
    await delay(100);
  }
  return false;
};
