// Worker pool: dispatch across threads, task timeouts, worker replacement,
// stats, the decompression output cap, and the JWT task handlers.
//
// No real threads: worker_threads.Worker is replaced with an in-memory fake so
// the manager's bookkeeping (dispatch, timeout, replacement, stats) can be
// driven deterministically.
import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  WorkerManager,
  WORKER_TASKS,
  workerTasks,
  getWorkerManager,
  type WorkerTask,
} from '../../../src/core/workers/worker-manager.js';
import {
  handleDataDecompress,
  handleJSONTransform,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from '../../../src/core/workers/worker.js';
import { isPackageAvailable } from '../../../src/core/utilities/package-utils.js';

// Same module object the manager resolves through requireBuiltin()
const workerThreads = createRequire('file:///')('worker_threads') as { Worker: unknown };
const RealWorker = workerThreads.Worker;

function installFakeWorker(): void {
  FakeWorker.instances = [];
  workerThreads.Worker = FakeWorker;
}

function restoreRealWorker(): void {
  workerThreads.Worker = RealWorker;
}

let nextThreadId = 1;

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];

  threadId = nextThreadId++;
  posted: WorkerTask[] = [];
  terminated = false;
  // Whether the thread keeps the process alive (Worker.ref / Worker.unref)
  refed = true;
  options: Record<string, unknown>;

  constructor(_entry?: unknown, options: Record<string, unknown> = {}) {
    super();
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(task: WorkerTask): void {
    this.posted.push(task);
  }

  terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      // A terminated thread reports threadId -1 and exits with a non-zero code
      this.threadId = -1;
      setImmediate(() => this.emit('exit', 1));
    }
    return Promise.resolve(1);
  }

  complete(taskId: string, data: unknown): void {
    this.emit('message', { taskId, success: true, data, executionTime: 1 });
  }

  ref(): void {
    this.refed = true;
  }

  unref(): void {
    this.refed = false;
  }
}

