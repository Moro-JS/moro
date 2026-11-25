// Worker-thread clustering for the native engine backend.
//
// `performance.clustering` keeps its keys; what changes is the transport
// underneath: on POSIX, with @morojs/engine >= 1.1.6 (capabilities.workerThreads),
// the workers are worker_threads inside ONE process, each binding the port
// with SO_REUSEPORT exactly as the process workers did. Everything that
// cannot be a thread stays on node:cluster automatically - Windows (no
// SO_REUSEPORT), the Node.js server, an older engine, a REPL/eval entry,
// or a worker thread that fails to boot (see resolveClusterTransport and the
// boot-phase fallback in Moro.startThreadPrimary).
//
// Why threads: one process shares the node binary, the addon and the code
// pages, so per-worker RSS drops; there is one pid to supervise; and a
// worker crash is an 'error'/'exit' event on the primary instead of a
// process death. The trade-off (stated in the release notes): a NATIVE crash
// in one thread takes the whole process down, where processes isolate.
//
// One set of workers per process: every clustered app of the process joins it
// (core/cluster/cluster-group.ts), so a second app adds a listener to each
// worker and not a second set of workers. A worker therefore hosts several
// apps, and the protocol below names the listener (its port) where one app
// alone is meant.
//
// This module is internal (not exported from src/index.ts). Everything here
// is dependency-injectable so the sequencing (spawn, restart backoff, health
// pings, bounded shutdown) is unit-tested with a fake Worker and fake timers.
import { requireBuiltin } from '../utilities/builtin.js';
import { existsSync, readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import type { WorkerOptions } from 'node:worker_threads';

// Loaded on first use (core/utilities/builtin.ts): an app that never clusters
// never pays for worker_threads or os.
const wt = () => requireBuiltin<typeof import('worker_threads')>('worker_threads');
const os = () => requireBuiltin<typeof import('os')>('os');

/** Key under workerData that marks a Moro cluster worker thread. */
export const WORKER_DATA_KEY = 'moroCluster';

/**
 * The process path pins each worker's V8 young generation with
 * `--max-semi-space-size=4` (A/B-benched 2026-08-01: throughput parity,
 * ~30 MB RSS per worker saved). Worker threads reject V8 flags in execArgv;
 * the equivalent knob is resourceLimits.maxYoungGenerationSizeMb, and V8
 * sizes the young generation at 3x the semi-space: 4 MB semi-space == 12 MB.
 */
export const YOUNG_GEN_MB_FOR_SEMI_SPACE_4 = 12;

export interface ThreadWorkerInfo {
  index: number;
  workers: number;
  /** Port -> how many workers serve it, for the apps the primary knew when
   *  this worker was started. An app that is not listed decides from its own
   *  configured count (see ClusterWorkerHub.shouldListen). */
  listeners?: Record<number, number>;
}

/** Is this thread a Moro cluster worker (the thread analogue of cluster.isWorker)? */
export function threadWorkerInfo(data: unknown = wt().workerData): ThreadWorkerInfo | null {
  if (wt().isMainThread) return null;
  const d = data as Record<string, any> | null | undefined;
  return threadWorkerInfoFrom(d && typeof d === 'object' ? d[WORKER_DATA_KEY] : undefined);
}

/**
 * Environment variable that marks a worker PROCESS forked by Moro's cluster
 * primary and carries what workerData carries for a thread, as JSON:
 * `{ "index": 0, "workers": 4, "listeners": { "3000": 4 } }`. A cluster
 * worker forked by anything else (the application's own node:cluster code)
 * does not have it and is not spoken to over IPC.
 */
export const WORKER_ENV_KEY = 'MORO_CLUSTER_WORKER';

/** The process analogue of threadWorkerInfo(). */
export function processWorkerInfo(
  raw: string | undefined = process.env[WORKER_ENV_KEY]
): ThreadWorkerInfo | null {
  if (!raw) return null;
  try {
    return threadWorkerInfoFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

function threadWorkerInfoFrom(info: any): ThreadWorkerInfo | null {
  if (!info || typeof info !== 'object' || typeof info.index !== 'number') return null;
  return {
    index: info.index,
    workers: typeof info.workers === 'number' ? info.workers : 1,
    ...(info.listeners && typeof info.listeners === 'object' ? { listeners: info.listeners } : {}),
  };
}

export interface ClusteringConfig {
  enabled?: boolean;
  workers?: number | 'auto';
  memoryPerWorkerGB?: number | undefined;
}

export interface SystemInfo {
  cpus: number;
  totalMemGB: number;
}

/** Injection points for the container-limit probes (unit tests). */
export interface SystemProbe {
  /** Read a pseudo-file (throws when it does not exist) */
  readFile?: (path: string) => string;
  availableParallelism?: () => number;
  cpuCount?: () => number;
  totalmem?: () => number;
}

const readText = (path: string): string => readFileSync(path, 'utf8');

/**
 * CPU quota from the cgroup this process runs in (`docker run --cpus=2`,
 * Kubernetes `resources.limits.cpu`), or null when unlimited/unavailable.
 * v2 exposes `cpu.max` as "<quota> <period>" ("max ..." = unlimited); v1
 * splits it over cpu.cfs_quota_us (-1 = unlimited) and cpu.cfs_period_us.
 * A fractional quota (0.5 CPU) still means one runnable worker.
 */
function cgroupCpuQuota(read: (path: string) => string): number | null {
  try {
    const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/);
    if (quota !== 'max') {
      const q = Number(quota);
      const p = Number(period) || 100000;
      if (q > 0) return Math.max(1, Math.floor(q / p));
    }
  } catch {
    // no cgroup v2 - fall through
  }
  try {
    const q = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us').trim());
    const p = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us').trim());
    if (q > 0 && p > 0) return Math.max(1, Math.floor(q / p));
  } catch {
    // no cgroup v1 either
  }
  return null;
}

/**
 * CPUs this process may actually run on. `os.cpus().length` is the HOST's
 * core count, which inside a container is wrong twice over: `--cpuset-cpus`
 * narrows the affinity mask (honoured by os.availableParallelism(), Node
 * 18.14+) and `--cpus` / a Kubernetes CPU limit sets a cgroup quota that no
 * os call reports. 'auto' worker counts take the smaller of the two so a
 * 96-thread host pinned to 32 cores starts 32 workers, not 96.
 */
export function usableCpuCount(probe: SystemProbe = {}): number {
  const read = probe.readFile ?? readText;
  const parallelism =
    probe.availableParallelism ?? (() => (os() as any).availableParallelism?.() ?? 0);
  const cpuCount = probe.cpuCount ?? (() => os().cpus().length);

  let n = 0;
  try {
    n = parallelism();
  } catch {
    n = 0;
  }
  if (!(n >= 1)) {
    try {
      n = cpuCount();
    } catch {
      n = 0;
    }
  }
  if (!(n >= 1)) n = 1;

  const quota = cgroupCpuQuota(read);
  return quota === null ? n : Math.max(1, Math.min(n, quota));
}

/**
 * Memory available to this process: the cgroup limit when one is set below
 * the host total (`docker run --memory`, Kubernetes memory limit), else
 * os.totalmem(). Sizing workers by host RAM inside a 2 GB container would
 * plan for memory the OOM killer will not let them use.
 */
export function usableMemoryBytes(probe: SystemProbe = {}): number {
  const read = probe.readFile ?? readText;
  const total = (probe.totalmem ?? (() => os().totalmem()))();
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = read(file).trim();
      if (raw === 'max') continue;
      const limit = Number(raw);
      // v1 reports a huge sentinel when unlimited; anything >= host RAM is "no limit"
      if (Number.isFinite(limit) && limit > 0 && limit < total) return limit;
    } catch {
      // file absent - try the next layout
    }
  }
  return total;
}

