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
import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { engineLoadable } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { createTestPort, waitFor } from '../setup.js';

// ts-jest compiles this suite to CommonJS: __dirname / require.resolve, not
// import.meta (which the transform cannot express).
const fixtureJs = join(__dirname, '..', 'fixtures', 'cluster', 'app.mjs');
const fixtureTs = join(__dirname, '..', 'fixtures', 'cluster', 'app.ts');
const distBuilt = existsSync(join(__dirname, '..', '..', 'dist', 'index.js'));
const tsxCli = require.resolve('tsx/cli');

const caps = engineLoadable ? loadNativeEngine()?.capabilities : undefined;
const threadsExpected = process.platform !== 'win32' && caps?.workerThreads === true;
const reason = !engineLoadable
  ? '@morojs/engine not loadable'
  : !caps?.workerThreads
    ? 'engine build has no workerThreads capability (< 1.2.0)'
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
      if (process.platform === 'linux') expect(threads.size).toBe(2);
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
    const fellBack = /falling back to worker processes/.test(stdout + stderr);
    if (fellBack) {
      expect(body.isMainThread).toBe(true); // a worker process's main thread
    } else {
      expect(body.isMainThread).toBe(false); // a worker thread
      expect(body.threadId).toBeGreaterThan(0);
    }
    // Either way the wrapper (tsx CLI) is not the serving process.
    expect(body.pid).not.toBe(child!.pid);
  }, 60000);
});
