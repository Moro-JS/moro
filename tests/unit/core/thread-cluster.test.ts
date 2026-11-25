// @ts-nocheck
// Unit Tests - worker-thread clustering internals (src/core/cluster/thread-cluster.ts)
// with a fake Worker spawner and fake timers: worker-count math, GC-tuning
// detection, transport resolution, and the primary's sequencing (spawn,
// ready-once, restart backoff, boot/bind failures, health pings, bounded
// shutdown that posts 'shutdown' before it ever terminate()s, the message
// channel that keeps application messages out of the protocol).
import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import {
  ThreadClusterPrimary,
  ClusterWorkerHub,
  ClusterWorkerApp,
  processWorkerInfo,
  type WorkerLink,
  CLUSTER_CHANNEL,
  nextRestartDelay,
  computeWorkerCount,
  usableCpuCount,
  usableMemoryBytes,
  isUserTunedYoungGen,
  resolveClusterTransport,
  threadWorkerInfo,
  WORKER_DATA_KEY,
  YOUNG_GEN_MB_FOR_SEMI_SPACE_4,
} from '../../../src/core/cluster/thread-cluster.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// Like node:worker_threads' Worker, threadId reads -1 from the moment the
// thread has exited, which includes the 'exit' listeners themselves.
class FakeWorker extends EventEmitter {
  static nextId = 1;
  private id = FakeWorker.nextId++;
  exited = false;
  posted: any[] = [];
  terminated = false;
  constructor(
    public entry: string,
    public options: any
  ) {
    super();
  }
  get threadId() {
    return this.exited ? -1 : this.id;
  }
  emit(event: string, ...args: any[]) {
    if (event === 'exit') this.exited = true;
    return super.emit(event, ...args);
  }
  postMessage(m: any) {
    this.posted.push(m);
  }
  async terminate() {
    this.terminated = true;
    this.emit('exit', 1);
    return 1;
  }
  unref() {}
  ref() {}
  // test drivers: what the framework's own worker side posts
  send(body: any) {
    this.emit('message', { channel: CLUSTER_CHANNEL, threadId: this.threadId, ...body });
  }
  ready(port = 3000) {
    this.send({ type: 'ready', port });
  }
  fatal(code: string, message = 'fatal') {
    this.send({ type: 'fatal', code, message });
  }
}

class FakeClock {
  now = 1_000_000;
  timers: Array<{ at: number; fn: () => void; id: number }> = [];
  nextId = 1;
  setTimer = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  };
  clearTimer = (id: number) => {
    this.timers = this.timers.filter(t => t.id !== id);
  };
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.now = due.at;
      this.timers = this.timers.filter(t => t.id !== due.id);
      due.fn();
    }
    this.now = target;
  }
}

function primaryWith(opts: any = {}) {
  const clock = new FakeClock();
  const spawned: FakeWorker[] = [];
  const events: any[] = [];
  const primary = new ThreadClusterPrimary({
    entry: '/app/server.js',
    argv: ['--flag'],
    workerCount: 2,
    logger,
    resourceLimits: { maxYoungGenerationSizeMb: YOUNG_GEN_MB_FOR_SEMI_SPACE_4 },
    spawn: (entry, options) => {
      if (opts.spawnThrows) throw new Error('spawn failed');
      const w = new FakeWorker(entry, options);
      spawned.push(w);
      return w;
    },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onReady: () => events.push('ready'),
    onFatal: (err, kind) => events.push(['fatal', kind, err.message]),
    ...opts,
  });
  return { primary, clock, spawned, events };
}