export function systemInfo(probe: SystemProbe = {}): SystemInfo {
  return {
    cpus: usableCpuCount(probe),
    totalMemGB: usableMemoryBytes(probe) / (1024 * 1024 * 1024),
  };
}

/**
 * Worker count: a user number is respected; 'auto' (or unset) is
 * min(cpus, floor(totalRAM / memoryPerWorkerGB)) where memoryPerWorkerGB
 * defaults to max(0.5, floor((totalRAM - 4 GB headroom) / cpus)). Never < 1.
 * (Lifted unchanged from the process path so both transports agree.)
 */
export function computeWorkerCount(
  cfg: ClusteringConfig | undefined,
  sys: SystemInfo = systemInfo()
): { count: number; detail: string } {
  const requested = cfg?.workers ?? 'auto';
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return {
      count: Math.floor(requested),
      detail: `Using user-specified worker count: ${Math.floor(requested)}`,
    };
  }
  const cpuCount = Math.max(1, sys.cpus);
  const totalMemoryGB = sys.totalMemGB;
  let memoryPerWorkerGB = cfg?.memoryPerWorkerGB;
  if (!memoryPerWorkerGB) {
    const headroomGB = 4;
    memoryPerWorkerGB = Math.max(0.5, Math.floor((totalMemoryGB - headroomGB) / cpuCount));
  }
  const count = Math.max(1, Math.min(cpuCount, Math.floor(totalMemoryGB / memoryPerWorkerGB)));
  return {
    count,
    detail: `Auto-calculated worker count: ${count} (CPU: ${cpuCount}, RAM: ${totalMemoryGB.toFixed(1)}GB, ${memoryPerWorkerGB}GB per worker)`,
  };
}