const live = () => FakeWorker.instances.filter(worker => !worker.terminated);
const tick = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('WorkerManager dispatch', () => {
  let manager: WorkerManager | null = null;

  beforeEach(() => {
    installFakeWorker();
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = null;
    }
    restoreRealWorker();
  });

  const submit = (id: string) =>
    (manager as WorkerManager).executeTask({ id, type: 'crypto:hash', data: {}, timeout: 5000 });

  it('runs one task per worker and queues the rest', async () => {
    manager = new WorkerManager({ workerCount: 3 });
    const workers = [...FakeWorker.instances];

    const pending = ['a', 'b', 'c', 'd', 'e'].map(submit);

    expect(workers.map(worker => worker.posted.map(task => task.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
    expect(manager.getStats()).toMatchObject({
      busyWorkers: 3,
      idleWorkers: 0,
      activeTasks: 5,
      queuedTasks: 2,
    });

    // Whichever worker finishes first takes the next waiting task
    workers[1].complete('b', 'b');
    expect(workers[1].posted.map(task => task.id)).toEqual(['b', 'd']);
    workers[0].complete('a', 'a');
    expect(workers[0].posted.map(task => task.id)).toEqual(['a', 'e']);
    expect(manager.getStats()).toMatchObject({ busyWorkers: 3, queuedTasks: 0 });

    workers[2].complete('c', 'c');
    workers[1].complete('d', 'd');
    workers[0].complete('e', 'e');
    await expect(Promise.all(pending)).resolves.toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(manager.getStats()).toMatchObject({ busyWorkers: 0, idleWorkers: 3, activeTasks: 0 });
  });

  it('gives a new task to an idle worker', async () => {
    manager = new WorkerManager({ workerCount: 2 });
    const [first, second] = FakeWorker.instances;

    const a = submit('a');
    const b = submit('b');
    expect(first.posted.map(task => task.id)).toEqual(['a']);
    expect(second.posted.map(task => task.id)).toEqual(['b']);

    second.complete('b', 'done');
    await b;
    const c = submit('c');
    expect(second.posted.map(task => task.id)).toEqual(['b', 'c']);
    expect(first.posted.map(task => task.id)).toEqual(['a']);

    first.complete('a', 'done');
    second.complete('c', 'done');
    await Promise.all([a, c]);
  });

  it('serves waiting tasks by priority, first in first out within a priority', async () => {
    manager = new WorkerManager({ workerCount: 1 });
    const [only] = FakeWorker.instances;
    const withPriority = (id: string, priority?: 'low' | 'normal' | 'high') =>
      (manager as WorkerManager).executeTask({
        id,
        type: 'crypto:hash',
        data: {},
        timeout: 5000,
        ...(priority ? { priority } : {}),
      });

    const all = [
      withPriority('running'),
      withPriority('low-1', 'low'),
      withPriority('normal-1'),
      withPriority('high-1', 'high'),
      withPriority('normal-2', 'normal'),
      withPriority('high-2', 'high'),
      withPriority('low-2', 'low'),
    ];

    const order: string[] = [];
    for (let i = 0; i < all.length; i++) {
      const current = only.posted[i] as WorkerTask;
      order.push(current.id);
      only.complete(current.id, current.id);
    }
    await Promise.all(all);

    expect(order).toEqual([
      'running',
      'high-1',
      'high-2',
      'normal-1',
      'normal-2',
      'low-1',
      'low-2',
    ]);
  });

  it('rejects new tasks once maxQueueSize tasks are waiting', async () => {
    manager = new WorkerManager({ workerCount: 1, maxQueueSize: 2 });
    const [only] = FakeWorker.instances;

    const running = submit('running');
    const waiting = [submit('w1'), submit('w2')];
    await expect(submit('overflow')).rejects.toThrow('Worker queue is full');
    expect(manager.getStats()).toMatchObject({ activeTasks: 3, queuedTasks: 2 });

    // Room appears as soon as a waiting task is dispatched
    only.complete('running', 'done');
    await running;
    const late = submit('late');
    expect(manager.getStats()).toMatchObject({ queuedTasks: 2 });

    for (const id of ['w1', 'w2', 'late']) only.complete(id, id);
    await expect(Promise.all([...waiting, late])).resolves.toEqual(['w1', 'w2', 'late']);
  });

  it('does not count running tasks against maxQueueSize', async () => {
    manager = new WorkerManager({ workerCount: 3, maxQueueSize: 1 });
    const workers = [...FakeWorker.instances];

    const pending = ['a', 'b', 'c', 'd'].map(submit);
    expect(manager.getStats()).toMatchObject({ busyWorkers: 3, queuedTasks: 1 });

    workers[0].complete('a', 'a');
    workers[1].complete('b', 'b');
    workers[2].complete('c', 'c');
    workers[0].complete('d', 'd');
    await expect(Promise.all(pending)).resolves.toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops a task that times out while waiting, without stopping a worker', async () => {
    manager = new WorkerManager({ workerCount: 1 });
    const [only] = FakeWorker.instances;

    const running = submit('running');
    const impatient = manager.executeTask({
      id: 'impatient',
      type: 'crypto:hash',
      data: {},
      timeout: 20,
    });
    await expect(impatient).rejects.toThrow('Task impatient timed out');

    expect(only.terminated).toBe(false);
    expect(manager.getStats()).toMatchObject({ workerCount: 1, queuedTasks: 0, activeTasks: 1 });

    only.complete('running', 'done');
    await expect(running).resolves.toBe('done');
    expect(only.posted.map(task => task.id)).toEqual(['running']);
  });

  it('uses the replacement worker after a crash', async () => {
    manager = new WorkerManager({ workerCount: 2, restartBackoffMs: 1 });
    const [first, second] = FakeWorker.instances;

    const a = submit('a');
    const b = submit('b');
    first.terminated = true;
    first.emit('exit', 1);
    await expect(a).rejects.toThrow('Worker thread failed');
    await tick();

    const replacement = live().find(worker => worker !== second) as FakeWorker;
    expect(replacement).toBeDefined();
    const c = submit('c');
    expect(replacement.posted.map(task => task.id)).toEqual(['c']);

    second.complete('b', 'done');
    replacement.complete('c', 'done');
    await Promise.all([b, c]);
  });
});

describe('WorkerManager task timeouts', () => {
  let manager: WorkerManager | null = null;

  beforeEach(() => {
    installFakeWorker();
  });

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = null;
    }
    restoreRealWorker();
  });

  it('terminates and replaces the worker, rejecting only the timed-out task', async () => {
    manager = new WorkerManager({ workerCount: 1 });
    const [first] = FakeWorker.instances;

    const slow = manager.executeTask({
      id: 'slow',
      type: 'computation:heavy',
      data: {},
      timeout: 30,
    });
    const quick = manager.executeTask({
      id: 'quick',
      type: 'crypto:hash',
      data: {},
      timeout: 5000,
    });
    // The second task waits its turn; it is not sent to the busy worker
    expect(first.posted.map(task => task.id)).toEqual(['slow']);

    await expect(slow).rejects.toThrow('Task slow timed out');

    // The stuck thread is stopped and a replacement took its place
    expect(first.terminated).toBe(true);
    expect(live()).toHaveLength(1);
    const replacement = live()[0];
    expect(replacement).not.toBe(first);
    expect(manager.getStats().workerCount).toBe(1);

    // The task that was waiting behind the stuck one is served by the replacement
    expect(replacement.posted.map(task => task.id)).toEqual(['quick']);
    replacement.complete('quick', 'hash-result');
    await expect(quick).resolves.toBe('hash-result');

    // And the pool keeps serving new work
    const later = manager.executeTask({
      id: 'later',
      type: 'crypto:hash',
      data: {},
      timeout: 5000,
    });
    expect(replacement.posted.map(task => task.id)).toEqual(['quick', 'later']);
    replacement.complete('later', 'ok');
    await expect(later).resolves.toBe('ok');
  });

  it('does not treat the terminated worker exit as a crash', async () => {
    manager = new WorkerManager({ workerCount: 1, maxRestartAttempts: 1, restartBackoffMs: 1 });

    // More consecutive timeouts than the crash-restart budget allows
    for (let i = 0; i < 4; i++) {
      await expect(
        manager.executeTask({ id: `slow-${i}`, type: 'computation:heavy', data: {}, timeout: 10 })
      ).rejects.toThrow('timed out');
      await tick(); // let the fake 'exit' event fire
    }

    // Exactly one replacement per timeout, and the pool is still available
    expect(FakeWorker.instances).toHaveLength(5);
    expect(live()).toHaveLength(1);
    const probe = manager.executeTask({
      id: 'probe',
      type: 'crypto:hash',
      data: {},
      timeout: 5000,
    });
    live()[0].complete('probe', 'alive');
    await expect(probe).resolves.toBe('alive');
  });

  it('reports busy workers as busy', async () => {
    manager = new WorkerManager({ workerCount: 2 });
    expect(manager.getStats()).toMatchObject({ workerCount: 2, busyWorkers: 0, idleWorkers: 2 });

    const pending = manager.executeTask({ id: 'a', type: 'crypto:hash', data: {}, timeout: 5000 });
    expect(manager.getStats()).toMatchObject({
      workerCount: 2,
      busyWorkers: 1,
      idleWorkers: 1,
      activeTasks: 1,
    });

    const owner = FakeWorker.instances.find(worker => worker.posted.length === 1);
    owner?.complete('a', 'done');
    await pending;
    expect(manager.getStats()).toMatchObject({ busyWorkers: 0, idleWorkers: 2, activeTasks: 0 });
  });

  it('does not leave a pinned worker hidden from stats after a timeout', async () => {
    manager = new WorkerManager({ workerCount: 2 });

    const tasks = [0, 1, 2].map(i =>
      manager!.executeTask({ id: `slow-${i}`, type: 'computation:heavy', data: {}, timeout: 20 })
    );
    const results = await Promise.allSettled(tasks);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    await tick();

    // Every worker that ran a timed-out task was stopped; nothing is silently busy
    expect(live()).toHaveLength(2);
    expect(live().every(worker => worker.posted.length === 0)).toBe(true);
    expect(manager.getStats()).toMatchObject({
      workerCount: 2,
      busyWorkers: 0,
      idleWorkers: 2,
      activeTasks: 0,
      queuedTasks: 0,
    });
  });

  it('removes a crashed worker even when only "exit" fires (threadId already -1)', async () => {
    manager = new WorkerManager({ workerCount: 2, restartBackoffMs: 1 });
    const [first] = FakeWorker.instances;

    first.threadId = -1;
    first.terminated = true;
    first.emit('exit', 1);

    expect(manager.getStats().workerCount).toBe(1);
    await tick();
    expect(manager.getStats().workerCount).toBe(2);
  });
});

