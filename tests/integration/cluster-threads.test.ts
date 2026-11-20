// Integration - worker-thread clustering end to end. Spawns the fixture app
// as a child process (through tsx, the way a TypeScript entry runs in dev)
// with performance.clustering enabled and inspects what actually served:
//   - every response comes from a worker THREAD of the child (pid === child
//     pid, isMainThread false) when the engine advertises workerThreads and
//     the platform is POSIX;
//   - more than one thread answers (Linux; macOS SO_REUSEPORT can pin);
//   - SIGTERM drains an in-flight request and the child exits 0;
//   - a worker that throws is restarted and the child keeps serving;
//   - on Windows the same fixture runs as worker PROCESSES;
//   - a TypeScript entry run through tsx falls back to worker processes
//     (tsx's hooks do not apply inside worker threads) and still serves.
// The thread-path fixture is plain JavaScript loading the BUILT framework
// (dist/), so `npm run build` must have run; without dist the thread tests
// skip with that reason. Self-skips when the engine cannot run threads.
// MORO_TEST_DIST=<directory> runs the JavaScript fixtures against a build
// kept somewhere else.
//
// The second half (cluster lifecycle) drives tests/fixtures/cluster/lifecycle.mjs:
// what a signal, app.close(), a dying worker and stray messages do to a
// cluster of worker threads and to one of worker processes (`engine: 'node'`
// clusters as processes on every platform).
import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineLoadable } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { createTestPort, waitFor } from '../setup.js';

// ts-jest compiles this suite to CommonJS: __dirname / require.resolve, not
// import.meta (which the transform cannot express).
const fixtureJs = join(__dirname, '..', 'fixtures', 'cluster', 'app.mjs');
const fixtureTs = join(__dirname, '..', 'fixtures', 'cluster', 'app.ts');
const lifecycleJs = join(__dirname, '..', 'fixtures', 'cluster', 'lifecycle.mjs');
const distBuilt = existsSync(
  join(process.env.MORO_TEST_DIST || join(__dirname, '..', '..', 'dist'), 'index.js')
);
const tsxCli = require.resolve('tsx/cli');

const loaded = engineLoadable ? loadNativeEngine() : null;
const caps = loaded?.capabilities;
const threadsExpected = process.platform !== 'win32' && caps?.workerThreads === true;
const reason = !engineLoadable
  ? '@morojs/engine not loadable'
  : !caps?.workerThreads
    ? 'engine build has no workerThreads capability (< 1.1.6)'
    : !distBuilt
      ? 'dist/ not built (the thread fixture loads the built framework: npm run build)'
      : null;
const describeCluster =
  reason && process.env.MORO_REQUIRE_ENGINE !== '1' ? describe.skip : describe;
if (reason) console.log(`cluster-threads: ${reason}`);

let child: ChildProcess | null = null;
let stderr = '';
let stdout = '';

function startFixture(port: number, entry: 'js' | 'ts' = 'js'): Promise<void> {
  return new Promise((resolve, reject) => {
    const argv = entry === 'js' ? [fixtureJs] : [tsxCli, fixtureTs];
    child = spawn(process.execPath, argv, {
      env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so killTree() can take the whole tree down.
      detached: process.platform !== 'win32',
    });
    let out = '';
    child.stdout!.on('data', d => {
      out += d;
      stdout += d;
      if (out.includes('CLUSTER_READY')) resolve();
    });
    child.stderr!.on('data', d => {
      stderr += d;
    });
    child.on('exit', code => {
      if (!out.includes('CLUSTER_READY'))
        reject(new Error(`fixture exited ${code} before ready:\n${stderr}`));
    });
    setTimeout(() => reject(new Error(`fixture did not become ready:\n${stderr}`)), 20000).unref();
  });
}

async function get(port: number, path = '/') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: 'close' } });
  return { status: res.status, body: (await res.json()) as any };
}

