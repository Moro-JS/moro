// Integration - several clustered apps in one process share one set of
// workers. Spawns tests/fixtures/cluster/multi.mjs (two clustered apps, 'a'
// and 'b', each on its own port) and observes from outside:
//   - the entry is loaded once per worker, not once per worker per app;
//   - the same workers answer on both ports;
//   - each app is served by the number of workers it was configured for;
//   - closing one app in the primary closes its port in every worker and
//     leaves the other app serving, and the app can listen again;
//   - a signal closes every app in every isolate before the process exits;
//   - the same holds on worker processes (`engine: 'node'`), and an app that
//     can only cluster as processes moves the whole set to processes.
// The fixture loads the BUILT framework (dist/), so `npm run build` must
// have run. MORO_TEST_DIST=<directory> runs it against a build kept
// somewhere else.
import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineLoadable } from './engine-test-utils.js';
import { loadNativeEngine } from '../../src/core/utilities/package-utils.js';
import { waitFor } from '../setup.js';

const fixture = join(__dirname, '..', 'fixtures', 'cluster', 'multi.mjs');
const distBuilt = existsSync(
  join(process.env.MORO_TEST_DIST || join(__dirname, '..', '..', 'dist'), 'index.js')
);
const posix = process.platform !== 'win32';
const caps = engineLoadable ? loadNativeEngine()?.capabilities : undefined;
const threadsExpected = posix && caps?.workerThreads === true;
const describeShared =
  distBuilt || process.env.MORO_REQUIRE_ENGINE === '1' ? describe : describe.skip;
const itThreads = threadsExpected ? it : it.skip;
if (!distBuilt) console.log('cluster-shared-workers: dist/ not built (npm run build)');

// Away from the per-worker bands of createTestPort() and below the ports the
// kernel hands to outgoing connections (see cluster-threads.test.ts).
const freePort = () => 20000 + Math.floor(Math.random() * 12000);

interface Running {
  a: number;
  b: number;
  child: ChildProcess;
  marks: () => string[];
  output: () => string;
  exit: Promise<number | null>;
  say: (command: string) => void;
}

let running: (Running & { scratch: string }) | null = null;

function start(env: Record<string, string> = {}): Running {
  const scratch = mkdtempSync(join(tmpdir(), 'moro-cluster-shared-'));
  const marksFile = join(scratch, 'marks');
  const a = freePort();
  let b = freePort();
  while (b === a) b = freePort();
  let text = '';
  const child = spawn(process.execPath, [fixture], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT_A: String(a),
      PORT_B: String(b),
      MARKS: marksFile,
      TMPDIR: scratch,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: posix,
  });
  child.stdout!.on('data', d => (text += d));
  child.stderr!.on('data', d => (text += d));
  running = {
    a,
    b,
    child,
    marks: () => (existsSync(marksFile) ? readFileSync(marksFile, 'utf8').split('\n') : []),
    // eslint-disable-next-line no-control-regex
    output: () => text.replace(/\x1b\[[0-9;]*m/g, ''),
    exit: new Promise(resolve => child.once('exit', code => resolve(code))),
    say: command => void child.stdin!.write(`${command}\n`),
    scratch,
  };
  return running;
}

afterEach(async () => {
  if (!running) return;
  const { child, scratch } = running;
  running = null;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    try {
      if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await exited;
  }
  rmSync(scratch, { recursive: true, force: true });
});

async function get(port: number, path = '/') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { connection: 'close' } });
  return { status: res.status, body: (await res.json()) as any };
}

const serving = (port: number) => async () => {
  try {
    return (await get(port)).status === 200;
  } catch {
    return false;
  }
};

const refused = async (port: number) => !(await serving(port)());

const count = (lines: string[], line: string) => lines.filter(l => l === line).length;

const said = (app: Running, word: string) => () => app.output().includes(word);

// Who answers on a port: the distinct workers seen over a run of requests,
// each on a connection of its own.
async function answering(port: number, requests = 60): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let i = 0; i < requests; i++) {
    const { body } = await get(port);
    seen.add(`${body.pid}:${body.threadId}`);
  }
  return seen;
}

const readyLines = (app: Running, port: number) =>
  app
    .output()
    .split('\n')
    .filter(line => new RegExp(`Worker thread \\d+ ready on port ${port}\\b`).test(line)).length;