describe('worker decompress output cap', () => {
  const payload = Buffer.alloc(256 * 1024, 'a');

  it('defaults to 256 MiB', () => {
    expect(DEFAULT_MAX_DECOMPRESSED_BYTES).toBe(256 * 1024 * 1024);
  });

  it.each([
    ['gzip', zlib.gzipSync(payload)],
    ['deflate', zlib.deflateSync(payload)],
    ['brotli', zlib.brotliCompressSync(payload)],
  ] as const)('rejects %s output larger than maxOutputLength', async (format, compressed) => {
    await expect(
      handleDataDecompress({ input: compressed, format, maxOutputLength: 1024 })
    ).rejects.toThrow('Decompressed data exceeds the 1024 byte limit (maxOutputLength)');

    // At or under the cap is unaffected
    const exact = await handleDataDecompress({
      input: compressed,
      format,
      maxOutputLength: payload.length,
    });
    expect(exact.equals(payload)).toBe(true);

    const byDefault = await handleDataDecompress({ input: compressed, format });
    expect(byDefault.equals(payload)).toBe(true);
  });

  it('still reports corrupt input with the zlib error', async () => {
    await expect(handleDataDecompress({ input: Buffer.from('not gzip') })).rejects.toThrow(
      /incorrect header check/
    );
  });

  it('workerTasks.decompress forwards maxOutputLength to the worker task', async () => {
    installFakeWorker();
    try {
      const compressed = zlib.gzipSync(payload);

      const capped = workerTasks.decompress(compressed, { maxOutputLength: 4096 });
      const plain = workerTasks.decompress(compressed);

      const posted = FakeWorker.instances.flatMap(worker => worker.posted);
      expect(posted).toHaveLength(2);
      expect(posted[0].type).toBe(WORKER_TASKS.DATA_DECOMPRESS);
      expect(posted[0].data).toMatchObject({ format: 'gzip', maxOutputLength: 4096 });
      expect(posted[1].data).toEqual({ input: compressed, format: 'gzip' });

      for (const worker of FakeWorker.instances) {
        for (const task of worker.posted) worker.complete(task.id, payload);
      }
      expect((await capped).equals(payload)).toBe(true);
      expect((await plain).equals(payload)).toBe(true);
    } finally {
      await getWorkerManager().shutdown();
      restoreRealWorker();
    }
  });
});