/** Did the operator tune the young generation themselves? Then leave it alone. */
export function isUserTunedYoungGen(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS
): boolean {
  return (
    execArgv.some(a => a.includes('--max-semi-space-size')) ||
    (nodeOptions || '').includes('--max-semi-space-size')
  );
}

export type ClusterTransport =
  { kind: 'threads'; entry: string } | { kind: 'processes'; reason: string };

export interface TransportInput {
  platform: NodeJS.Platform;
  isMainThread: boolean;
  argv1: string | undefined;
  /** app.engine.server: 'engine' | 'node' | 'http2' */
  engineServer: string;
  /** app.engine.enginePackage, e.g. '@morojs/engine' */
  enginePackage?: string | undefined;
  /** engine capabilities.workerThreads (teardown-safe inside a thread) */
  workerThreadsCapable: boolean;
  fileExists?: (p: string) => boolean;
}

/**
 * Threads iff every precondition holds; otherwise processes, with the reason
 * (logged once). The reasons are the exact conditions the process path still
 * covers, so nothing that worked before loses clustering.
 */
export function resolveClusterTransport(input: TransportInput): ClusterTransport {
  const exists = input.fileExists ?? existsSync;
  if (input.platform === 'win32')
    return { kind: 'processes', reason: 'Windows has no SO_REUSEPORT' };
  if (input.engineServer !== 'engine' || input.enginePackage !== '@morojs/engine') {
    return { kind: 'processes', reason: `engine '${input.engineServer}' clusters as processes` };
  }
  if (!input.workerThreadsCapable) {
    return {
      kind: 'processes',
      reason: 'this @morojs/engine build predates worker-thread support (< 1.1.6)',
    };
  }
  if (!input.isMainThread) return { kind: 'processes', reason: 'not on the main thread' };
  if (typeof input.argv1 !== 'string' || input.argv1.length === 0) {
    return { kind: 'processes', reason: 'no entry script (REPL/eval)' };
  }
  const entry = resolvePath(input.argv1);
  if (!exists(entry)) return { kind: 'processes', reason: `entry script not found: ${entry}` };
  return { kind: 'threads', entry };
}

// ---- primary <-> worker protocol ----------------------------------------------

/**
 * Every protocol message carries `channel: CLUSTER_CHANNEL`. The port it
 * travels on (parentPort / the Worker object) is shared with application code
 * and libraries, which post `{ type: 'ready' }`-shaped messages of their own:
 * a message without the channel is not ours and is ignored by both ends.
 * Primary and workers are the same module in the same process, so the two
 * ends always agree on the value.
 */
export const CLUSTER_CHANNEL = 'moro:cluster';

interface ClusterMessage {
  channel: typeof CLUSTER_CHANNEL;
}

export type WorkerToPrimary = ClusterMessage &
  (
    | { type: 'ready'; threadId: number; port: number }
    // With a port: that app's listener is closed in this worker and the
    // worker goes on serving its other apps. Without: the worker is done.
    | { type: 'closed'; threadId: number; port?: number }
    | { type: 'pong'; threadId: number; inflight: number }
    | { type: 'fatal'; threadId: number; code: string; message: string; port?: number }
  );

export type PrimaryToWorker = ClusterMessage &
  (
    | { type: 'shutdown' }
    | { type: 'ping' }
    // One app of the process was closed (or is listening again) while the
    // others keep the workers: close (open) that app's listener only.
    | { type: 'close'; port: number }
    | { type: 'open'; port: number }
  );

type WithoutChannel<T> = T extends unknown ? Omit<T, 'channel'> : never;

export function isClusterMessage(m: unknown): boolean {
  return !!m && typeof m === 'object' && (m as { channel?: unknown }).channel === CLUSTER_CHANNEL;
}

/** The subset of worker_threads.Worker the primary uses (fakeable). */
export interface WorkerLike {
  threadId: number;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  postMessage(message: PrimaryToWorker): void;
  terminate(): Promise<number>;
  unref(): void;
  ref(): void;
}