// waitFor() rethrows a throwing condition: a refused connection while the
// workers are still binding must count as "not yet", not as a failure.
const serving = (port: number) => async () => {
  try {
    return (await get(port)).status === 200;
  } catch {
    return false;
  }
};

// Kill the fixture's WHOLE process tree: the tsx entry is a CLI wrapper whose
// real node process (and, in the process-transport fallback, its cluster
// workers holding the port with SO_REUSEPORT) would otherwise outlive a kill
// of the wrapper and keep answering later tests' requests with 404s (the
// port allocator restarts per test file).
function killTree(c: ChildProcess) {
  if (process.platform !== 'win32' && c.pid) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  try {
    c.kill('SIGKILL');
  } catch {
    /* already exited */
  }
}

afterEach(async () => {
  if (child) {
    const c = child;
    if (c.exitCode === null) {
      const exited = new Promise(r => c.once('exit', r));
      killTree(c);
      await exited;
    } else {
      killTree(c); // the wrapper exited; its tree may not have
    }
  }
  child = null;
  stderr = '';
  stdout = '';
});

describeCluster(`clustering (${threadsExpected ? 'worker threads' : 'worker processes'})`, () => {
  it('serves from cluster workers; threads share the child pid, processes do not', async () => {
    const port = createTestPort();
    await startFixture(port);
    await waitFor(serving(port), { timeout: 10000, description: 'first response' });
    const pids = new Set<number>();
    const threads = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const { status, body } = await get(port);
      expect(status).toBe(200);
      pids.add(body.pid);
      threads.add(body.threadId);
      expect(body.isMainThread).toBe(!threadsExpected);
    }
    if (threadsExpected) {
      expect(pids).toEqual(new Set([child!.pid]));
      for (const t of threads) expect(t).toBeGreaterThan(0);
      if (process.platform === 'linux') {
        // The fixture reports ready when its FIRST worker listens; on a busy
        // machine the 40 requests above can all be answered before the
        // second one has bound. Keep asking until it has answered too.
        await waitFor(
          async () => {
            const { body } = await get(port);
            expect(body.pid).toBe(child!.pid);
            expect(body.threadId).toBeGreaterThan(0);
            threads.add(body.threadId);
            return threads.size >= 2;
          },
          { timeout: 10000, description: 'a response from the second worker thread' }
        );
        expect(threads.size).toBe(2);
      }
    } else {
      expect(pids.has(child!.pid!)).toBe(false);
    }
  }, 60000);

  it('SIGTERM drains an in-flight request and exits 0', async () => {
    const port = createTestPort();
    await startFixture(port);
    await waitFor(serving(port), { timeout: 10000, description: 'first response' });
    const slow = get(port, '/slow');
    await new Promise(r => setTimeout(r, 50));
    child!.kill('SIGTERM');
    const { status, body } = await slow;
    expect(status).toBe(200);
    expect(body.slow).toBe(true);
    const code = await new Promise<number | null>(r => child!.once('exit', c => r(c)));
    expect(code).toBe(0);
    await waitFor(
      async () => {
        try {
          await get(port);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 5000, description: 'port released' }
    );
  }, 60000);

  it('a worker that throws is restarted and the cluster keeps serving', async () => {
    const port = createTestPort();
    await startFixture(port);
    await waitFor(serving(port), { timeout: 10000, description: 'first response' });
    const before = new Set<number>();
    for (let i = 0; i < 20; i++)
      before.add((await get(port)).body.threadId ?? (await get(port)).body.pid);
    const crashed = await get(port, '/crash');
    expect(crashed.status).toBe(202);
    // The crashed worker is replaced; the child process itself survives.
    await new Promise(r => setTimeout(r, 1000));
    expect(child!.exitCode).toBeNull();
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const r = await get(port).catch(() => null);
      if (r && r.status === 200) ok++;
    }
    expect(ok).toBeGreaterThan(0);
    await waitFor(serving(port), { timeout: 10000, description: 'serving after restart' });
  }, 60000);

  it('a TypeScript entry under tsx serves either way: threads when the loader reaches them, processes otherwise', async () => {
    const port = createTestPort();
    await startFixture(port, 'ts');
    await waitFor(serving(port), { timeout: 20000, description: 'first response' });
    const { status, body } = await get(port);
    expect(status).toBe(200);
    // Whether tsx's hooks apply inside worker threads depends on the Node
    // line (24.11: no - the threads cannot resolve the .ts entry, boot fails,
    // and the primary falls back to processes with a warning; 24.21: yes -
    // the threads boot). Both are correct; what must hold is that the served
    // mode matches what the primary reported.
    // An engine without workerThreads never tries threads in the first place.
    const fellBack = /falling back to worker processes/.test(stdout + stderr);
    if (!threadsExpected || fellBack) {
      expect(body.isMainThread).toBe(true); // a worker process's main thread
    } else {
      expect(body.isMainThread).toBe(false); // a worker thread
      expect(body.threadId).toBeGreaterThan(0);
    }
    // Either way the wrapper (tsx CLI) is not the serving process.
    expect(body.pid).not.toBe(child!.pid);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Cluster lifecycle
// ---------------------------------------------------------------------------

const posix = process.platform !== 'win32';
const itThreads = threadsExpected ? it : it.skip;
const itPosix = posix ? it : it.skip;

// Ports of their own, away from the per-worker bands of createTestPort():
// these children outlive a failed assertion only until afterEach, but a
// cluster holds its port with SO_REUSEPORT and must never share one. They
// also stay below the ports the kernel hands to outgoing connections (from
// 32768 on Linux, from 49152 on macOS): one of those, in use by any other
// connection of the test run, cannot be listened on.
const lifecyclePort = () => 20000 + Math.floor(Math.random() * 12000);

interface Lifecycle {
  port: number;
  child: ChildProcess;
  /** Lines the fixture's isolates wrote: '<event> <role>' */
  marks: () => string[];
  /** stdout and stderr so far, colour codes removed */
  output: () => string;
  exit: Promise<number | null>;
  scratch: string;
}

let lifecycle: Lifecycle | null = null;

async function startLifecycle(env: Record<string, string> = {}): Promise<Lifecycle> {
  const scratch = mkdtempSync(join(tmpdir(), 'moro-cluster-'));
  const marksFile = join(scratch, 'marks');
  const port = lifecyclePort();
  let text = '';
  const c = spawn(process.execPath, [lifecycleJs], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      MARKS: marksFile,
      // Job state and the leader lock are written to the temp directory
      TMPDIR: scratch,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: posix,
  });
  child = c;
  c.stdout!.on('data', d => (text += d));
  c.stderr!.on('data', d => (text += d));
  lifecycle = {
    port,
    child: c,
    marks: () => (existsSync(marksFile) ? readFileSync(marksFile, 'utf8').split('\n') : []),
    // eslint-disable-next-line no-control-regex
    output: () => text.replace(/\x1b\[[0-9;]*m/g, ''),
    exit: new Promise(resolve => c.once('exit', code => resolve(code))),
    scratch,
  };
  return lifecycle;
}

const count = (lines: string[], line: string) => lines.filter(l => l === line).length;

async function refused(port: number): Promise<boolean> {
  try {
    await get(port);
    return false;
  } catch {
    return true;
  }
}

describeCluster('cluster lifecycle', () => {
  afterEach(() => {
    if (lifecycle) rmSync(lifecycle.scratch, { recursive: true, force: true });
    lifecycle = null;
  });

  itThreads(
    'SIGTERM stops an idle thread cluster well inside the worker deadline, onClose hooks run in every isolate',
    async () => {
      const app = await startLifecycle();
      await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });
      await waitFor(() => count(app.marks(), 'load worker-thread') === 2, {
        description: 'both workers loaded',
      });
      await new Promise(r => setTimeout(r, 300));

      const started = Date.now();
      app.child.kill('SIGTERM');
      expect(await app.exit).toBe(0);

      // Closed worker threads exit by themselves; none is left for the
      // 3 s deadline to terminate.
      expect(Date.now() - started).toBeLessThan(1500);
      expect(app.output()).not.toMatch(/Shutdown deadline/);
      expect(count(app.marks(), 'onClose worker-thread')).toBe(2);
      expect(count(app.marks(), 'onClose primary')).toBe(1);
    },
    60000
  );

  itThreads(
    'a one-worker thread cluster starts its worker again',
    async () => {
      const app = await startLifecycle({ WORKERS: '1' });
      await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });

      expect((await get(app.port, '/crash')).status).toBe(202);

      // Between the crash and the restart no thread is alive: the primary
      // must still be there when the delay has passed.
      await waitFor(() => count(app.marks(), 'load worker-thread') === 2, {
        timeout: 5000,
        description: 'the worker to be started again',
      });
      await waitFor(serving(app.port), { timeout: 10000, description: 'serving again' });
      expect(app.child.exitCode).toBeNull();
      expect(app.output()).toMatch(/Worker thread \d+ exited \(code 1\)\. Restarting in 200 ms/);
    },
    60000
  );

  itThreads(
    "a { type: 'fatal' } message posted by application code is not the framework's",
    async () => {
      const app = await startLifecycle();
      await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });

      expect((await get(app.port, '/post-fatal')).status).toBe(200);
      await new Promise(r => setTimeout(r, 500));

      expect(app.child.exitCode).toBeNull();
      expect(app.marks().filter(l => l.startsWith('app-error'))).toEqual([]);
      expect(app.output()).not.toMatch(/fatal \(EADDRINUSE\)/);
      expect((await get(app.port)).status).toBe(200);
    },
    60000
  );

  itThreads(
    'after falling back to worker processes, SIGTERM still drains a request in flight',
    async () => {
      const app = await startLifecycle({ FAIL_IN_THREADS: '1' });
      await waitFor(serving(app.port), { timeout: 15000, description: 'first response' });
      expect(app.output()).toMatch(/falling back to worker processes/);
      expect((await get(app.port)).body.isMainThread).toBe(true);

      const slow = get(app.port, '/slow');
      await new Promise(r => setTimeout(r, 100));
      app.child.kill('SIGTERM');

      const { status, body } = await slow;
      expect(status).toBe(200);
      expect(body.slow).toBe(true);
      expect(await app.exit).toBe(0);
    },
    60000
  );

  itPosix(
    'SIGTERM closes worker processes the way it closes everything else: onClose hooks, the request in flight',
    async () => {
      const app = await startLifecycle({ ENGINE: 'node' });
      await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });
      await waitFor(() => count(app.marks(), 'load worker-process') === 2, {
        description: 'both workers loaded',
      });
      await new Promise(r => setTimeout(r, 500));

      const slow = get(app.port, '/slow');
      await new Promise(r => setTimeout(r, 100));
      const started = Date.now();
      app.child.kill('SIGTERM');

      expect((await slow).status).toBe(200);
      expect(await app.exit).toBe(0);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(count(app.marks(), 'onClose worker-process')).toBe(2);
      expect(count(app.marks(), 'onClose primary')).toBe(1);
      expect(app.output()).not.toMatch(/Shutdown deadline/);
    },
    60000
  );

  itPosix(
    'SIGTERM lets a running job finish and releases the leader lock, with workers as processes',
    async () => {
      const app = await startLifecycle({ ENGINE: 'node', JOB: '1' });
      await waitFor(() => app.marks().includes('job-start primary'), {
        timeout: 15000,
        description: 'the job to start',
      });
      await new Promise(r => setTimeout(r, 200));

      app.child.kill('SIGTERM');
      expect(await app.exit).toBe(0);

      const marks = app.marks();
      expect(count(marks, 'job-end primary')).toBe(count(marks, 'job-start primary'));
      expect(readdirSync(app.scratch).filter(name => name.endsWith('.lock'))).toEqual([]);
    },
    60000
  );

  it('a worker process that dies while loading is started again after a growing delay', async () => {
    const app = await startLifecycle({ ENGINE: 'node', CRASH_ON_BOOT: '1' });
    await waitFor(() => count(app.marks(), 'load worker-process') >= 2, {
      timeout: 10000,
      description: 'the first workers',
    });
    await new Promise(r => setTimeout(r, 2500));

    // Two workers, each restarted after 200, 400, 800 ms (then 1600 ms):
    // eight starts in 2.5 s where an immediate re-fork makes dozens.
    const loads = count(app.marks(), 'load worker-process');
    expect(loads).toBeGreaterThanOrEqual(6);
    expect(loads).toBeLessThanOrEqual(10);
    // The primary keeps trying.
    expect(app.child.exitCode).toBeNull();
    expect(app.output()).toMatch(/Restarting in 200 ms/);
    expect(app.output()).toMatch(/Restarting in 800 ms/);
  }, 60000);

  it('a worker process started as a replacement is listened to, and a null message from it is harmless', async () => {
    const app = await startLifecycle({ ENGINE: 'node', WORKERS: '1' });
    await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });
    const first = (await get(app.port)).body.pid;

    // null from the original worker
    expect((await get(app.port, '/send-null')).status).toBe(200);
    await new Promise(r => setTimeout(r, 300));
    expect(app.child.exitCode).toBeNull();

    // ...and from its replacement
    if (posix) process.kill(first, 'SIGKILL');
    else await get(app.port, '/crash').catch(() => null);
    // A connection accepted while no worker is alive may never be answered:
    // each attempt gives up after a second.
    await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${app.port}/`, {
            headers: { connection: 'close' },
            signal: AbortSignal.timeout(1000),
          });
          return ((await res.json()) as any).pid !== first;
        } catch {
          return false;
        }
      },
      { timeout: 15000, description: 'the replacement worker' }
    );
    expect((await get(app.port, '/send-null')).status).toBe(200);
    await new Promise(r => setTimeout(r, 300));
    expect(app.child.exitCode).toBeNull();
    expect((await get(app.port)).status).toBe(200);
  }, 60000);

  itPosix(
    'app.close() in the primary stops the worker processes',
    async () => {
      const app = await startLifecycle({ ENGINE: 'node' });
      await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });
      await waitFor(() => count(app.marks(), 'load worker-process') === 2, {
        description: 'both workers loaded',
      });
      await new Promise(r => setTimeout(r, 500));

      app.child.kill('SIGUSR2');
      await waitFor(() => app.output().includes('PRIMARY_CLOSED'), {
        timeout: 8000,
        description: 'app.close() to resolve',
      });

      // Resolved means stopped: nothing answers on the port any more, and
      // the workers ran their own close().
      expect(await refused(app.port)).toBe(true);
      expect(count(app.marks(), 'onClose worker-process')).toBe(2);
      expect(app.child.exitCode).toBeNull();
    },
    60000
  );

  it('a second listen() is ignored: no second set of workers', async () => {
    const app = await startLifecycle({ ENGINE: 'node', DOUBLE_LISTEN: '1' });
    await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });
    await new Promise(r => setTimeout(r, 1500));

    expect(count(app.marks(), 'load worker-process')).toBe(2);
    expect(count(app.marks(), 'listening-again primary')).toBe(0);
    expect(app.output()).toMatch(/Server is already listening/);
  }, 60000);

  it("says at start-up that performance.clustering.mode: 'proxy' is not applied", async () => {
    const app = await startLifecycle({ ENGINE: 'node', MODE: 'proxy' });
    await waitFor(serving(app.port), { timeout: 10000, description: 'first response' });

    const warnings = app
      .output()
      .split('\n')
      .filter(line => line.includes("performance.clustering.mode: 'proxy' is not applied"));
    expect(warnings).toHaveLength(1);
  }, 60000);
});
