// The process's one set of cluster workers, and the apps that share it.
//
// `performance.clustering` is set per app, but the workers belong to the
// process: every worker runs the entry script, so every worker creates every
// app of the process. An app that started its own set therefore multiplied
// the workers (two clustered apps: twice the threads, each serving both
// ports) and their memory. Here the first clustered app to listen starts the
// set and every later one joins it: its listener is added to the workers
// that exist, and the set only grows when the app asks for more workers
// than it has. Nothing is configured; one clustered app behaves as before.
//
// The worker with index n serves the apps configured for more than n
// workers, so an app keeps the count it asked for. Closing one app closes
// its listener in every worker and leaves the others serving; the workers
// stop when the last app is closed.
//
// Internal (not exported from src/index.ts). The transports are the ones of
// thread-cluster.ts: worker threads where every app of the set can run in
// one, node:cluster processes otherwise.
import { requireBuiltin } from '../utilities/builtin.js';
import {
  CLUSTER_CHANNEL,
  ThreadClusterPrimary,
  WORKER_ENV_KEY,
  YOUNG_GEN_MB_FOR_SEMI_SPACE_4,
  isClusterMessage,
  isUserTunedYoungGen,
  nextRestartDelay,
  type ClusterLogger,
  type ClusterTransport,
  type PrimaryToWorker,
  type RestartState,
  type WorkerToPrimary,
} from './thread-cluster.js';

const nodeCluster = () => requireBuiltin<(typeof import('cluster'))['default']>('cluster');

/** One clustered app, as the group sees it. */
export interface ClusterMember {
  readonly port: number;
  readonly workerCount: number;
  /** The transport this app could use by itself. */
  readonly transport: ClusterTransport;
  /** For the start-up line, e.g. '@morojs/engine v1.2.2'. */
  readonly engineLabel: string;
  readonly logger: ClusterLogger;
  /** listen()'s callback. */
  readonly callback: (() => void) | undefined;
  /** Workers are serving this app: start what runs once per cluster, in the
   *  primary (job scheduler, gRPC). */
  startServices(): void;
  /** A worker could not bind this app's port. */
  bindFailed(error: Error): void;
  /** A worker process sent something that is not the cluster's. */
  workerMessage(message: unknown): void;
  /** app.close(), for a signal. */
  close(): Promise<void>;
}

interface MemberState {
  called: boolean;
  services: boolean;
}

/** The node:cluster transport's workers. */
interface ProcessWorkers {
  grow(count: number): void;
  closePort(port: number, deadlineMs?: number): Promise<void>;
  openPort(port: number, count: number): void;
  stop(deadlineMs?: number): Promise<void>;
  readonly listening: boolean;
}

let current: ClusterGroup | undefined = undefined;
let signalsInstalled = false;

// A shutdown that ends in process.exit() must reach it: close() waits on
// timers that do not hold the event loop.
function holdEventLoopUntilExit(): void {
  setInterval(() => {}, 0x7fffffff);
}