describeShared('several clustered apps in one process', () => {
  itThreads(
    'two apps share one set of worker threads: the entry loads once per worker and both listen callbacks run',
    async () => {
      const app = start({ LOG_LEVEL: 'info' });
      await waitFor(serving(app.a), { timeout: 15000, description: 'app a serving' });
      await waitFor(serving(app.b), { timeout: 15000, description: 'app b serving' });
      await waitFor(() => readyLines(app, app.a) === 2 && readyLines(app, app.b) === 2, {
        timeout: 10000,
        description: 'both apps ready in both workers',
      });
      await new Promise(r => setTimeout(r, 500));

      // Two workers for two apps of two workers each, where each app used to
      // start its own two.
      expect(count(app.marks(), 'load worker-thread')).toBe(2);
      expect(count(app.marks(), 'listening-a primary')).toBe(1);
      expect(count(app.marks(), 'listening-b primary')).toBe(1);

      const a = await get(app.a);
      const b = await get(app.b);
      expect(a.body).toMatchObject({ app: 'a', pid: app.child.pid, isMainThread: false });
      expect(b.body).toMatchObject({ app: 'b', pid: app.child.pid, isMainThread: false });

      // Whoever answers on one port is a worker that answers on the other.
      const onA = await answering(app.a);
      const onB = await answering(app.b);
      const workers = new Set([...onA, ...onB]);
      expect(workers.size).toBeLessThanOrEqual(2);
      expect(app.output()).toMatch(/Clustering: 2 worker threads/);
      expect(app.output()).toMatch(
        new RegExp(`port ${app.b} is served by the process's worker threads \\(2 of 2\\)`)
      );
    },
    60000
  );

  itThreads(
    'each app is served by the number of workers it asked for, and the set is as large as the largest',
    async () => {
      const app = start({ WORKERS_A: '1', WORKERS_B: '3', LOG_LEVEL: 'info' });
      await waitFor(serving(app.a), { timeout: 15000, description: 'app a serving' });
      await waitFor(() => readyLines(app, app.b) === 3, {
        timeout: 15000,
        description: 'app b ready in three workers',
      });
      await new Promise(r => setTimeout(r, 500));

      expect(count(app.marks(), 'load worker-thread')).toBe(3);
      expect(readyLines(app, app.a)).toBe(1);
      expect((await answering(app.a, 30)).size).toBe(1);
    },
    60000
  );

  itThreads(
    'closing one app closes its port in every worker and leaves the other serving; it can listen again',
    async () => {
      const app = start();
      await waitFor(serving(app.a), { timeout: 15000, description: 'app a serving' });
      await waitFor(serving(app.b), { timeout: 15000, description: 'app b serving' });
      await waitFor(() => count(app.marks(), 'load worker-thread') === 2, {
        description: 'both workers loaded',
      });
      await new Promise(r => setTimeout(r, 500));

      app.say('close-a');
      await waitFor(said(app, 'A_CLOSED'), { timeout: 10000, description: 'app a closed' });
      expect(await refused(app.a)).toBe(true);
      expect((await get(app.b)).body.app).toBe('b');
      expect(count(app.marks(), 'onClose-a worker-thread')).toBe(2);
      expect(count(app.marks(), 'onClose-a primary')).toBe(1);
      expect(count(app.marks(), 'onClose-b worker-thread')).toBe(0);
      // The workers were not replaced, and none was terminated.
      expect(count(app.marks(), 'load worker-thread')).toBe(2);
      expect(app.output()).not.toMatch(/still open|Shutdown deadline/);

      app.say('open-a');
      await waitFor(serving(app.a), { timeout: 10000, description: 'app a serving again' });
      await waitFor(() => count(app.marks(), 'listening-a primary') === 2, {
        timeout: 5000,
        description: "app a's listen callback to run again",
      });
      expect((await get(app.a)).body).toMatchObject({ app: 'a', isMainThread: false });
      expect((await get(app.b)).body.app).toBe('b');
      expect(count(app.marks(), 'load worker-thread')).toBe(2);
      expect(app.child.exitCode).toBeNull();
    },
    60000
  );

  itThreads(
    'closing the last app stops the workers',
    async () => {
      const app = start();
      await waitFor(serving(app.a), { timeout: 15000, description: 'app a serving' });
      await waitFor(serving(app.b), { timeout: 15000, description: 'app b serving' });
      await new Promise(r => setTimeout(r, 500));

      app.say('close-a');
      await waitFor(said(app, 'A_CLOSED'), { timeout: 10000, description: 'app a closed' });
      app.say('close-b');
      await waitFor(said(app, 'B_CLOSED'), { timeout: 10000, description: 'app b closed' });

      expect(await refused(app.a)).toBe(true);
      expect(await refused(app.b)).toBe(true);
      expect(count(app.marks(), 'onClose-b worker-thread')).toBe(2);
      expect(app.output()).not.toMatch(/Shutdown deadline/);
    },
    60000
  );

  itThreads(
    'SIGTERM drains a request in flight on each app, closes every app in every isolate and exits 0',
    async () => {
      const app = start();
      await waitFor(serving(app.a), { timeout: 15000, description: 'app a serving' });
      await waitFor(serving(app.b), { timeout: 15000, description: 'app b serving' });
      await waitFor(() => count(app.marks(), 'load worker-thread') === 2, {
        description: 'both workers loaded',
      });
      await new Promise(r => setTimeout(r, 500));

      const slowA = get(app.a, '/slow');
      const slowB = get(app.b, '/slow');
      await new Promise(r => setTimeout(r, 100));
      app.child.kill('SIGTERM');

      expect((await slowA).body).toEqual({ app: 'a', slow: true });
      expect((await slowB).body).toEqual({ app: 'b', slow: true });
      expect(await app.exit).toBe(0);
      expect(app.output()).not.toMatch(/Shutdown deadline/);
      for (const name of ['a', 'b']) {
        expect(count(app.marks(), `onClose-${name} worker-thread`)).toBe(2);
        expect(count(app.marks(), `onClose-${name} primary`)).toBe(1);
      }
    },
    60000
  );

  it('two apps on worker processes share one set of processes, and one closes without the other', async () => {
    const app = start({ ENGINE: 'node' });
    await waitFor(serving(app.a), { timeout: 15000, description: 'app a serving' });
    await waitFor(serving(app.b), { timeout: 15000, description: 'app b serving' });
    await new Promise(r => setTimeout(r, 1500));

    expect(count(app.marks(), 'load worker-process')).toBe(2);
    expect(count(app.marks(), 'listening-a primary')).toBe(1);
    expect(count(app.marks(), 'listening-b primary')).toBe(1);
    const a = await get(app.a);
    expect(a.body).toMatchObject({ app: 'a', isMainThread: true });
    expect(a.body.pid).not.toBe(app.child.pid);

    app.say('close-a');
    await waitFor(said(app, 'A_CLOSED'), { timeout: 10000, description: 'app a closed' });
    expect(await refused(app.a)).toBe(true);
    expect((await get(app.b)).body.app).toBe('b');
    expect(count(app.marks(), 'onClose-a worker-process')).toBe(2);
    expect(count(app.marks(), 'load worker-process')).toBe(2);
    expect(app.output()).not.toMatch(/still open|died unexpectedly/);

    app.child.kill('SIGTERM');
    expect(await app.exit).toBe(0);
    expect(count(app.marks(), 'onClose-b worker-process')).toBe(2);
  }, 60000);

  itThreads(
    'an app that clusters as processes moves the whole set to processes',
    async () => {
      const app = start({ ENGINE_B: 'node' });
      await waitFor(serving(app.a), { timeout: 20000, description: 'app a serving' });
      await waitFor(serving(app.b), { timeout: 20000, description: 'app b serving' });
      await waitFor(() => count(app.marks(), 'load worker-process') === 2, {
        timeout: 10000,
        description: 'the worker processes to load',
      });

      expect(app.output()).toMatch(/falling back to worker processes/);
      expect((await get(app.a)).body).toMatchObject({ app: 'a', isMainThread: true });
      expect((await get(app.b)).body).toMatchObject({ app: 'b', isMainThread: true });
      expect(count(app.marks(), 'listening-a primary')).toBe(1);
      expect(count(app.marks(), 'listening-b primary')).toBe(1);
    },
    60000
  );
});