export type SpawnWorker = (entry: string, options: WorkerOptions) => WorkerLike;

export interface ClusterLogger {
  info(message: string, context?: string, ...rest: any[]): void;
  warn(message: string, context?: string, ...rest: any[]): void;
  error(message: string, context?: string, ...rest: any[]): void;
  debug?(message: string, context?: string, ...rest: any[]): void;
}

export interface WorkerRecord {
  worker: WorkerLike;
  index: number;
  startedAt: number;
  ready: boolean;
  /** The worker reported that its close() completed. */
  closed: boolean;
  port: number | null;
  /** The listeners this worker has reported ready and not closed since. */
  ports: Set<number>;
  restarts: number;
  missedPongs: number;
}

export type FatalKind = 'boot' | 'bind';

export interface ThreadClusterPrimaryOptions {
  entry: string;
  argv: string[];
  workerCount: number;
  logger: ClusterLogger;
  resourceLimits?: WorkerOptions['resourceLimits'];
  /** First 'ready' from any worker (fires once). */
  onReady: () => void;
  /** Every 'ready': a worker is serving the app that listens on `port`. */
  onListening?: (port: number, threadId: number) => void;
  /** Port -> how many workers serve it, read at every spawn and handed to
   *  the worker (a restarted worker sees what is current). */
  listeners?: () => Record<number, number>;
  /** A worker failed before the cluster ever became ready ('boot': spawn or
   *  module error - the caller may fall back to processes; 'bind': the port
   *  cannot be bound - processes would fail identically, surface it). */
  onFatal: (error: Error, kind: FatalKind) => void;
  spawn?: SpawnWorker;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (t: any) => void;
  healthIntervalMs?: number;
}

const RESTART_BASE_MS = 200;
const RESTART_MAX_MS = 5000;
const RESTART_WINDOW_MS = 60_000; // a worker alive this long resets its backoff
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_MISSES_BEFORE_WARN = 3;

export interface RestartState {
  restarts: number;
  lastStart: number;
}

/**
 * Delay before one worker slot is started again, for both transports: 200 ms,
 * doubling on every consecutive restart up to 5 s. A worker that had been up
 * for the restart window (60 s) starts again from 200 ms. Updates `state`.
 */
export function nextRestartDelay(state: RestartState, aliveMs: number, now: number): number {
  if (now - state.lastStart > RESTART_WINDOW_MS && aliveMs > RESTART_WINDOW_MS) state.restarts = 0;
  const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** state.restarts);
  state.restarts += 1;
  state.lastStart = now;
  return delay;
}

const defaultSpawn: SpawnWorker = (entry, options) =>
  new (wt().Worker)(entry, options) as unknown as WorkerLike;

export class ThreadClusterPrimary {
  private readonly opts: ThreadClusterPrimaryOptions;
  private readonly spawnFn: SpawnWorker;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => any;
  private readonly clearTimer: (t: any) => void;
  private readonly records = new Map<number, WorkerRecord>();
  private readonly backoff = new Map<number, RestartState>();
  private readyFired = false;
  private shuttingDown = false;
  private healthTimer: any = null;
  private pendingTimers = new Set<any>();
  private workerCount: number;
  // closePort() calls in flight: told of every listener a worker closes
  // (port) and of every worker that exits (null).
  private portWaiters = new Set<(record: WorkerRecord, port: number | null) => void>();

