// @ts-nocheck
// Unit Tests - worker-thread clustering internals (src/core/cluster/thread-cluster.ts)
// with a fake Worker spawner and fake timers: worker-count math, GC-tuning
// detection, transport resolution, and the primary's sequencing (spawn,
// ready-once, restart backoff, boot/bind failures, health pings, bounded
// shutdown that posts 'shutdown' before it ever terminate()s).
import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import {
  ThreadClusterPrimary,
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

class FakeWorker extends EventEmitter {
  static nextId = 1;
  threadId = FakeWorker.nextId++;
  posted: any[] = [];
  terminated = false;
  constructor(
    public entry: string,
    public options: any
  ) {
    super();
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
  // test drivers
  ready(port = 3000) {
    this.emit('message', { type: 'ready', threadId: this.threadId, port });
  }
  fatal(code: string, message = 'fatal') {
    this.emit('message', { type: 'fatal', threadId: this.threadId, code, message });
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
      ['uWS engine', { enginePackage: 'uWebSockets.js' }],
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
      expect(spawned[0].posted).toEqual([{ type: 'shutdown' }]);
      expect(spawned[1].posted).toEqual([{ type: 'shutdown' }]);
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
      spawned[0].emit('message', { type: 'pong', threadId: spawned[0].threadId, inflight: 0 });
      clock.advance(1000);
      expect(warnings.filter(w => /missed/.test(w))).toHaveLength(1);
    });
  });
});
