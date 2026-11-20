import { jest } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

  it('keeps the pool running for an app that uses it when another app is closed', async () => {
    // The pool is one per process, and two apps have to find the same one:
    // a fresh copy of the framework, in which no other test has used it.
    jest.resetModules();
    const fresh = await import('../../src/index.js');
    const options = { logger: { level: 'fatal' as const }, workers: { count: 1 } };
    app = (await fresh.createApp(options)) as unknown as Moro;
    const other = await fresh.createApp(options);
    await new Promise(resolve => setTimeout(resolve, 50));

    const pool = (app as any).workerFacade.workerManager;
    expect(pool).toBeTruthy();
    expect((other as any).workerFacade.workerManager).toBe(pool);

    await other.close();
    expect(pool.getStats().isShuttingDown).toBe(false);

    // The last app to use it takes it down
    await app.close();
    expect(pool.getStats().isShuttingDown).toBe(true);
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

// Real worker threads, in a child process running the BUILT framework (the
// compiled worker entry cannot be loaded under jest): what the process-wide
// pool does once the app that used it has been closed, and whether the
// process still ends by itself. Skips, saying why, when dist/ is not built or
// is older than the worker sources it would be testing (`npm run build`);
// MORO_TEST_DIST=<directory> names a build kept somewhere else and always runs.
const poolFixture = join(__dirname, '..', 'fixtures', 'workers', 'pool-lifetime.mjs');
const builtWorkers = join(__dirname, '..', '..', 'dist', 'core', 'workers');
const workerSources = join(__dirname, '..', '..', 'src', 'core', 'workers');
const poolSkipReason = ((): string | null => {
  if (process.env.MORO_TEST_DIST) {
    return existsSync(join(process.env.MORO_TEST_DIST, 'index.js'))
      ? null
      : 'MORO_TEST_DIST has no index.js';
  }
  for (const name of ['facade', 'worker-manager']) {
    const built = join(builtWorkers, `${name}.js`);
    if (!existsSync(built)) return 'dist/ is not built';
    if (statSync(built).mtimeMs < statSync(join(workerSources, `${name}.ts`)).mtimeMs) {
      return 'dist/ is older than src/core/workers';
    }
  }
  return null;
})();
if (poolSkipReason) {
  console.log(`workers-config: ${poolSkipReason}, the worker pool lifetime tests skip`);
}
const describeBuilt = poolSkipReason ? describe.skip : describe;

function runPoolFixture(
  mode: string
): Promise<{ lines: string[]; code: number | null; endedByItself: boolean; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [poolFixture], {
      env: { ...process.env, MODE: mode, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let endedByItself = true;
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    // Long enough for a loaded machine to start two apps and their threads
    const giveUp = setTimeout(() => {
      endedByItself = false;
      child.kill('SIGKILL');
    }, 20000);
    child.on('exit', code => {
      clearTimeout(giveUp);
      resolve({ lines: stdout.split('\n').filter(Boolean), code, endedByItself, stderr });
    });
  });
}

describeBuilt('the worker pool after the app that used it is closed', () => {
  const HASH = /^[0-9a-f]{64}$/;

  it('is started again for an app created afterwards, and the process ends when that app is closed', async () => {
    const run = await runPoolFixture('second-app');

    expect(run.stderr).toBe('');
    expect(run.lines).toHaveLength(3);
    const [first, second, end] = run.lines.map(line => line.split(' '));
    expect(first[0]).toBe('first');
    expect(first[1]).toMatch(HASH);
    expect(second).toEqual(['second', first[1]]);
    expect(end).toEqual(['end']);
    expect(run.endedByItself).toBe(true);
    expect(run.code).toBe(0);
  }, 30000);

  it('is started again for an app that was created earlier and first uses workers then', async () => {
    const run = await runPoolFixture('late-first-use');

    expect(run.stderr).toBe('');
    expect(run.lines.map(line => line.split(' ')[0])).toEqual(['first', 'late', 'end']);
    expect(run.lines[1].split(' ')[1]).toBe(run.lines[0].split(' ')[1]);
    expect(run.endedByItself).toBe(true);
    expect(run.code).toBe(0);
  }, 30000);

  it('runs a task for code that outlived its app, without keeping the process alive', async () => {
    const run = await runPoolFixture('stray');

    expect(run.stderr).toBe('');
    expect(run.lines.map(line => line.split(' ')[0])).toEqual(['first', 'stray', 'stray', 'end']);
    expect(run.lines[1]).toBe('stray threads 1');
    expect(run.lines[2].split(' ')[1]).toBe(run.lines[0].split(' ')[1]);
    // Nothing released that pool, and the process still ends
    expect(run.endedByItself).toBe(true);
    expect(run.code).toBe(0);
  }, 30000);
});