  constructor(opts: ThreadClusterPrimaryOptions) {
    this.opts = opts;
    this.workerCount = opts.workerCount;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.now = opts.now ?? Date.now;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as any).unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? (t => clearTimeout(t));
  }

  get workers(): ReadonlyMap<number, WorkerRecord> {
    return this.records;
  }

  /** True until every initial worker has reported 'ready'. */
  get bootPhase(): boolean {
    if (this.readyFired) {
      for (const r of this.records.values()) if (!r.ready) return true;
      return false;
    }
    return true;
  }

  /** How many worker slots the set has. */
  get size(): number {
    return this.workerCount;
  }

  /** Is any worker serving the app that listens on `port`? */
  listening(port: number): boolean {
    for (const r of this.records.values()) if (r.ports.has(port)) return true;
    return false;
  }

  /** Add worker slots up to `count` (an app that joined asks for more
   *  workers than the set has). Never shrinks. */
  grow(count: number): void {
    if (this.shuttingDown) return;
    while (this.workerCount < count) {
      const index = this.workerCount++;
      try {
        this.spawnAt(index);
      } catch (err) {
        this.opts.logger.error(
          `Worker thread start failed: ${err instanceof Error ? err.message : String(err)}`,
          'Cluster'
        );
        this.scheduleRestart(index, -1, -1);
      }
    }
  }

  /**
   * Close one app's listener in every worker that serves it and leave the
   * workers running for the other apps. Resolves when each of those workers
   * has reported it closed (or exited), or at the deadline.
   */
  closePort(port: number, deadlineMs = 3000): Promise<void> {
    const targets = [...this.records.values()].filter(r => r.ports.has(port));
    if (targets.length === 0 || this.shuttingDown) return Promise.resolve();
    return new Promise<void>(resolve => {
      const pending = new Set(targets);
      let timer: any = null;
      const finish = () => {
        if (timer) this.clearTimer(timer);
        this.portWaiters.delete(waiter);
        resolve();
      };
      const waiter = (record: WorkerRecord, closedPort: number | null) => {
        if (closedPort !== null && closedPort !== port) return;
        pending.delete(record);
        if (pending.size === 0) finish();
      };
      this.portWaiters.add(waiter);
      timer = this.setTimer(() => {
        this.opts.logger.warn(
          `Port ${port} was still open in ${pending.size} worker thread(s) after ${deadlineMs} ms`,
          'Cluster'
        );
        finish();
      }, deadlineMs);
      for (const r of targets) {
        try {
          r.worker.postMessage({ channel: CLUSTER_CHANNEL, type: 'close', port });
        } catch {
          waiter(r, port);
        }
      }
    });
  }

  /** An app that was closed is listening again: open its listener in the
   *  first `count` workers that do not serve it. */
  openPort(port: number, count: number): void {
    for (const r of this.records.values()) {
      if (r.index >= count || r.ports.has(port)) continue;
      try {
        r.worker.postMessage({ channel: CLUSTER_CHANNEL, type: 'open', port });
      } catch {
        // exiting
      }
    }
  }

  /** Spawn every worker. Throws synchronously if the FIRST spawn throws (the
   *  entry cannot be started as a thread at all). */
  start(): void {
    for (let i = 0; i < this.workerCount; i++) this.spawnAt(i);
    this.healthTimer = this.setTimer(
      () => this.healthTick(),
      this.opts.healthIntervalMs ?? HEALTH_INTERVAL_MS
    );
  }

  private spawnAt(index: number): void {
    const listeners = this.opts.listeners?.();
    const options: WorkerOptions = {
      argv: this.opts.argv,
      workerData: {
        [WORKER_DATA_KEY]: {
          index,
          workers: this.workerCount,
          ...(listeners ? { listeners: { ...listeners } } : {}),
        },
      },
      // No execArgv (inherited: V8 flags passed explicitly are rejected by
      // Worker, inherited ones are tolerated) and no env (a copy of
      // process.env at spawn time - UV_THREADPOOL_SIZE was set before).
      ...(this.opts.resourceLimits ? { resourceLimits: this.opts.resourceLimits } : {}),
      name: `moro-worker-${index}`,
    };
    const worker = this.spawnFn(this.opts.entry, options);
    // Read once, here: a Worker's threadId is -1 from the moment the thread
    // has exited, which includes every 'exit' listener.
    const threadId = worker.threadId;
    const record: WorkerRecord = {
      worker,
      index,
      startedAt: this.now(),
      ready: false,
      closed: false,
      port: null,
      ports: new Set<number>(),
      restarts: this.backoff.get(index)?.restarts ?? 0,
      missedPongs: 0,
    };
    this.records.set(threadId, record);
    let bootFailed = false;

    worker.on('message', (m: WorkerToPrimary) => {
      // Anything without the channel was posted by application code.
      if (!isClusterMessage(m)) return;
      if (m.type === 'ready') {
        record.ready = true;
        record.port = m.port;
        record.ports.add(m.port);
        this.opts.logger.info(`Worker thread ${threadId} ready on port ${m.port}`, 'Cluster');
        // The app was closed while this worker was still starting (or the
        // worker is beyond the app's count): it is told now.
        const limit = this.opts.listeners?.()[m.port];
        if (limit !== undefined && index >= limit) {
          try {
            worker.postMessage({ channel: CLUSTER_CHANNEL, type: 'close', port: m.port });
          } catch {
            // exiting
          }
        }
        if (!this.readyFired) {
          this.readyFired = true;
          this.opts.onReady();
        }
        this.opts.onListening?.(m.port, threadId);
      } else if (m.type === 'pong') {
        record.missedPongs = 0;
      } else if (m.type === 'closed') {
        if (typeof m.port === 'number') {
          // One app's listener; the worker serves on.
          record.ports.delete(m.port);
          for (const waiter of [...this.portWaiters]) waiter(record, m.port);
          return;
        }
        // The worker's close() has completed; the thread exits by itself once
        // nothing in it holds the event loop.
        record.closed = true;
      } else if (m.type === 'fatal') {
        // 'fatal' reports a failed start. A listener that is already serving
        // has nothing of the kind to report.
        if (typeof m.port === 'number' ? record.ports.has(m.port) : record.ready) return;
        // A worker that serves another app goes on serving it: this is the
        // one app's failure, not the worker's.
        if (!record.ready) bootFailed = true;
        const err = Object.assign(new Error(m.message), {
          code: m.code,
          threadId,
          ...(typeof m.port === 'number' ? { port: m.port } : {}),
        });
        const isBind = m.code === 'EADDRINUSE' || m.code === 'EACCES';
        this.opts.logger.error(
          `Worker thread ${threadId} fatal (${m.code}): ${m.message}`,
          'Cluster'
        );
        if (!this.readyFired || isBind) this.opts.onFatal(err, isBind ? 'bind' : 'boot');
      }
    });
    worker.on('error', (err: Error) => {
      this.opts.logger.error(`Worker thread ${threadId} error: ${err.message}`, 'Cluster');
      if (!record.ready && !this.readyFired) {
        bootFailed = true;
        this.opts.onFatal(err, 'boot');
      }
    });
    worker.on('exit', (code: number) => {
      this.records.delete(threadId);
      for (const waiter of [...this.portWaiters]) waiter(record, null);
      if (this.shuttingDown) return;
      if (bootFailed) return; // onFatal already decided what happens
      if (code === 0 && record.ready) {
        // A worker that finished on its own after serving: nothing to
        // supervise (mirrors cluster's exitedAfterDisconnect).
        this.opts.logger.warn(`Worker thread ${threadId} exited cleanly`, 'Cluster');
        return;
      }
      this.scheduleRestart(index, threadId, code, this.now() - record.startedAt);
    });
  }

  private scheduleRestart(index: number, oldThreadId: number, code: number, aliveMs = 0): void {
    const state = this.backoff.get(index) ?? { restarts: 0, lastStart: 0 };
    const delay = nextRestartDelay(state, aliveMs, this.now());
    this.backoff.set(index, state);
    this.opts.logger.warn(
      `Worker thread ${oldThreadId} exited (code ${code}). Restarting in ${delay} ms...`,
      'Cluster'
    );
    const t = this.setTimer(() => {
      this.pendingTimers.delete(t);
      if (this.shuttingDown) return;
      try {
        this.spawnAt(index);
      } catch (err) {
        this.opts.logger.error(
          `Worker thread restart failed: ${err instanceof Error ? err.message : String(err)}`,
          'Cluster'
        );
        this.scheduleRestart(index, oldThreadId, -1);
      }
    }, delay);
    // Unlike the health and deadline timers, a pending restart must hold the
    // event loop: when every worker is down at once (a one-worker cluster, or
    // a fault common to all of them) nothing else does, and the process would
    // exit with code 0 instead of starting the worker again.
    (t as { ref?: () => void } | null)?.ref?.();
    this.pendingTimers.add(t);
  }

  private healthTick(): void {
    if (this.shuttingDown) return;
    for (const r of this.records.values()) {
      if (!r.ready) continue;
      r.missedPongs += 1;
      if (r.missedPongs > HEALTH_MISSES_BEFORE_WARN) {
        this.opts.logger.warn(
          `Worker thread ${r.worker.threadId} missed ${r.missedPongs} health pings (event loop blocked?)`,
          'Cluster'
        );
      }
      try {
        r.worker.postMessage({ channel: CLUSTER_CHANNEL, type: 'ping' });
      } catch {
        // exiting
      }
    }
    this.healthTimer = this.setTimer(
      () => this.healthTick(),
      this.opts.healthIntervalMs ?? HEALTH_INTERVAL_MS
    );
  }

  /**
   * Post 'shutdown' to every worker (each drains its server via app.close()),
   * wait for their 'exit's up to the deadline, then terminate() stragglers.
   * Resolves once every thread is gone.
   */
  async shutdown(deadlineMs = 3000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.healthTimer) this.clearTimer(this.healthTimer);
    for (const t of this.pendingTimers) this.clearTimer(t);
    this.pendingTimers.clear();
    const live = [...this.records.values()];
    if (live.length === 0) return;
    const exits = live.map(
      r =>
        new Promise<void>(resolve => {
          r.worker.once('exit', () => resolve());
          try {
            r.worker.postMessage({ channel: CLUSTER_CHANNEL, type: 'shutdown' });
          } catch {
            resolve();
          }
        })
    );
    let timer: any = null;
    const deadline = new Promise<'timeout'>(resolve => {
      timer = this.setTimer(() => resolve('timeout'), deadlineMs);
    });
    const outcome = await Promise.race([
      Promise.all(exits).then(() => 'drained' as const),
      deadline,
    ]);
    if (timer) this.clearTimer(timer);
    if (outcome === 'timeout') {
      const stragglers = [...this.records.values()];
      // A worker that reported 'closed' finished its own shutdown and is kept
      // alive by something the application left open; the others were still
      // closing (a request in flight, an onClose hook that has not settled).
      const closed = stragglers.filter(r => r.closed).length;
      this.opts.logger.warn(
        `Shutdown deadline (${deadlineMs} ms) reached; terminating ${stragglers.length} worker thread(s)` +
          (closed > 0
            ? ` (${closed} had closed and were kept alive by a timer, socket or other handle still open in application code)`
            : ''),
        'Cluster'
      );
      await Promise.all(
        stragglers.map(async r => {
          try {
            await r.worker.terminate();
          } catch {
            // already gone
          }
        })
      );
    }
    this.records.clear();
  }
}