// Graceful shutdown of a cluster primary, one pair of listeners for the
// process whatever the number of apps: every app is closed (the last one
// out stops the workers, each of which drains through its own close()) and
// only then does the process exit. A second signal exits at once.
function installSignalHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  let shuttingDown = false;
  const gracefulShutdown = () => {
    if (shuttingDown) {
      process.exit(0);
      return;
    }
    shuttingDown = true;
    const members = current ? current.memberList() : [];
    members[0]?.logger.info('Gracefully shutting down cluster...', 'Cluster');
    holdEventLoopUntilExit();
    Promise.all(members.map(member => member.close()))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

/** Start `member` on the process's workers, starting them when it is the
 *  first clustered app to listen. */
export function joinCluster(member: ClusterMember): void {
  if (current === undefined) current = new ClusterGroup();
  installSignalHandlers();
  current.join(member);
}

/** `member` was closed: its listeners close everywhere, and with the last
 *  member the workers stop. Resolves when that has happened. */
export function leaveCluster(member: ClusterMember): Promise<void> {
  const group = current;
  if (group === undefined || !group.has(member)) return Promise.resolve();
  if (group.size === 1) current = undefined;
  return group.leave(member);
}

class ClusterGroup {
  private readonly members = new Map<ClusterMember, MemberState>();
  // Port -> how many workers serve it; 0 once the app was closed. Handed to
  // every worker that starts.
  private readonly limits: Record<number, number> = {};
  private mode: 'idle' | 'threads' | 'switching' | 'processes' = 'idle';
  private threads: ThreadClusterPrimary | undefined = undefined;
  private processes: ProcessWorkers | undefined = undefined;
  private fellBack = false;

  get size(): number {
    return this.members.size;
  }

  has(member: ClusterMember): boolean {
    return this.members.has(member);
  }

  memberList(): ClusterMember[] {
    return [...this.members.keys()];
  }

  private get workerCount(): number {
    let count = 1;
    for (const member of this.members.keys()) count = Math.max(count, member.workerCount);
    return count;
  }

  join(member: ClusterMember): void {
    const first = this.members.size === 0 && this.mode === 'idle';
    this.members.set(member, { called: false, services: false });
    this.limits[member.port] = member.workerCount;

    if (first) {
      if (member.transport.kind === 'threads') {
        this.startThreads(member.transport.entry, member);
      } else {
        member.logger.info(
          `Clustering: ${member.workerCount} worker processes (node:cluster; ${member.transport.reason})`,
          'Cluster'
        );
        this.startProcesses();
      }
      return;
    }

    if (this.mode === 'threads' && this.threads) {
      if (member.transport.kind === 'processes') {
        // One set of workers serves every app, and this one cannot run in a
        // thread.
        this.fallBackToProcesses(
          `the app on port ${member.port} clusters as processes: ${member.transport.reason}`
        );
        return;
      }
      const threads = this.threads;
      threads.grow(member.workerCount);
      member.logger.info(
        `Clustering: port ${member.port} is served by the process's worker threads ` +
          `(${Math.min(member.workerCount, threads.size)} of ${threads.size})`,
        'Cluster'
      );
      threads.openPort(member.port, member.workerCount);
      // A worker runs the whole entry script, so it may be serving this app
      // before the primary has reached the app's listen().
      if (threads.listening(member.port)) setTimeout(() => this.serving(member.port), 0);
      return;
    }

    if (this.mode === 'processes' && this.processes) {
      const processes = this.processes;
      member.logger.info(
        `Clustering: port ${member.port} is served by the process's worker processes`,
        'Cluster'
      );
      processes.grow(member.workerCount);
      processes.openPort(member.port, member.workerCount);
      this.called(member);
      if (processes.listening) this.servicesFor(member);
    }
    // 'switching': the processes that are about to start serve every member.
  }

  async leave(member: ClusterMember): Promise<void> {
    if (!this.members.delete(member)) return;

    if (this.members.size === 0) {
      const threads = this.threads;
      const processes = this.processes;
      this.threads = undefined;
      this.processes = undefined;
      this.mode = 'idle';
      // Cluster worker threads: each drains its server via its own close().
      if (threads) {
        try {
          await threads.shutdown();
        } catch (err) {
          member.logger.error(`Error shutting down cluster worker threads: ${String(err)}`);
        }
      }
      // Cluster worker processes, the same way and within the same deadline.
      if (processes) {
        try {
          await processes.stop();
        } catch (err) {
          member.logger.error(`Error shutting down cluster worker processes: ${String(err)}`);
        }
      }
      return;
    }

    // The other apps keep the workers; this app's listeners close in each.
    for (const other of this.members.keys()) if (other.port === member.port) return;
    this.limits[member.port] = 0;
    try {
      await (this.threads ?? this.processes)?.closePort(member.port);
    } catch (err) {
      member.logger.error(
        `Error closing port ${member.port} in the cluster workers: ${String(err)}`
      );
    }
  }

  private called(member: ClusterMember): void {
    const state = this.members.get(member);
    if (!state || state.called) return;
    state.called = true;
    member.callback?.();
  }

  private servicesFor(member: ClusterMember): void {
    const state = this.members.get(member);
    if (!state || state.services) return;
    state.services = true;
    member.startServices();
  }

  // The first worker is serving `port`: the primary-only services of the app
  // start, then its listen() callback runs. Once per app.
  private serving(port: number): void {
    for (const member of [...this.members.keys()]) {
      if (member.port !== port) continue;
      this.servicesFor(member);
      this.called(member);
    }
  }

  private memberOn(port: unknown): ClusterMember | undefined {
    const members = this.memberList();
    return members.find(member => member.port === port) ?? members[0];
  }

  private startThreads(entry: string, starter: ClusterMember): void {
    this.mode = 'threads';
    // The libuv threadpool is process-wide and sized once at first use;
    // the process path set this per worker process. Only if the operator
    // did not choose a size.
    if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '64';
    // Same young-generation bound the process path applies through execArgv
    // (see YOUNG_GEN_MB_FOR_SEMI_SPACE_4), unless the operator tuned GC.
    const resourceLimits = isUserTunedYoungGen()
      ? undefined
      : { maxYoungGenerationSizeMb: YOUNG_GEN_MB_FOR_SEMI_SPACE_4 };

    starter.logger.info(
      `Clustering: ${starter.workerCount} worker threads (worker_threads + SO_REUSEPORT, ` +
        `${starter.engineLabel})`,
      'Cluster'
    );

    const primary = new ThreadClusterPrimary({
      entry,
      argv: process.argv.slice(2),
      workerCount: starter.workerCount,
      logger: starter.logger,
      ...(resourceLimits ? { resourceLimits } : {}),
      listeners: () => this.limits,
      onReady: () => {},
      onListening: port => this.serving(port),
      onFatal: (error, kind) => {
        if (kind === 'bind') {
          // Processes would fail identically: surface it like the single-process
          // path does (Node's server convention; rethrows without a listener).
          this.memberOn((error as { port?: number }).port)?.bindFailed(error);
          return;
        }
        this.fallBackToProcesses(error.message);
      },
    });
    this.threads = primary;
    try {
      primary.start();
    } catch (error) {
      this.fallBackToProcesses(error instanceof Error ? error.message : String(error));
    }
  }

  private fallBackToProcesses(why: string): void {
    if (this.fellBack) return;
    this.fellBack = true;
    this.memberList()[0]?.logger.warn(
      `Worker threads unavailable (${why}); falling back to worker processes`,
      'Cluster'
    );
    const primary = this.threads;
    this.threads = undefined;
    this.mode = 'switching';
    void (primary ? primary.shutdown(1000) : Promise.resolve()).finally(() => {
      // Every app was closed while the threads were stopping.
      if (this.members.size === 0) {
        this.mode = 'idle';
        return;
      }
      this.startProcesses();
    });
  }

  private startProcesses(): void {
    this.mode = 'processes';
    const cluster = nodeCluster();
    const logger = this.memberList()[0]?.logger;
    let size = this.workerCount;
    logger?.info(`Starting ${size} workers`, 'Cluster');

    // Optimize cluster scheduling for high concurrency
    // Round-robin is the default on all platforms except Windows (Node.js docs)
    // Provides better load distribution than shared socket approach
    cluster.schedulingPolicy = cluster.SCHED_RR;

    // Workers inherit the primary's execArgv; additionally bound each
    // worker's V8 young generation unless the user tuned it themselves.
    // On big machines V8 sizes the nursery from total RAM and grows it
    // under sustained load (~10-34 MB extra RSS per process, measured on a
    // 64 GB box) - and in cluster mode that cost multiplies by the worker
    // count. A/B-benched 2026-08-01: identical throughput at 4 MB semi-space
    // in both the realistic profile (~92k vs ~90k req/s) and the pipelined
    // x10 microbenchmark (~560k both ways), while sustained-load RSS drops
    // ~30 MB per worker (115 -> 81 MB on the 25-route POST soak).
    const userTunedGC = isUserTunedYoungGen();

    // Set cluster settings for better performance
    cluster.setupMaster({
      exec: process.argv[1] || process.execPath,
      args: process.argv.slice(2),
      silent: false,
      ...(userTunedGC ? {} : { execArgv: [...process.execArgv, '--max-semi-space-size=4'] }),
    });

    // IPC Optimization: Reduce communication overhead between master and workers
    // Research shows excessive IPC can create bottlenecks in clustered applications
    // (Source: BetterStack - Node.js Clustering Guide)
    process.env.NODE_CLUSTER_SCHED_POLICY = 'rr'; // Ensure round-robin
    process.env.NODE_DISABLE_COLORS = '1'; // Reduce IPC message size by disabling color codes

    // One slot per configured worker. A slot whose worker died is forked
    // again after the delay the thread transport uses (nextRestartDelay), and
    // never while the cluster is stopping.
    const workers = new Map<number, any>();
    const slots = new Map<number, { slot: number; startedAt: number; ports: Set<number> }>();
    const backoff = new Map<number, RestartState>();
    const restartTimers = new Set<ReturnType<typeof setTimeout>>();
    // closePort() calls in flight: told of every listener a worker closes
    // (port) and of every worker that exits (null).
    const portWaiters = new Set<(pid: number, port: number | null) => void>();
    let nextSlot = size;
    let stopping = false;
    let listening = false;

    const send = (worker: any, message: { type: 'close' | 'open'; port: number }) => {
      try {
        worker.send({ channel: CLUSTER_CHANNEL, ...message } satisfies PrimaryToWorker);
      } catch {
        // exiting
      }
    };

    // Primary-only services start once the first worker is serving.
    const onListening = () => {
      if (listening) return;
      listening = true;
      for (const member of this.memberList()) this.servicesFor(member);
    };

    const onWorkerMessage = (pid: number, worker: any, message: unknown) => {
      if (!isClusterMessage(message)) {
        this.memberList()[0]?.workerMessage(message);
        return;
      }
      const m = message as WorkerToPrimary;
      const known = slots.get(pid);
      if (m.type === 'ready') {
        known?.ports.add(m.port);
        // Closed while this worker was starting, or a worker beyond the
        // app's count: it is told now.
        const limit = this.limits[m.port];
        if (known && limit !== undefined && known.slot >= limit) {
          send(worker, { type: 'close', port: m.port });
        }
        onListening();
      } else if (m.type === 'closed' && typeof m.port === 'number') {
        known?.ports.delete(m.port);
        for (const waiter of [...portWaiters]) waiter(pid, m.port);
      }
    };

    const forkWorker = (slot: number, verb: 'started' | 'restarted') => {
      // A worker the application forked itself has no slot here and is
      // replaced by a plain fork, as before.
      const worker = cluster.fork(
        slot < size
          ? {
              [WORKER_ENV_KEY]: JSON.stringify({
                index: slot,
                workers: size,
                listeners: this.limits,
              }),
            }
          : undefined
      );
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const pid = worker.process.pid!;
      workers.set(pid, worker);
      slots.set(pid, { slot, startedAt: Date.now(), ports: new Set<number>() });
      logger?.info(`Worker ${pid} ${verb}`, 'Cluster');

      // Handle individual worker messages
      worker.on('message', (message: unknown) => onWorkerMessage(pid, worker, message));
    };

    const scheduleRestart = (slot: number, aliveMs: number, why: string) => {
      const state = backoff.get(slot) ?? { restarts: 0, lastStart: 0 };
      const delay = nextRestartDelay(state, aliveMs, Date.now());
      backoff.set(slot, state);
      logger?.warn(`${why}. Restarting in ${delay} ms...`, 'Cluster');
      // Referenced on purpose: with every worker down, this timer is what
      // keeps the primary alive until the next attempt.
      const timer = setTimeout(() => {
        restartTimers.delete(timer);
        if (stopping) return;
        try {
          forkWorker(slot, 'restarted');
        } catch (error) {
          scheduleRestart(
            slot,
            0,
            `Worker restart failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }, delay);
      restartTimers.add(timer);
    };

    const onExit = (worker: any, code: number, signal: string) => {
      const pid = worker.process.pid;
      workers.delete(pid);
      const known = slots.get(pid);
      slots.delete(pid);
      for (const waiter of [...portWaiters]) waiter(pid, null);
      if (stopping) return;

      if (code !== 0 && !worker.exitedAfterDisconnect) {
        scheduleRestart(
          known ? known.slot : nextSlot++,
          known ? Date.now() - known.startedAt : 0,
          `Worker ${pid} died unexpectedly (${signal || code})`
        );
      }
    };

    // Stop every worker: SIGTERM (each stops accepting, drains its in-flight
    // responses through its own close(), then exits), wait for the exits up
    // to the deadline, SIGKILL whatever is left. The primary must outlive
    // them: a node:cluster worker whose primary disappears exits at once,
    // cutting the very responses it was draining.
    const stop = (deadlineMs = 3000) => {
      stopping = true;
      for (const timer of restartTimers) clearTimeout(timer);
      restartTimers.clear();
      cluster.removeListener('listening', onListening);

      const live = Array.from(workers);
      return new Promise<void>(resolve => {
        const pending = new Set<number>(live.map(([pid]) => pid));
        let deadline: ReturnType<typeof setTimeout> | undefined = undefined;
        let killGrace: ReturnType<typeof setTimeout> | undefined = undefined;
        const finish = () => {
          clearTimeout(deadline);
          clearTimeout(killGrace);
          cluster.removeListener('exit', onExit);
          // onExit is gone before it has seen the last of these exits
          for (const [pid] of live) {
            workers.delete(pid);
            slots.delete(pid);
          }
          resolve();
        };
        if (pending.size === 0) {
          finish();
          return;
        }
        deadline = setTimeout(() => {
          logger?.warn(
            `Shutdown deadline reached; terminating ${pending.size} worker process(es)`,
            'Cluster'
          );
          for (const pid of pending) workers.get(pid)?.kill('SIGKILL');
          // SIGKILL cannot be refused; the exits follow at once. The short
          // wait only keeps a lost 'exit' event from holding close() open.
          killGrace = setTimeout(finish, 500);
        }, deadlineMs);
        for (const [pid, worker] of live) {
          worker.once('exit', () => {
            pending.delete(pid);
            if (pending.size === 0) finish();
          });
          worker.kill('SIGTERM');
        }
      });
    };

    const closePort = (port: number, deadlineMs = 3000) => {
      const targets = [...slots].filter(([, known]) => known.ports.has(port)).map(([pid]) => pid);
      if (targets.length === 0 || stopping) return Promise.resolve();
      return new Promise<void>(resolve => {
        const pending = new Set(targets);
        const finish = () => {
          clearTimeout(deadline);
          portWaiters.delete(waiter);
          resolve();
        };
        const waiter = (pid: number, closedPort: number | null) => {
          if (closedPort !== null && closedPort !== port) return;
          pending.delete(pid);
          if (pending.size === 0) finish();
        };
        const deadline = setTimeout(() => {
          logger?.warn(
            `Port ${port} was still open in ${pending.size} worker process(es) after ${deadlineMs} ms`,
            'Cluster'
          );
          finish();
        }, deadlineMs);
        portWaiters.add(waiter);
        for (const pid of targets) send(workers.get(pid), { type: 'close', port });
      });
    };

    this.processes = {
      grow: count => {
        if (stopping) return;
        while (size < count) {
          const slot = size++;
          if (nextSlot < size) nextSlot = size;
          forkWorker(slot, 'started');
        }
      },
      closePort,
      openPort: (port, count) => {
        for (const [pid, known] of slots) {
          if (known.slot >= count || known.ports.has(port)) continue;
          send(workers.get(pid), { type: 'open', port });
        }
      },
      stop,
      get listening() {
        return listening;
      },
    };

    // Fork workers with basic tracking
    for (let i = 0; i < size; i++) forkWorker(i, 'started');

    cluster.on('listening', onListening);
    cluster.on('exit', onExit);

    // Master process callback
    for (const member of this.memberList()) this.called(member);
  }
}
