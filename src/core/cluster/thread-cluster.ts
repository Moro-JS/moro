// Worker-thread clustering for the native engine backend.
//
// `performance.clustering` keeps its keys; what changes is the transport
// underneath: on POSIX, with @morojs/engine >= 1.1.6 (capabilities.workerThreads),
// the workers are worker_threads inside ONE process, each binding the port
// with SO_REUSEPORT exactly as the process workers did. Everything that
// cannot be a thread stays on node:cluster automatically - Windows (no
// SO_REUSEPORT), the node/uWS engines, an older engine, a REPL/eval entry,
// or a worker thread that fails to boot (see resolveClusterTransport and the
// boot-phase fallback in Moro.startThreadPrimary).
//
// Why threads: one process shares the node binary, the addon and the code
// pages, so per-worker RSS drops; there is one pid to supervise; and a
// worker crash is an 'error'/'exit' event on the primary instead of a
// process death. The trade-off (stated in the release notes): a NATIVE crash
// in one thread takes the whole process down, where processes isolate.
//
// This module is internal (not exported from src/index.ts). Everything here
// is dependency-injectable so the sequencing (spawn, restart backoff, health
// pings, bounded shutdown) is unit-tested with a fake Worker and fake timers.
import { requireBuiltin } from '../utilities/builtin.js';
import { existsSync } from 'fs';
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
}