// ---- the worker side ----------------------------------------------------------

/** The channel from a worker to its primary: parentPort for a thread, IPC
 *  for a process. */
export interface WorkerLink {
  /** threadId or pid. */
  id: number;
  post(message: WorkerToPrimary): void;
  listen(fn: (message: unknown) => void): void;
  /** The worker is done: let go of the channel (a thread then exits once its
   *  handles are closed; never process.exit() inside a thread). */
  release(): void;
}

function threadLink(): WorkerLink {
  const port = wt().parentPort;
  return {
    id: wt().threadId,
    post: m => port?.postMessage(m),
    listen: fn => void port?.on('message', fn),
    release: () => port?.close(),
  };
}

function processLink(): WorkerLink {
  return {
    id: process.pid,
    post: m => void process.send?.(m),
    listen: fn => void process.on('message', fn),
    // A process is ended by its own signal handling, not by its channel.
    release: () => {},
  };
}

/**
 * The worker side, one per worker thread or worker process: the clustered
 * apps this worker hosts, by the port each listens on. It answers the
 * primary for all of them: 'shutdown' closes every app and then lets go of
 * the channel, 'close' and 'open' act on one app and leave the others
 * serving, 'ping' is answered once.
 */
export class ClusterWorkerHub {
  private readonly apps = new Map<number, ClusterWorkerApp>();
  // What the primary has said about a port since this worker started, which
  // outranks what the worker was started with: true = open, false = closed.
  private readonly overrides = new Map<number, boolean>();
  private attached = false;
  private shuttingDown = false;
  private released = false;