describe('worker resourceLimits', () => {
  afterEach(() => {
    restoreRealWorker();
  });

  it('are passed to every worker thread, replacements included', async () => {
    installFakeWorker();
    const resourceLimits = { maxOldGenerationSizeMb: 256, stackSizeMb: 8 };
    const manager = new WorkerManager({ workerCount: 2, restartBackoffMs: 1, resourceLimits });
    try {
      expect(FakeWorker.instances).toHaveLength(2);
      for (const worker of FakeWorker.instances) {
        expect(worker.options.resourceLimits).toEqual(resourceLimits);
      }

      // A worker that Node ends at its limit is replaced with the same limits
      const failing = manager.executeTask({ id: 'big', type: 'crypto:hash', data: {} });
      const first = FakeWorker.instances.find(worker => worker.posted.length === 1) as FakeWorker;
      first.emit('error', new Error('Worker terminated due to reaching memory limit'));
      await expect(failing).rejects.toThrow();
      await tick(30);

      expect(FakeWorker.instances).toHaveLength(3);
      expect(FakeWorker.instances[2].options.resourceLimits).toEqual(resourceLimits);
    } finally {
      await manager.shutdown();
    }

    // Nothing is passed unless it was configured
    const unlimited = new WorkerManager({ workerCount: 1 });
    try {
      expect(FakeWorker.instances[3].options).toEqual({ workerData: { type: 'worker' } });
    } finally {
      await unlimited.shutdown();
    }
  });

  it('reach a pool created from the options an app was configured with', async () => {
    installFakeWorker();
    jest.resetModules();
    const fresh = await import('../../../src/core/workers/worker-manager.js');
    try {
      fresh.setConfiguredWorkerPoolOptions({
        workerCount: 1,
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      fresh.getWorkerManager();
      expect(FakeWorker.instances[0].options.resourceLimits).toEqual({
        maxOldGenerationSizeMb: 128,
      });
    } finally {
      await fresh.getWorkerManager().shutdown();
    }
  });
});

// isolated-vm is not a dependency of this repo, which is the case under test:
// the transformer is function text, and without the isolate it is never run.
(isPackageAvailable('isolated-vm') ? describe.skip : describe)(
  'transformJSON without isolated-vm',
  () => {
    afterEach(() => {
      restoreRealWorker();
      delete (globalThis as Record<string, unknown>).__transformerRan;
    });

    it('is rejected at once, naming the package, without a worker thread', async () => {
      installFakeWorker();
      jest.resetModules();
      const fresh = await import('../../../src/core/workers/worker-manager.js');
      try {
        const outcome = await Promise.race([
          fresh.workerTasks
            .transformJSON([1, 2], (rows: number[]) => rows.map(n => n * 2))
            .then(
              () => 'resolved',
              (error: Error) => error.message
            ),
          tick(100).then(() => 'still pending'),
        ]);

        expect(outcome).toContain('requires the "isolated-vm" package');
        expect(outcome).toContain('npm install isolated-vm');
        expect(FakeWorker.instances).toHaveLength(0);
      } finally {
        await fresh.getWorkerManager({ workerCount: 1 }).shutdown();
      }
    });

    it('is refused by the worker too, and the transformer text is not run', async () => {
      await expect(
        handleJSONTransform({
          data: [1, 2],
          transformer: 'rows => { globalThis.__transformerRan = true; return rows; }',
        })
      ).rejects.toThrow('transformJSON requires the "isolated-vm" package');
      expect((globalThis as Record<string, unknown>).__transformerRan).toBeUndefined();
    });
  }
);

describe('pool options from createApp({ workers })', () => {
  it('apply to a pool that a bare getWorkerManager() creates first', async () => {
    installFakeWorker();
    // A fresh copy of the module: the pool is a per-process singleton
    jest.resetModules();
    const fresh = await import('../../../src/core/workers/worker-manager.js');
    try {
      fresh.setConfiguredWorkerPoolOptions({ workerCount: 2, maxQueueSize: 1 });

      // What app code does right after createApp(), before the app's own
      // background initialisation has run
      const manager = fresh.getWorkerManager();
      expect(manager.getStats().workerCount).toBe(2);
      // The first pool of a process keeps it alive until it is shut down
      expect(live().map(worker => worker.refed)).toEqual([true, true]);

      const tasks = ['a', 'b', 'c'].map(id =>
        manager.executeTask({ id, type: 'crypto:hash', data: {}, timeout: 5000 })
      );
      await expect(
        manager.executeTask({ id: 'overflow', type: 'crypto:hash', data: {}, timeout: 5000 })
      ).rejects.toThrow('Worker queue is full');
      void Promise.allSettled(tasks);

      // The app's own initialisation then finds the same pool
      expect(fresh.getWorkerManager({ workerCount: 2, maxQueueSize: 1 })).toBe(manager);
    } finally {
      await fresh.getWorkerManager().shutdown();
      restoreRealWorker();
    }
  });
});

describe('the shared pool and the apps that use it', () => {
  let fresh: typeof import('../../../src/core/workers/worker-manager.js');

  beforeAll(async () => {
    // A copy of the module of its own: the pool is a per-process singleton
    jest.resetModules();
    fresh = await import('../../../src/core/workers/worker-manager.js');
  });

  beforeEach(() => {
    installFakeWorker();
  });

  afterEach(async () => {
    // Asking for the pool here would start another one
    for (const pool of pools.splice(0)) await pool.shutdown();
    restoreRealWorker();
  });

  const pools: WorkerManager[] = [];
  const pool = (workerCount: number) => {
    const manager = fresh.getWorkerManager({ workerCount });
    if (!pools.includes(manager)) pools.push(manager);
    return manager;
  };
  const hash = (id: string): WorkerTask => ({ id, type: 'crypto:hash', data: {}, timeout: 5000 });
  const running = () => live().find(worker => worker.posted.length > 0) as FakeWorker;

  it('is started again, once shut down, for whoever asks next, and runs their tasks', async () => {
    const first = pool(1);
    await first.shutdown();
    await expect(first.executeTask(hash('late'))).rejects.toThrow('shutting down');

    const second = pool(2);
    expect(second).not.toBe(first);
    expect(second.getStats()).toMatchObject({ workerCount: 2, isShuttingDown: false });

    // executeOnWorker() and the task helpers find the new pool as well
    const result = fresh.executeOnWorker(hash('again'));
    running().complete('again', 'hashed');
    await expect(result).resolves.toBe('hashed');
    expect(fresh.getWorkerManager()).toBe(second);
  });

  it('started again, does not hold the process open until an app takes it, except while it runs a task', async () => {
    await pool(2).shutdown();

    // Asked for by code that no app stands behind
    const stray = pool(2);
    expect(live().map(worker => worker.refed)).toEqual([false, false]);

    const task = stray.executeTask(hash('one'));
    const busy = running();
    expect(busy.refed).toBe(true);
    expect(live().filter(worker => worker.refed)).toEqual([busy]);
    busy.complete('one', 'done');
    await expect(task).resolves.toBe('done');
    expect(live().map(worker => worker.refed)).toEqual([false, false]);

    // An app's facade takes the pool over: it is that app's pool from here
    // on, kept alive like a first pool and shut down when the app closes
    const { WorkerThreadsFacade } = await import('../../../src/core/workers/facade.js');
    const facade = new WorkerThreadsFacade();
    await facade.ensureInitialized();
    expect(live().map(worker => worker.refed)).toEqual([true, true]);
    expect((await facade.getStats())?.workerCount).toBe(2);

    await facade.shutdown();
    expect(stray.getStats().isShuttingDown).toBe(true);
  });

  it('is shut down by an app that was used, or closed, while it was still setting the pool up', async () => {
    const { WorkerThreadsFacade } = await import('../../../src/core/workers/facade.js');
    const poolOf = (facade: unknown) => (facade as { workerManager: WorkerManager }).workerManager;

    // An app sets its pool up in the background; a first use right behind
    // createApp() arrives before that has finished
    const used = new WorkerThreadsFacade();
    await Promise.all([used.ensureInitialized({ workerCount: 1 }), used.ensureInitialized()]);
    pools.push(poolOf(used));
    expect(poolOf(used).getStats()).toMatchObject({ workerCount: 1, isShuttingDown: false });
    await used.shutdown();
    expect(poolOf(used).getStats().isShuttingDown).toBe(true);

    // Closed before the set-up has finished
    const closedEarly = new WorkerThreadsFacade();
    const settingUp = closedEarly.ensureInitialized({ workerCount: 1 });
    await closedEarly.shutdown();
    await settingUp;
    pools.push(poolOf(closedEarly));
    expect(poolOf(closedEarly)).not.toBe(poolOf(used));
    expect(poolOf(closedEarly).getStats().isShuttingDown).toBe(true);
  });
});

// `jsonwebtoken` is not a dependency of this repo, so the handlers are pointed
// at small stand-in modules with its shape: HMAC sign/verify, the `algorithms`
// allow-list (any HS* when none is given, as jsonwebtoken does for a string
// secret) and its error messages. Like jsonwebtoken 8 they take whatever
// string they are given as the HMAC secret, a PEM public key included.
describe('worker JWT tasks', () => {
  const SECRET = 'worker-jwt-test-secret';
  const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

  function token(payload: Record<string, unknown>, secret: string, alg = 'HS256'): string {
    const head = `${b64url(JSON.stringify({ alg, typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
    const hash = alg === 'HS512' ? 'sha512' : 'sha256';
    return `${head}.${crypto.createHmac(hash, secret).update(head).digest('base64url')}`;
  }

  const JWT_SOURCE = `
const crypto = require('crypto');
const HASH = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
const calls = [];
function fail(name, message) {
  const error = new Error(message);
  error.name = name;
  throw error;
}
function mac(alg, secret, head) {
  return crypto.createHmac(HASH[alg], secret).update(head).digest('base64url');
}
function sign(payload, secret, options) {
  const alg = (options && options.algorithm) || 'HS256';
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg, typ: 'JWT' }) + '.' + b64(payload);
  return head + '.' + mac(alg, secret, head);
}
function verify(token, secret, options) {
  calls.push(options);
  const parts = String(token).split('.');
  if (parts.length !== 3) fail('JsonWebTokenError', 'jwt malformed');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const allowed = (options && options.algorithms) || Object.keys(HASH);
  if (!allowed.includes(header.alg) || !HASH[header.alg]) {
    fail('JsonWebTokenError', 'invalid algorithm');
  }
  if (mac(header.alg, secret, parts[0] + '.' + parts[1]) !== parts[2]) {
    fail('JsonWebTokenError', 'invalid signature');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) {
    fail('TokenExpiredError', 'jwt expired');
  }
  return payload;
}
`;

  let dir: string;
  let defaultOnly: string;
  let namedExports: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moro-worker-jwt-'));
    // What `await import('jsonwebtoken')` evaluates to under ESM: the module
    // is CommonJS, so its functions are reachable only through `default`
    defaultOnly = path.join(dir, 'default-only.js');
    fs.writeFileSync(
      defaultOnly,
      `${JWT_SOURCE}
       Object.defineProperty(exports, '__esModule', { value: true });
       exports.default = { sign, verify, calls };`
    );
    // What a CommonJS build gets from require('jsonwebtoken')
    namedExports = path.join(dir, 'named-exports.js');
    fs.writeFileSync(namedExports, `${JWT_SOURCE}\nmodule.exports = { sign, verify, calls };`);
  });

  afterEach(() => {
    jest.dontMock('../../../src/core/utilities/package-utils.js');
    jest.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh copy of the worker module that finds `standIn` as jsonwebtoken. */
  async function loadWorker(standIn: string) {
    jest.resetModules();
    jest.doMock('../../../src/core/utilities/package-utils.js', () => {
      const actual = jest.requireActual('../../../src/core/utilities/package-utils.js') as Record<
        string,
        (name: string) => unknown
      >;
      return {
        ...actual,
        isPackageAvailable: (name: string) =>
          name === 'jsonwebtoken' || actual.isPackageAvailable(name),
        resolveUserPackage: (name: string) =>
          name === 'jsonwebtoken' ? standIn : actual.resolveUserPackage(name),
      };
    });
    return import('../../../src/core/workers/worker.js');
  }

  const lastVerifyOptions = async (standIn: string) => {
    const loaded = await import(standIn);
    const calls = (loaded.default ?? loaded).calls as unknown[];
    return calls[calls.length - 1];
  };

  it.each([
    ['only on its default export (real ESM)', () => defaultOnly],
    ['as named exports (CommonJS build)', () => namedExports],
  ])('signs and verifies when the package exposes its functions %s', async (_label, standIn) => {
    const worker = await loadWorker(standIn());

    const signed = await worker.handleJWTSign({
      payload: { sub: 'user-1', role: 'admin' },
      secret: SECRET,
    });
    expect(signed.split('.')).toHaveLength(3);

    await expect(worker.handleJWTVerify({ token: signed, secret: SECRET })).resolves.toEqual({
      sub: 'user-1',
      role: 'admin',
    });
    await expect(
      worker.handleJWTVerify({ token: token({ sub: 'user-1' }, 'another-secret'), secret: SECRET })
    ).rejects.toThrow('invalid signature');
    await expect(
      worker.handleJWTVerify({
        token: token({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET),
        secret: SECRET,
      })
    ).rejects.toThrow('jwt expired');
  });

  it('verifies with HS256 only unless the caller names the algorithms', async () => {
    const worker = await loadWorker(defaultOnly);
    const hs512 = token({ sub: 'user-1' }, SECRET, 'HS512');

    await expect(worker.handleJWTVerify({ token: hs512, secret: SECRET })).rejects.toThrow(
      'invalid algorithm'
    );
    await expect(
      worker.handleJWTVerify({ token: hs512, secret: SECRET, options: {} })
    ).rejects.toThrow('invalid algorithm');
    await expect(
      worker.handleJWTVerify({ token: hs512, secret: SECRET, options: { algorithms: undefined } })
    ).rejects.toThrow('invalid algorithm');

    await expect(
      worker.handleJWTVerify({ token: hs512, secret: SECRET, options: { algorithms: ['HS512'] } })
    ).resolves.toEqual({ sub: 'user-1' });
    expect(await lastVerifyOptions(defaultOnly)).toEqual({ algorithms: ['HS512'] });
  });

  it('keeps the other verify options next to the default algorithm', async () => {
    const worker = await loadWorker(defaultOnly);

    await worker.handleJWTVerify({
      token: token({ sub: 'user-1' }, SECRET),
      secret: SECRET,
      options: { audience: 'my-app', clockTolerance: 5 },
    });

    expect(await lastVerifyOptions(defaultOnly)).toEqual({
      audience: 'my-app',
      clockTolerance: 5,
      algorithms: ['HS256'],
    });
  });

  it('does not use a PEM public key as the HS256 secret', async () => {
    const worker = await loadWorker(defaultOnly);
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pems = [
      publicKey.export({ type: 'spki', format: 'pem' }) as string,
      publicKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    ];

    for (const pem of pems) {
      // Anyone who has the public key can produce this token
      const forged = token({ sub: 'admin' }, pem);

      await expect(worker.handleJWTVerify({ token: forged, secret: pem })).rejects.toThrow(
        'JWT verification with a public key requires options.algorithms'
      );
      // With the algorithms named, the decision is the package's
      await expect(
        worker.handleJWTVerify({ token: forged, secret: pem, options: { algorithms: ['RS256'] } })
      ).rejects.toThrow('invalid algorithm');
    }
    expect(await lastVerifyOptions(defaultOnly)).toEqual({ algorithms: ['RS256'] });
  });
});