/** Is this thread a Moro cluster worker (the thread analogue of cluster.isWorker)? */
export function threadWorkerInfo(data: unknown = wt().workerData): ThreadWorkerInfo | null {
  if (wt().isMainThread) return null;
  const d = data as Record<string, any> | null | undefined;
  const info = d && typeof d === 'object' ? d[WORKER_DATA_KEY] : undefined;
  if (!info || typeof info !== 'object' || typeof info.index !== 'number') return null;
  return { index: info.index, workers: typeof info.workers === 'number' ? info.workers : 1 };
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

function systemInfo(): SystemInfo {
  return { cpus: os().cpus().length, totalMemGB: os().totalmem() / (1024 * 1024 * 1024) };
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
  /** app.engine.server: 'engine' | 'node' | 'uws' */
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

export type WorkerToPrimary =
  | { type: 'ready'; threadId: number; port: number }
  | { type: 'closed'; threadId: number }
  | { type: 'pong'; threadId: number; inflight: number }
  | { type: 'fatal'; threadId: number; code: string; message: string };

export type PrimaryToWorker = { type: 'shutdown' } | { type: 'ping' };

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
  port: number | null;
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

const defaultSpawn: SpawnWorker = (entry, options) =>
  new (wt().Worker)(entry, options) as unknown as WorkerLike;

export class ThreadClusterPrimary {
  private readonly opts: ThreadClusterPrimaryOptions;
  private readonly spawnFn: SpawnWorker;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => any;
  private readonly clearTimer: (t: any) => void;
  private readonly records = new Map<number, WorkerRecord>();
  private readonly backoff = new Map<number, { restarts: number; lastStart: number }>();
  private readyFired = false;
  private shuttingDown = false;
  private healthTimer: any = null;
  private pendingTimers = new Set<any>();

  constructor(opts: ThreadClusterPrimaryOptions) {
    this.opts = opts;
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

  /** Spawn every worker. Throws synchronously if the FIRST spawn throws (the
   *  entry cannot be started as a thread at all). */
  start(): void {
    for (let i = 0; i < this.opts.workerCount; i++) this.spawnAt(i);
    this.healthTimer = this.setTimer(
      () => this.healthTick(),
      this.opts.healthIntervalMs ?? HEALTH_INTERVAL_MS
    );
  }

  private spawnAt(index: number): void {
    const options: WorkerOptions = {
      argv: this.opts.argv,
      workerData: { [WORKER_DATA_KEY]: { index, workers: this.opts.workerCount } },
      // No execArgv (inherited: V8 flags passed explicitly are rejected by
      // Worker, inherited ones are tolerated) and no env (a copy of
      // process.env at spawn time - UV_THREADPOOL_SIZE was set before).
      ...(this.opts.resourceLimits ? { resourceLimits: this.opts.resourceLimits } : {}),
      name: `moro-worker-${index}`,
    };
    const worker = this.spawnFn(this.opts.entry, options);
    const record: WorkerRecord = {
      worker,
      index,
      startedAt: this.now(),
      ready: false,
      port: null,
      restarts: this.backoff.get(index)?.restarts ?? 0,
      missedPongs: 0,
    };
    this.records.set(worker.threadId, record);
    let bootFailed = false;

    worker.on('message', (m: WorkerToPrimary) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        record.ready = true;
        record.port = m.port;
        this.opts.logger.info(
          `Worker thread ${worker.threadId} ready on port ${m.port}`,
          'Cluster'
        );
        if (!this.readyFired) {
          this.readyFired = true;
          this.opts.onReady();
        }
      } else if (m.type === 'pong') {
        record.missedPongs = 0;
      } else if (m.type === 'fatal') {
        bootFailed = true;
        const err = Object.assign(new Error(m.message), {
          code: m.code,
          threadId: worker.threadId,
        });
        const isBind = m.code === 'EADDRINUSE' || m.code === 'EACCES';
        this.opts.logger.error(
          `Worker thread ${worker.threadId} fatal (${m.code}): ${m.message}`,
          'Cluster'
        );
        if (!this.readyFired || isBind) this.opts.onFatal(err, isBind ? 'bind' : 'boot');
      }
    });
    worker.on('error', (err: Error) => {
      this.opts.logger.error(`Worker thread ${worker.threadId} error: ${err.message}`, 'Cluster');
      if (!record.ready && !this.readyFired) {
        bootFailed = true;
        this.opts.onFatal(err, 'boot');
      }
    });
    worker.on('exit', (code: number) => {
      this.records.delete(worker.threadId);
      if (this.shuttingDown) return;
      if (bootFailed) return; // onFatal already decided what happens
      if (code === 0 && record.ready) {
        // A worker that finished on its own after serving: nothing to
        // supervise (mirrors cluster's exitedAfterDisconnect).
        this.opts.logger.warn(`Worker thread ${worker.threadId} exited cleanly`, 'Cluster');
        return;
      }
      this.scheduleRestart(index, worker.threadId, code);
    });
  }

  private scheduleRestart(index: number, oldThreadId: number, code: number): void {
    const state = this.backoff.get(index) ?? { restarts: 0, lastStart: 0 };
    const alive = this.now() - (this.records.get(oldThreadId)?.startedAt ?? this.now());
    if (this.now() - state.lastStart > RESTART_WINDOW_MS && alive > RESTART_WINDOW_MS)
      state.restarts = 0;
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** state.restarts);
    state.restarts += 1;
    state.lastStart = this.now();
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
        r.worker.postMessage({ type: 'ping' });
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
            r.worker.postMessage({ type: 'shutdown' });
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
      this.opts.logger.warn(
        `Shutdown deadline (${deadlineMs} ms) reached; terminating ${stragglers.length} worker thread(s)`,
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

/** The worker-thread side: a thin wrapper over parentPort. */
export class ThreadClusterWorker {
  private readonly port = wt().parentPort;
  private readonly tid = wt().threadId;
  private inflight: () => number = () => 0;
  private readonly logger: ClusterLogger;
  private shutdownHandler: (() => Promise<void> | void) | null = null;

  constructor(logger: ClusterLogger) {
    this.logger = logger;
    this.port?.on('message', (m: PrimaryToWorker) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ping') {
        this.post({ type: 'pong', threadId: this.tid, inflight: this.inflight() });
      } else if (m.type === 'shutdown') {
        void this.runShutdown();
      }
    });
  }

  private post(m: WorkerToPrimary): void {
    try {
      this.port?.postMessage(m);
    } catch {
      // primary gone
    }
  }

  private async runShutdown(): Promise<void> {
    this.logger.info(`Worker thread ${this.tid} shutting down gracefully...`, 'Worker');
    try {
      await this.shutdownHandler?.();
    } catch (err) {
      this.logger.error(
        `Worker thread ${this.tid} shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        'Worker'
      );
    }
    this.close();
  }

  onShutdown(fn: () => Promise<void> | void): void {
    this.shutdownHandler = fn;
  }

  inflightProvider(fn: () => number): void {
    this.inflight = fn;
  }

  ready(port: number): void {
    this.post({ type: 'ready', threadId: this.tid, port });
  }

  fatal(code: string, message: string): void {
    this.post({ type: 'fatal', threadId: this.tid, code, message });
  }

  /** Signal completion and release the port so the thread can exit naturally
   *  once its handles are closed (never process.exit() inside a thread). */
  close(): void {
    this.post({ type: 'closed', threadId: this.tid });
    try {
      this.port?.close();
    } catch {
      // already closed
    }
  }
}