  constructor(
    readonly info: ThreadWorkerInfo,
    private readonly link: WorkerLink,
    private readonly logger: ClusterLogger
  ) {}

  get id(): number {
    return this.link.id;
  }

  /**
   * Does the app on `port`, configured for `ownCount` workers, listen in
   * this worker? The primary's count for the port when it gave one (it is
   * the count of the app that actually joined), the app's own otherwise;
   * the worker with index n serves the apps that asked for more than n
   * workers. In a process with one clustered app that is every worker.
   */
  shouldListen(port: number, ownCount: number): boolean {
    const said = this.overrides.get(port);
    if (said !== undefined) return said;
    const limit = this.info.listeners?.[port];
    return this.info.index < (typeof limit === 'number' ? limit : ownCount);
  }

  register(app: ClusterWorkerApp): void {
    this.apps.set(app.port, app);
    if (this.attached) return;
    this.attached = true;
    this.link.listen(message => {
      // Anything without the channel is addressed to application code.
      if (!isClusterMessage(message)) return;
      void this.handle(message as PrimaryToWorker);
    });
  }

  post(body: WithoutChannel<WorkerToPrimary>): void {
    if (this.released) return;
    try {
      this.link.post({ channel: CLUSTER_CHANNEL, ...body } as WorkerToPrimary);
    } catch {
      // primary gone
    }
  }