describe('thread-cluster', () => {
  describe('computeWorkerCount', () => {
    const sys = { cpus: 8, totalMemGB: 64 };
    it('respects a user number', () => {
      expect(computeWorkerCount({ workers: 4 }, sys).count).toBe(4);
    });
    it("'auto' is min(cpus, totalMem / memoryPerWorker)", () => {
      expect(computeWorkerCount({ workers: 'auto' }, sys).count).toBe(8); // (64-4)/8 = 7 GB/worker -> 64/7 = 9 -> capped at 8 cpus
      expect(computeWorkerCount({ workers: 'auto' }, { cpus: 8, totalMemGB: 8 }).count).toBe(8); // 0.5 GB floor -> 16 -> 8
      expect(
        computeWorkerCount({ workers: 'auto', memoryPerWorkerGB: 2 }, { cpus: 8, totalMemGB: 8 })
          .count
      ).toBe(4);
    });
    it('never returns less than 1', () => {
      expect(
        computeWorkerCount({ workers: 'auto', memoryPerWorkerGB: 100 }, { cpus: 4, totalMemGB: 8 })
          .count
      ).toBe(1);
      expect(computeWorkerCount(undefined, { cpus: 1, totalMemGB: 1 }).count).toBe(1);
    });
  });

  describe('usableCpuCount (container-aware)', () => {
    const files = (map: Record<string, string>) => (p: string) => {
      if (p in map) return map[p];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const host = { availableParallelism: () => 96, cpuCount: () => 96 };

    it('prefers the affinity-aware count over os.cpus() (--cpuset-cpus)', () => {
      expect(
        usableCpuCount({ readFile: files({}), availableParallelism: () => 64, cpuCount: () => 96 })
      ).toBe(64);
    });

    it('falls back to os.cpus() when availableParallelism is unavailable', () => {
      expect(
        usableCpuCount({ readFile: files({}), availableParallelism: () => 0, cpuCount: () => 8 })
      ).toBe(8);
      expect(
        usableCpuCount({
          readFile: files({}),
          availableParallelism: () => {
            throw new Error('nope');
          },
          cpuCount: () => 8,
        })
      ).toBe(8);
    });

    it('caps at the cgroup v2 quota (--cpus / k8s limits.cpu)', () => {
      expect(
        usableCpuCount({
          ...host,
          readFile: files({ '/sys/fs/cgroup/cpu.max': '200000 100000\n' }),
        })
      ).toBe(2);
      // fractional quota still means one runnable worker
      expect(
        usableCpuCount({ ...host, readFile: files({ '/sys/fs/cgroup/cpu.max': '50000 100000' }) })
      ).toBe(1);
      // "max" = unlimited
      expect(
        usableCpuCount({ ...host, readFile: files({ '/sys/fs/cgroup/cpu.max': 'max 100000' }) })
      ).toBe(96);
    });

    it('caps at the cgroup v1 cfs quota', () => {
      const v1 = files({
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '400000',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      });
      expect(usableCpuCount({ ...host, readFile: v1 })).toBe(4);
      const unlimited = files({
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
      });
      expect(usableCpuCount({ ...host, readFile: unlimited })).toBe(96);
    });

    it('takes the smaller of quota and affinity, never below 1', () => {
      expect(
        usableCpuCount({
          readFile: files({ '/sys/fs/cgroup/cpu.max': '800000 100000' }),
          availableParallelism: () => 4,
          cpuCount: () => 96,
        })
      ).toBe(4);
      expect(
        usableCpuCount({ readFile: files({}), availableParallelism: () => 0, cpuCount: () => 0 })
      ).toBe(1);
    });
  });

  describe('usableMemoryBytes (container-aware)', () => {
    const GB = 1024 ** 3;
    const files = (map: Record<string, string>) => (p: string) => {
      if (p in map) return map[p];
      throw new Error('ENOENT');
    };

    it('uses the cgroup v2 limit when it is below host RAM', () => {
      expect(
        usableMemoryBytes({
          readFile: files({ '/sys/fs/cgroup/memory.max': `${2 * GB}` }),
          totalmem: () => 64 * GB,
        })
      ).toBe(2 * GB);
    });

    it('ignores "max" and v1 sentinel values and reports host RAM', () => {
      expect(
        usableMemoryBytes({
          readFile: files({ '/sys/fs/cgroup/memory.max': 'max' }),
          totalmem: () => 64 * GB,
        })
      ).toBe(64 * GB);
      expect(
        usableMemoryBytes({
          readFile: files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }),
          totalmem: () => 64 * GB,
        })
      ).toBe(64 * GB);
      expect(usableMemoryBytes({ readFile: files({}), totalmem: () => 16 * GB })).toBe(16 * GB);
    });
  });

  describe('isUserTunedYoungGen', () => {
    it('detects the flag in execArgv or NODE_OPTIONS', () => {
      expect(isUserTunedYoungGen(['--max-semi-space-size=8'], undefined)).toBe(true);
      expect(isUserTunedYoungGen([], '--max-semi-space-size=8')).toBe(true);
      expect(isUserTunedYoungGen(['--import', 'tsx'], '')).toBe(false);
    });
  });

  describe('threadWorkerInfo', () => {
    it('is null on the main thread', () => {
      expect(threadWorkerInfo({ [WORKER_DATA_KEY]: { index: 0, workers: 2 } })).toBeNull();
    });
  });

  describe('resolveClusterTransport', () => {
    const ok = {
      platform: 'linux' as const,
      isMainThread: true,
      argv1: '/app/server.js',
      engineServer: 'engine',
      enginePackage: '@morojs/engine',
      workerThreadsCapable: true,
      fileExists: () => true,
    };
    it('threads when every precondition holds', () => {
      expect(resolveClusterTransport(ok)).toEqual({ kind: 'threads', entry: '/app/server.js' });
    });
    it.each([
      ['win32', { platform: 'win32' as const }],
      ['node engine', { engineServer: 'node' }],
      ['another engine package', { enginePackage: 'not-the-moro-engine' }],
      ['old engine', { workerThreadsCapable: false }],
      ['worker thread', { isMainThread: false }],
      ['no entry', { argv1: undefined }],
      ['missing entry', { fileExists: () => false }],
    ])('processes when %s', (_name, patch) => {
      const t = resolveClusterTransport({ ...ok, ...patch });
      expect(t.kind).toBe('processes');
      expect((t as any).reason).toBeTruthy();
    });
  });

  describe('ThreadClusterPrimary', () => {
    it('spawns N workers with index/workers in workerData and the young-gen limit', () => {
      const { primary, spawned } = primaryWith();
      primary.start();
      expect(spawned).toHaveLength(2);
      expect(spawned[0].entry).toBe('/app/server.js');
      expect(spawned[0].options.workerData).toEqual({
        [WORKER_DATA_KEY]: { index: 0, workers: 2 },
      });
      expect(spawned[1].options.workerData[WORKER_DATA_KEY].index).toBe(1);
      expect(spawned[0].options.resourceLimits).toEqual({ maxYoungGenerationSizeMb: 12 });
      expect(spawned[0].options.argv).toEqual(['--flag']);
      expect(spawned[0].options.execArgv).toBeUndefined();
      expect(spawned[0].options.env).toBeUndefined();
    });

    it('omits resourceLimits when the operator tuned GC', () => {
      const { primary, spawned } = primaryWith({ resourceLimits: undefined });
      primary.start();
      expect(spawned[0].options.resourceLimits).toBeUndefined();
    });

    it('fires onReady exactly once, on the first ready', () => {
      const { primary, spawned, events } = primaryWith();
      primary.start();
      expect(primary.bootPhase).toBe(true);
      spawned[0].ready(3000);
      spawned[1].ready(3000);
      spawned[0].ready(3000);
      expect(events).toEqual(['ready']);
      expect(primary.bootPhase).toBe(false);
      expect(primary.workers.size).toBe(2);
    });

    it('restarts a dead worker with exponential backoff, capped at 5 s', () => {
      const { primary, spawned, clock } = primaryWith();
      primary.start();
      spawned[0].ready();
      spawned[1].ready();
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        const before = spawned.length;
        const victim = spawned[spawned.length - 1];
        const t0 = clock.now;
        victim.emit('exit', 1);
        // find when the respawn fires
        const due = clock.timers.filter(t => t.at > t0).sort((a, b) => a.at - b.at)[0];
        delays.push(due.at - t0);
        clock.advance(due.at - t0);
        expect(spawned.length).toBe(before + 1);
        spawned[spawned.length - 1].ready();
      }
      expect(delays).toEqual([200, 400, 800, 1600, 3200, 5000]);
    });

    it('a bind failure is reported as fatal(bind) and never restarted', () => {
      const { primary, spawned, events, clock } = primaryWith();
      primary.start();
      spawned[0].fatal('EADDRINUSE', 'listen EADDRINUSE');
      spawned[0].emit('exit', 1);
      clock.advance(10_000);
      expect(events).toEqual([['fatal', 'bind', 'listen EADDRINUSE']]);
      expect(spawned).toHaveLength(2); // no respawn
    });

    it("a worker 'error' before any ready is fatal(boot) (the caller falls back to processes)", () => {
      const { primary, spawned, events } = primaryWith();
      primary.start();
      spawned[1].emit('error', new Error('Cannot find module'));
      expect(events).toEqual([['fatal', 'boot', 'Cannot find module']]);
    });

    it('a synchronous spawn failure throws from start()', () => {
      const { primary } = primaryWith({ spawnThrows: true });
      expect(() => primary.start()).toThrow('spawn failed');
    });

    it("shutdown() posts 'shutdown' to every worker before terminating, terminates only stragglers", async () => {
      const { primary, spawned, clock } = primaryWith();
      primary.start();
      spawned[0].ready();
      spawned[1].ready();
      const done = primary.shutdown(1000);
      expect(spawned[0].posted).toEqual([{ channel: CLUSTER_CHANNEL, type: 'shutdown' }]);
      expect(spawned[1].posted).toEqual([{ channel: CLUSTER_CHANNEL, type: 'shutdown' }]);
      spawned[0].emit('exit', 0); // drains in time
      clock.advance(1000); // deadline -> straggler terminated
      await done;
      expect(spawned[0].terminated).toBe(false);
      expect(spawned[1].terminated).toBe(true);
      expect(primary.workers.size).toBe(0);
    });

    it('shutdown() resolves without terminating when every worker drains', async () => {
      const { primary, spawned } = primaryWith();
      primary.start();
      const done = primary.shutdown(1000);
      spawned[0].emit('exit', 0);
      spawned[1].emit('exit', 0);
      await done;
      expect(spawned.every(w => !w.terminated)).toBe(true);
    });

    it('health pings are sent on the interval and missed pongs only warn', () => {
      const warnings: string[] = [];
      const { primary, spawned, clock } = primaryWith({
        logger: { ...logger, warn: (m: string) => warnings.push(m) },
        healthIntervalMs: 1000,
      });
      primary.start();
      spawned[0].ready();
      clock.advance(1000);
      expect(spawned[0].posted.filter(m => m.type === 'ping')).toHaveLength(1);
      clock.advance(3000);
      expect(spawned[0].posted.filter(m => m.type === 'ping')).toHaveLength(4);
      expect(warnings.some(w => /missed 4 health pings/.test(w))).toBe(true);
      expect(spawned[0].terminated).toBe(false);
      spawned[0].send({ type: 'pong', inflight: 0 });
      clock.advance(1000);
      expect(warnings.filter(w => /missed/.test(w))).toHaveLength(1);
    });

    it('forgets a worker that exited and names it in the restart warning', () => {
      const warnings: string[] = [];
      const { primary, spawned, clock } = primaryWith({
        logger: { ...logger, warn: (m: string) => warnings.push(m) },
      });
      primary.start();
      const first = spawned[0].threadId;
      spawned[0].ready();
      spawned[1].ready();
      spawned[0].emit('exit', 1);
      expect(warnings[0]).toContain(`Worker thread ${first} exited (code 1)`);
      expect(primary.workers.size).toBe(1);
      clock.advance(200);
      spawned[2].ready();
      expect(primary.workers.size).toBe(2);
      expect([...primary.workers.values()].every(r => !r.worker.exited)).toBe(true);
    });

    it('reports no missed health pings for a worker that no longer exists', () => {
      const warnings: string[] = [];
      const { primary, spawned, clock } = primaryWith({
        logger: { ...logger, warn: (m: string) => warnings.push(m) },
        healthIntervalMs: 1000,
      });
      primary.start();
      spawned[0].ready();
      spawned[1].ready();
      spawned[0].emit('exit', 1);
      clock.advance(200);
      spawned[2].ready();
      for (let i = 0; i < 10; i++) {
        clock.advance(1000);
        for (const w of spawned) if (!w.exited) w.send({ type: 'pong', inflight: 0 });
      }
      expect(warnings.filter(w => /missed \d+ health pings/.test(w))).toEqual([]);
    });

    it('starts the back-off again at 200 ms for a worker that had been up longer than the restart window', () => {
      const { primary, spawned, clock } = primaryWith();
      primary.start();
      spawned[0].ready();
      spawned[1].ready();
      const delayOfNextRespawn = () => {
        const t0 = clock.now;
        const due = clock.timers
          .filter(t => t.at > t0 && t.at - t0 <= 5000)
          .sort((a, b) => a.at - b.at)[0];
        clock.advance(due.at - t0);
        return due.at - t0;
      };
      spawned[0].emit('exit', 1);
      expect(delayOfNextRespawn()).toBe(200);
      spawned[2].ready();
      spawned[2].emit('exit', 1);
      expect(delayOfNextRespawn()).toBe(400);
      spawned[3].ready();
      clock.advance(2 * 60 * 60 * 1000); // two hours of service
      spawned[3].emit('exit', 1);
      expect(delayOfNextRespawn()).toBe(200);
    });

    it('holds the event loop with a pending restart, and with no other timer', () => {
      const refs: string[] = [];
      const { primary, spawned } = primaryWith({
        workerCount: 1,
        setTimer: (_fn: () => void, ms: number) => ({ ref: () => refs.push(`ref ${ms}`) }),
        clearTimer: () => {},
      });
      primary.start();
      spawned[0].ready();
      // The only worker dies: nothing but the restart timer is left.
      spawned[0].emit('exit', 1);
      expect(refs).toEqual(['ref 200']);
    });

    it('ignores messages that do not carry the cluster channel', () => {
      const { primary, spawned, events } = primaryWith();
      primary.start();
      // What application code or a library may post on the same port
      spawned[0].emit('message', { type: 'ready', threadId: spawned[0].threadId, port: 3000 });
      expect(events).toEqual([]);
      expect(primary.bootPhase).toBe(true);
      spawned[0].emit('message', { type: 'fatal', code: 'EADDRINUSE', message: 'not ours' });
      spawned[0].emit('message', { channel: 'another-library', type: 'fatal', code: 'EADDRINUSE' });
      spawned[0].emit('message', 'fatal');
      spawned[0].emit('message', null);
      expect(events).toEqual([]);
      spawned[0].ready();
      expect(events).toEqual(['ready']);
    });

    it("accepts 'fatal' from a worker only before that worker is ready", () => {
      const errors: string[] = [];
      const { primary, spawned, events, clock } = primaryWith({
        logger: { ...logger, error: (m: string) => errors.push(m) },
      });
      primary.start();
      spawned[0].ready();
      spawned[1].ready();
      spawned[0].fatal('EADDRINUSE', 'sent long after start-up');
      expect(events).toEqual(['ready']);
      expect(errors).toEqual([]);
      // ...and the worker is still supervised: its death is restarted
      spawned[0].emit('exit', 1);
      clock.advance(200);
      expect(spawned).toHaveLength(3);
    });

    it("records 'closed' and says at the deadline which workers had finished closing", async () => {
      const warnings: string[] = [];
      const { primary, spawned, clock } = primaryWith({
        logger: { ...logger, warn: (m: string) => warnings.push(m) },
      });
      primary.start();
      spawned[0].ready();
      spawned[1].ready();
      const done = primary.shutdown(1000);
      spawned[0].send({ type: 'closed' });
      expect([...primary.workers.values()].map(r => r.closed)).toEqual([true, false]);
      clock.advance(1000);
      await done;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('terminating 2 worker thread(s)');
      expect(warnings[0]).toContain('1 had closed and were kept alive by');
      expect(spawned.every(w => w.terminated)).toBe(true);
    });
  });

  describe('ThreadClusterPrimary, several apps on one set of workers', () => {
    const fromPrimary = (w: FakeWorker) => w.posted.filter(m => m.type !== 'ping');

    it('hands every worker the listeners and their worker counts, current at each spawn', () => {
      const listeners: Record<number, number> = { 3000: 2 };
      const { primary, spawned, clock } = primaryWith({ listeners: () => listeners });
      primary.start();
      expect(spawned[0].options.workerData[WORKER_DATA_KEY]).toEqual({
        index: 0,
        workers: 2,
        listeners: { 3000: 2 },
      });

      listeners[3001] = 1;
      spawned[0].ready();
      spawned[0].emit('exit', 1);
      clock.advance(200);
      expect(spawned[2].options.workerData[WORKER_DATA_KEY].listeners).toEqual({
        3000: 2,
        3001: 1,
      });
      // A copy: what the group changes later is not changed under a worker.
      expect(spawned[2].options.workerData[WORKER_DATA_KEY].listeners).not.toBe(listeners);
    });

    it('reports every listener that becomes ready, and onReady still once', () => {
      const seen: Array<[number, number]> = [];
      const { primary, spawned, events } = primaryWith({
        onListening: (port: number, threadId: number) => seen.push([port, threadId]),
      });
      primary.start();
      spawned[0].ready(3000);
      spawned[0].ready(3001);
      spawned[1].ready(3000);
      expect(events).toEqual(['ready']);
      expect(seen).toEqual([
        [3000, spawned[0].threadId],
        [3001, spawned[0].threadId],
        [3000, spawned[1].threadId],
      ]);
      expect(primary.listening(3001)).toBe(true);
      expect(primary.listening(3002)).toBe(false);
    });

    it('grow() adds worker slots and never shrinks', () => {
      const { primary, spawned } = primaryWith();
      primary.start();
      primary.grow(4);
      expect(primary.size).toBe(4);
      expect(spawned.map(w => w.options.workerData[WORKER_DATA_KEY].index)).toEqual([0, 1, 2, 3]);
      expect(spawned[3].options.workerData[WORKER_DATA_KEY].workers).toBe(4);
      primary.grow(2);
      expect(primary.size).toBe(4);
      expect(spawned).toHaveLength(4);
    });

    it('closePort() asks the workers that serve the port and resolves when each has closed it', async () => {
      const { primary, spawned } = primaryWith();
      primary.start();
      spawned[0].ready(3000);
      spawned[0].ready(3001);
      spawned[1].ready(3001);

      let done = false;
      const closing = primary.closePort(3000).then(() => (done = true));
      expect(fromPrimary(spawned[0])).toEqual([
        { channel: CLUSTER_CHANNEL, type: 'close', port: 3000 },
      ]);
      // The second worker never served the port: it is not asked.
      expect(fromPrimary(spawned[1])).toEqual([]);

      spawned[0].send({ type: 'closed', port: 3001 });
      await Promise.resolve();
      expect(done).toBe(false);
      spawned[0].send({ type: 'closed', port: 3000 });
      await closing;
      expect(primary.listening(3000)).toBe(false);
      expect(primary.listening(3001)).toBe(true);
      // Closing one listener is not the worker finishing.
      expect([...primary.workers.values()].every(r => !r.closed)).toBe(true);
    });

    it('closePort() counts a worker that exits as closed, and gives up at the deadline', async () => {
      const { primary, spawned, clock } = primaryWith();
      primary.start();
      spawned[0].ready(3000);
      spawned[1].ready(3000);

      const first = primary.closePort(3000);
      spawned[0].send({ type: 'closed', port: 3000 });
      spawned[1].emit('exit', 1);
      await first;

      clock.advance(200);
      spawned[2].ready(3000);
      let done = false;
      const second = primary.closePort(3000, 500).then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      clock.advance(500);
      await second;
      expect(done).toBe(true);
    });

    it('closePort() resolves at once when no worker serves the port', async () => {
      const { primary } = primaryWith();
      primary.start();
      await primary.closePort(3000);
    });

    it('a worker that reports a closed port ready is told to close it', () => {
      const listeners: Record<number, number> = { 3000: 2, 3001: 1 };
      const { primary, spawned } = primaryWith({ listeners: () => listeners });
      primary.start();
      // Beyond the app's count.
      spawned[1].ready(3001);
      expect(fromPrimary(spawned[1])).toEqual([
        { channel: CLUSTER_CHANNEL, type: 'close', port: 3001 },
      ]);
      // Closed while the worker was starting.
      listeners[3000] = 0;
      spawned[0].ready(3000);
      expect(fromPrimary(spawned[0])).toEqual([
        { channel: CLUSTER_CHANNEL, type: 'close', port: 3000 },
      ]);
      spawned[0].ready(3001);
      expect(fromPrimary(spawned[0])).toHaveLength(1);
    });

    it('openPort() asks the first `count` workers that do not serve the port', () => {
      const { primary, spawned } = primaryWith({ workerCount: 3 });
      primary.start();
      spawned[0].ready(3000);
      spawned[0].ready(3001);
      spawned[1].ready(3000);
      spawned[2].ready(3000);
      primary.openPort(3001, 2);
      expect(fromPrimary(spawned[0])).toEqual([]);
      expect(fromPrimary(spawned[1])).toEqual([
        { channel: CLUSTER_CHANNEL, type: 'open', port: 3001 },
      ]);
      expect(fromPrimary(spawned[2])).toEqual([]);
    });

    it("one app's bind failure in a worker that serves another is reported with its port and the worker is kept", () => {
      const fatals: any[] = [];
      const { primary, spawned, clock } = primaryWith({
        onFatal: (err: any, kind: string) => fatals.push([kind, err.code, err.port]),
      });
      primary.start();
      spawned[0].ready(3000);
      spawned[0].send({ type: 'fatal', code: 'EADDRINUSE', message: 'in use', port: 3001 });
      expect(fatals).toEqual([['bind', 'EADDRINUSE', 3001]]);

      // The listener that is serving has no failed start to report.
      spawned[0].send({ type: 'fatal', code: 'EADDRINUSE', message: 'in use', port: 3000 });
      expect(fatals).toHaveLength(1);

      // The worker goes on being supervised: it is restarted when it dies.
      spawned[0].emit('exit', 1);
      clock.advance(200);
      expect(spawned).toHaveLength(3);
    });
  });

  describe('ClusterWorkerHub (the worker side)', () => {
    function hubWith(info: any = { index: 0, workers: 2 }) {
      const posted: any[] = [];
      let deliver: (m: unknown) => void = () => {};
      let listens = 0;
      let released = 0;
      const link: WorkerLink = {
        id: 7,
        post: m => void posted.push(m),
        listen: fn => {
          listens++;
          deliver = fn;
        },
        release: () => void released++,
      };
      const hub = new ClusterWorkerHub(info, link, logger);
      const say = (body: any) => deliver({ channel: CLUSTER_CHANNEL, ...body });
      const flush = () => new Promise(resolve => setTimeout(resolve, 0));
      const app = (port: number) => {
        const calls: string[] = [];
        const a = new ClusterWorkerApp(hub, port, logger);
        a.active = true;
        a.onClose(async final => {
          calls.push(final ? 'close-final' : 'close');
          await Promise.resolve();
        });
        a.onReopen(() => {
          calls.push('reopen');
          a.active = true;
        });
        return { a, calls };
      };
      const raw = (message: unknown) => deliver(message);
      return { hub, posted, say, raw, flush, app, stats: () => ({ listens, released }) };
    }

    it('every worker serves an app the primary listed for it, and only the first n one configured for n', () => {
      const one = hubWith({ index: 1, workers: 4, listeners: { 3000: 4, 3001: 1 } }).hub;
      expect(one.shouldListen(3000, 4)).toBe(true);
      expect(one.shouldListen(3001, 1)).toBe(false);
      // The primary's count outranks the app's own.
      expect(one.shouldListen(3001, 8)).toBe(false);
      // Not listed (the app joined after this worker started): its own count.
      expect(one.shouldListen(3002, 2)).toBe(true);
      expect(one.shouldListen(3002, 1)).toBe(false);
      // One clustered app, the set its size: every worker.
      expect(
        hubWith({ index: 3, workers: 4, listeners: { 3000: 4 } }).hub.shouldListen(3000, 4)
      ).toBe(true);
    });

    it('answers a ping once for every app, with their requests in flight added up', async () => {
      const { say, posted, app, flush, stats } = hubWith();
      app(3000).a.inflightProvider(() => 2);
      app(3001).a.inflightProvider(() => 3);
      expect(stats().listens).toBe(1);
      say({ type: 'ping' });
      await flush();
      expect(posted).toEqual([
        { channel: CLUSTER_CHANNEL, type: 'pong', threadId: 7, inflight: 5 },
      ]);
    });

    it("ignores messages that are not the cluster's", async () => {
      const { raw, posted, app, flush } = hubWith();
      const one = app(3000);
      raw({ type: 'shutdown' });
      raw({ type: 'close', port: 3000 });
      raw(null);
      raw('shutdown');
      await flush();
      expect(one.calls).toEqual([]);
      expect(posted).toEqual([]);
    });

    it("'shutdown' closes every app for good, then reports and lets go of the channel once", async () => {
      const { say, posted, app, flush, stats } = hubWith();
      const one = app(3000);
      const two = app(3001);
      say({ type: 'shutdown' });
      say({ type: 'shutdown' });
      await flush();
      expect(one.calls).toEqual(['close-final']);
      expect(two.calls).toEqual(['close-final']);
      expect(posted).toEqual([{ channel: CLUSTER_CHANNEL, type: 'closed', threadId: 7 }]);
      expect(stats().released).toBe(1);
    });

    it("'close' closes one app and the worker serves on; 'open' has it listen again", async () => {
      const { hub, say, posted, app, flush, stats } = hubWith();
      const one = app(3000);
      const two = app(3001);
      say({ type: 'close', port: 3000 });
      await flush();
      expect(one.calls).toEqual(['close']);
      expect(two.calls).toEqual([]);
      expect(one.a.active).toBe(false);
      expect(posted).toEqual([
        { channel: CLUSTER_CHANNEL, type: 'closed', threadId: 7, port: 3000 },
      ]);
      expect(stats().released).toBe(0);
      // An app that asks now is told the primary's last word.
      expect(hub.shouldListen(3000, 2)).toBe(false);

      say({ type: 'open', port: 3000 });
      await flush();
      expect(one.calls).toEqual(['close', 'reopen']);
      expect(hub.shouldListen(3000, 2)).toBe(true);
      // Already listening: nothing more to do.
      say({ type: 'open', port: 3000 });
      await flush();
      expect(one.calls).toEqual(['close', 'reopen']);
    });

    it("'open' for an app that has not reached listen() yet is remembered", async () => {
      const { hub, say, app, flush } = hubWith({ index: 1, workers: 2, listeners: { 3001: 0 } });
      app(3000);
      expect(hub.shouldListen(3001, 2)).toBe(false);
      say({ type: 'open', port: 3001 });
      await flush();
      expect(hub.shouldListen(3001, 2)).toBe(true);
    });

    it("a 'shutdown' that arrives while one app is closing waits for it and closes the rest", async () => {
      const { say, posted, app, flush } = hubWith();
      const one = app(3000);
      const two = app(3001);
      say({ type: 'close', port: 3000 });
      say({ type: 'shutdown' });
      await flush();
      expect(one.calls).toEqual(['close']);
      expect(two.calls).toEqual(['close-final']);
      expect(posted.map(m => [m.type, m.port])).toEqual([
        ['closed', 3000],
        ['closed', undefined],
      ]);
    });

    it('an app that failed to start reports it with its port; the worker is done only when no app is left serving', () => {
      const { posted, app, stats } = hubWith();
      const one = app(3000);
      const two = app(3001);
      two.a.fatal('EADDRINUSE', 'could not bind port 3001');
      two.a.close();
      expect(posted).toEqual([
        {
          channel: CLUSTER_CHANNEL,
          type: 'fatal',
          threadId: 7,
          code: 'EADDRINUSE',
          message: 'could not bind port 3001',
          port: 3001,
        },
      ]);
      expect(stats().released).toBe(0);

      one.a.fatal('EACCES', 'no');
      one.a.close();
      expect(posted[posted.length - 1]).toEqual({
        channel: CLUSTER_CHANNEL,
        type: 'closed',
        threadId: 7,
      });
      expect(stats().released).toBe(1);
    });
  });

  describe('processWorkerInfo', () => {
    it('reads what the primary put in the environment of a worker process', () => {
      expect(processWorkerInfo('{"index":2,"workers":4,"listeners":{"3000":4}}')).toEqual({
        index: 2,
        workers: 4,
        listeners: { 3000: 4 },
      });
    });
    it('is null without the mark, or with one that is not ours', () => {
      expect(processWorkerInfo(undefined)).toBeNull();
      expect(processWorkerInfo('')).toBeNull();
      expect(processWorkerInfo('not json')).toBeNull();
      expect(processWorkerInfo('{"workers":4}')).toBeNull();
    });
  });

  describe('nextRestartDelay', () => {
    it('doubles from 200 ms to a ceiling of 5 s and counts the restarts', () => {
      const state = { restarts: 0, lastStart: 0 };
      const delays = [];
      for (let i = 0; i < 7; i++) delays.push(nextRestartDelay(state, 0, 1000 + i));
      expect(delays).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
      expect(state).toEqual({ restarts: 7, lastStart: 1006 });
    });

    it('starts again at 200 ms once a worker has been up for more than 60 s', () => {
      const state = { restarts: 5, lastStart: 1_000_000 };
      expect(nextRestartDelay(state, 59_000, 1_059_500)).toBe(5000);
      expect(nextRestartDelay(state, 61_000, 1_200_000)).toBe(200);
      expect(state.restarts).toBe(1);
    });
  });
});