  private async handle(m: PrimaryToWorker): Promise<void> {
    if (m.type === 'ping') {
      let inflight = 0;
      for (const app of this.apps.values()) inflight += app.inflight();
      this.post({ type: 'pong', threadId: this.link.id, inflight });
    } else if (m.type === 'shutdown') {
      if (this.shuttingDown) return;
      this.shuttingDown = true;
      this.logger.info(`Worker ${this.link.id} shutting down gracefully...`, 'Worker');
      await Promise.all([...this.apps.values()].map(app => app.runClose(true)));
      this.release();
    } else if (m.type === 'close') {
      this.overrides.set(m.port, false);
      await this.apps.get(m.port)?.runClose(false);
      this.post({ type: 'closed', threadId: this.link.id, port: m.port });
    } else if (m.type === 'open') {
      this.overrides.set(m.port, true);
      if (!this.shuttingDown) this.apps.get(m.port)?.reopen();
    }
  }

  /** An app is finished here after a failed start: when it was the last one
   *  serving, so is the worker. */
  settle(): void {
    for (const app of this.apps.values()) if (app.active) return;
    this.release();
  }

  private release(): void {
    if (this.released) return;
    this.post({ type: 'closed', threadId: this.link.id });
    this.released = true;
    try {
      this.link.release();
    } catch {
      // already closed
    }
  }
}

/** One clustered app in one worker: what the hub calls, and what the app
 *  reports to the primary. */
export class ClusterWorkerApp {
  /** Listening, or starting to. */
  active = false;
  inflight: () => number = () => 0;
  private closeHandler: ((final: boolean) => Promise<void> | void) | null = null;
  private reopenHandler: (() => void) | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly hub: ClusterWorkerHub,
    readonly port: number,
    private readonly logger: ClusterLogger
  ) {
    hub.register(this);
  }

  /** Close the app in this worker. `final`: the worker is shutting down;
   *  otherwise the app alone was closed and may be opened again. */
  onClose(fn: (final: boolean) => Promise<void> | void): void {
    this.closeHandler = fn;
  }

  /** The app is to listen again in this worker (after a close, or in a
   *  worker that did not serve it until now). */
  onReopen(fn: () => void): void {
    this.reopenHandler = fn;
  }

  inflightProvider(fn: () => number): void {
    this.inflight = fn;
  }

  ready(): void {
    this.hub.post({ type: 'ready', threadId: this.hub.id, port: this.port });
  }

  fatal(code: string, message: string): void {
    this.hub.post({ type: 'fatal', threadId: this.hub.id, code, message, port: this.port });
  }

  /** Finished here (after fatal()). */
  close(): void {
    this.active = false;
    this.hub.settle();
  }

  runClose(final: boolean): Promise<void> {
    if (!this.active && this.closing === null) return Promise.resolve();
    this.closing ??= (async () => {
      try {
        await this.closeHandler?.(final);
      } catch (err) {
        this.logger.error(
          `Worker ${this.hub.id} shutdown error: ${err instanceof Error ? err.message : String(err)}`,
          'Worker'
        );
      } finally {
        this.active = false;
        this.closing = null;
      }
    })();
    return this.closing;
  }

  reopen(): void {
    if (this.active || this.closing !== null) return;
    try {
      this.reopenHandler?.();
    } catch (err) {
      this.logger.error(
        `Worker ${this.hub.id} could not listen on port ${this.port} again: ${err instanceof Error ? err.message : String(err)}`,
        'Worker'
      );
    }
  }
}

let hub: ClusterWorkerHub | null | undefined = undefined;

/**
 * This worker's hub, or null when the thread or process is not a worker of
 * Moro's cluster primary (the main thread of the primary, a worker thread
 * the application started itself, a node:cluster worker forked by the
 * application's own code).
 */
export function clusterWorkerHub(logger: ClusterLogger): ClusterWorkerHub | null {
  if (hub !== undefined) return hub;
  const tinfo = threadWorkerInfo();
  if (tinfo) {
    hub = new ClusterWorkerHub(tinfo, threadLink(), logger);
    return hub;
  }
  const pinfo =
    wt().isMainThread && typeof process.send === 'function' ? processWorkerInfo() : null;
  // Read once: a process this worker starts itself must not inherit the mark.
  if (wt().isMainThread) delete process.env[WORKER_ENV_KEY];
  hub = pinfo ? new ClusterWorkerHub(pinfo, processLink(), logger) : null;
  return hub;
}
