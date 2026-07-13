// Production-grade Leader Election for Distributed Job Scheduling
// Supports file-based and Redis-based locking for K8s and clustered environments

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { Logger } from '../../types/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import cluster from 'cluster';
import { isMainThread } from 'worker_threads';

export interface LeaderElectionOptions {
  strategy: 'file' | 'redis' | 'none';
  lockPath?: string;
  lockTimeout?: number;
  heartbeatInterval?: number;
  redisClient?: any; // Optional Redis client
  forceLeader?: boolean; // Force this instance to be leader (dev/testing)
  instanceId?: string; // Custom instance ID
}

export interface LeaderInfo {
  instanceId: string;
  hostname: string;
  pid: number;
  electedAt: Date;
  lastHeartbeat: Date;
  metadata?: Record<string, any>;
}

/**
 * LeaderElection - Ensures only one job scheduler runs across distributed instances
 * Supports:
 * - File-based locking (for local/NFS environments)
 * - Redis-based locking (for distributed systems)
 * - Kubernetes pod detection
 * - Automatic failover with health checks
 */
export class LeaderElection extends EventEmitter {
  private isLeader = false;
  private strategy: 'file' | 'redis' | 'none';
  private lockPath?: string;
  private lockTimeout: number;
  private heartbeatInterval: number;
  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private checkTimer?: NodeJS.Timeout | undefined;
  private logger: Logger;
  private loggerContext = 'LeaderElection';
  private instanceId: string;
  private leaderInfo?: LeaderInfo;
  private redisClient?: any;
  private isShuttingDown = false;
  private lockAcquireAttempts = 0;

  private static readonly REDIS_LOCK_KEY = 'moro:jobs:leader:lock';

  // Compare-and-refresh: rewrite the value and extend the TTL only if the stored
  // lock still belongs to this instance (ownership is fenced by instanceId).
  private static readonly REDIS_REFRESH_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, decoded = pcall(cjson.decode, cur)
if ok and decoded['instanceId'] == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;

  // Compare-and-delete: release the lock only if it still belongs to this instance.
  private static readonly REDIS_RELEASE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, decoded = pcall(cjson.decode, cur)
if ok and decoded['instanceId'] == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

  constructor(logger: Logger, options: LeaderElectionOptions = { strategy: 'file' }) {
    super();
    this.logger = logger;
    this.strategy = options.strategy;
    this.lockTimeout = options.lockTimeout ?? 30000; // 30s default
    this.heartbeatInterval = options.heartbeatInterval ?? 10000; // 10s default
    this.redisClient = options.redisClient;

    // Generate unique instance ID
    this.instanceId =
      options.instanceId ||
      `${os.hostname()}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    // Setup lock path for file-based strategy
    if (this.strategy === 'file') {
      if (options.lockPath) {
        this.lockPath = options.lockPath;
      } else {
        const tmpDir = os.tmpdir();
        this.lockPath = path.join(tmpDir, 'moro-jobs-leader.lock');
      }
    }

    // Force leader mode (for dev/testing)
    if (options.forceLeader) {
      this.isLeader = true;
      this.logger.warn('Leader election forced - running as leader');
    }

    this.logger.debug('LeaderElection initialized', this.loggerContext, {
      strategy: this.strategy,
      instanceId: this.instanceId,
      lockPath: this.lockPath,
      forceLeader: options.forceLeader,
    });
  }

  /**
   * Start leader election process
   */
  public async start(): Promise<void> {
    if (this.strategy === 'none') {
      this.logger.debug('Leader election disabled, assuming leader role');
      this.becomeLeader();
      return;
    }

    // Check if we should participate in leader election
    if (!this.shouldParticipate()) {
      this.logger.info('Not participating in leader election (worker process/thread)');
      return;
    }

    this.logger.info('Starting leader election...', this.loggerContext, {
      strategy: this.strategy,
      instanceId: this.instanceId,
    });

    // Try to acquire leadership
    await this.tryAcquireLeadership();

    // Start periodic checks
    this.startPeriodicCheck();
  }

  /**
   * Check if this process should participate in leader election
   */
  private shouldParticipate(): boolean {
    // Only main thread and primary cluster process can be leader
    if (!isMainThread) {
      return false;
    }

    if (cluster.isWorker) {
      return false;
    }

    return true;
  }

  /**
   * Try to acquire leadership
   */
  private async tryAcquireLeadership(): Promise<boolean> {
    if (this.isShuttingDown) {
      return false;
    }

    this.lockAcquireAttempts++;

    try {
      let acquired = false;

      if (this.strategy === 'file') {
        acquired = await this.tryAcquireFileLock();
      } else if (this.strategy === 'redis') {
        acquired = await this.tryAcquireRedisLock();
      }

      if (acquired) {
        this.becomeLeader();
        return true;
      } else {
        // Check if current leader is still alive
        await this.checkLeaderHealth();
        return false;
      }
    } catch (error) {
      this.logger.error('Error during leader election', this.loggerContext, {
        error,
        attempt: this.lockAcquireAttempts,
      });
      return false;
    }
  }

  /**
   * Try to acquire file-based lock
   *
   * Uses O_EXCL (open flag 'wx') for the common "no lock yet" case so exactly one
   * instance can win the create race. An expired lock is taken over via an atomic
   * temp-write + rename. A takeover race between two instances is a last-writer-wins
   * rename, which is then reconciled by the periodic verifyLeadership() check and the
   * ownership-checked heartbeat below, so a single leader is still guaranteed.
   */
  private async tryAcquireFileLock(): Promise<boolean> {
    if (!this.lockPath) {
      throw new Error('Lock path not configured');
    }

    const lockInfo: LeaderInfo = {
      instanceId: this.instanceId,
      hostname: os.hostname(),
      pid: process.pid,
      electedAt: new Date(),
      lastHeartbeat: new Date(),
      metadata: this.getInstanceMetadata(),
    };
    const serialized = JSON.stringify(lockInfo);

    // Fast path: atomically create the lock file (O_EXCL). Fails with EEXIST if
    // another instance already holds the lock.
    try {
      const handle = await fs.promises.open(this.lockPath, 'wx');
      try {
        await handle.writeFile(serialized, 'utf-8');
      } finally {
        await handle.close();
      }
      this.leaderInfo = lockInfo;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        this.logger.error('Failed to acquire file lock', this.loggerContext, {
          error,
          lockPath: this.lockPath,
        });
        return false;
      }
      // Lock file already exists — fall through to the expiry/takeover check.
    }

    try {
      // Read existing lock and decide whether we may take it over.
      const lockData = await fs.promises.readFile(this.lockPath, 'utf-8');
      const existingLeader: LeaderInfo = JSON.parse(lockData);

      const lockAge = Date.now() - new Date(existingLeader.lastHeartbeat).getTime();

      if (lockAge < this.lockTimeout) {
        // Lock is still valid and held by another instance.
        this.leaderInfo = existingLeader;
        this.logger.debug('Leader lock held by another instance', this.loggerContext, {
          leader: existingLeader.instanceId,
          age: lockAge,
        });
        return false;
      }

      // Lock expired — take over with an atomic temp-write + rename.
      this.logger.warn('Leader lock expired, taking over', this.loggerContext, {
        previousLeader: existingLeader.instanceId,
        lockAge,
      });

      await this.atomicWriteLock(serialized);
      this.leaderInfo = lockInfo;
      return true;
    } catch (error) {
      this.logger.error('Failed to acquire file lock', this.loggerContext, {
        error,
        lockPath: this.lockPath,
      });
      return false;
    }
  }

  /**
   * Atomically (re)write the lock file: write to a unique temp file, then rename
   * over the target. rename() is atomic on POSIX so readers never see a partial
   * lock file.
   */
  private async atomicWriteLock(serialized: string): Promise<void> {
    if (!this.lockPath) {
      throw new Error('Lock path not configured');
    }

    const tempPath = `${this.lockPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(tempPath, serialized, 'utf-8');
    try {
      await fs.promises.rename(tempPath, this.lockPath);
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Try to acquire Redis-based lock
   */
  private async tryAcquireRedisLock(): Promise<boolean> {
    if (!this.redisClient) {
      throw new Error('Redis client not configured');
    }

    try {
      const lockKey = LeaderElection.REDIS_LOCK_KEY;
      const lockInfo: LeaderInfo = {
        instanceId: this.instanceId,
        hostname: os.hostname(),
        pid: process.pid,
        electedAt: new Date(),
        lastHeartbeat: new Date(),
        metadata: this.getInstanceMetadata(),
      };

      // Try to set lock with NX (only if not exists) and PX (expiration in ms)
      const result = await this.redisClient.set(
        lockKey,
        JSON.stringify(lockInfo),
        'PX',
        this.lockTimeout,
        'NX'
      );

      if (result === 'OK') {
        this.leaderInfo = lockInfo;
        return true;
      }

      // Lock exists, get current leader info
      const existingLock = await this.redisClient.get(lockKey);
      if (existingLock) {
        this.leaderInfo = JSON.parse(existingLock);
      }

      return false;
    } catch (error) {
      this.logger.error('Failed to acquire Redis lock', this.loggerContext, { error });
      return false;
    }
  }

  /**
   * Become leader
   */
  private becomeLeader(): void {
    if (this.isLeader) {
      return;
    }

    this.isLeader = true;
    this.logger.info('Became leader', this.loggerContext, {
      instanceId: this.instanceId,
      strategy: this.strategy,
      attempts: this.lockAcquireAttempts,
    });

    this.emit('leader:elected', {
      instanceId: this.instanceId,
      electedAt: this.leaderInfo?.electedAt,
    });

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Step down as leader
   */
  private async stepDown(): Promise<void> {
    if (!this.isLeader) {
      return;
    }

    this.logger.info('Stepping down as leader', this.loggerContext, {
      instanceId: this.instanceId,
    });

    this.isLeader = false;
    this.stopHeartbeat();

    // Release lock — only if we still own it, so we never delete a lock that
    // another instance has since acquired.
    try {
      if (this.strategy === 'file' && this.lockPath) {
        try {
          const lockData = await fs.promises.readFile(this.lockPath, 'utf-8');
          const currentLeader: LeaderInfo = JSON.parse(lockData);
          if (currentLeader.instanceId === this.instanceId) {
            await fs.promises.unlink(this.lockPath).catch(() => {});
          }
        } catch {
          // Lock file missing or unreadable — nothing to release.
        }
      } else if (this.strategy === 'redis' && this.redisClient) {
        // Compare-and-delete: only DEL if the stored lock still belongs to us.
        await this.redisClient.eval(
          LeaderElection.REDIS_RELEASE_SCRIPT,
          1,
          LeaderElection.REDIS_LOCK_KEY,
          this.instanceId
        );
      }
    } catch (error) {
      this.logger.error('Failed to release lock during step down', this.loggerContext, { error });
    }

    this.emit('leader:stepdown', { instanceId: this.instanceId });
  }

  /**
   * Start heartbeat to maintain leadership
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        if (this.isShuttingDown) {
          return;
        }

        try {
          await this.sendHeartbeat();
        } catch (error) {
          this.logger.error('Heartbeat failed', this.loggerContext, { error });
          // Lost leadership
          await this.stepDown();
          // Try to reacquire
          const retryTimer = setTimeout(() => {
            void this.tryAcquireLeadership();
          }, 1000);
          retryTimer.unref(); // Don't keep process alive
        }
      })();
    }, this.heartbeatInterval);

    // Don't keep process alive
    this.heartbeatTimer.unref();
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * Send heartbeat to maintain lock
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.leaderInfo) {
      return;
    }

    this.leaderInfo.lastHeartbeat = new Date();

    if (this.strategy === 'file' && this.lockPath) {
      // Verify we still own the lock before refreshing it. If the file is gone or
      // now owned by another instance, we have lost leadership — throw so the
      // heartbeat handler steps us down and attempts a clean re-acquire.
      const lockData = await fs.promises.readFile(this.lockPath, 'utf-8');
      const currentLeader: LeaderInfo = JSON.parse(lockData);
      if (currentLeader.instanceId !== this.instanceId) {
        throw new Error('Lost leadership: file lock is owned by another instance');
      }
      await this.atomicWriteLock(JSON.stringify(this.leaderInfo));
    } else if (this.strategy === 'redis' && this.redisClient) {
      // Compare-and-refresh: only rewrite + extend the TTL if we still own the lock.
      const refreshed = await this.redisClient.eval(
        LeaderElection.REDIS_REFRESH_SCRIPT,
        1,
        LeaderElection.REDIS_LOCK_KEY,
        this.instanceId,
        JSON.stringify(this.leaderInfo),
        this.lockTimeout
      );
      if (Number(refreshed) !== 1) {
        throw new Error('Lost leadership: redis lock is no longer owned by this instance');
      }
    }

    this.logger.debug('Heartbeat sent', this.loggerContext, { instanceId: this.instanceId });
    this.emit('leader:heartbeat', {
      instanceId: this.instanceId,
      timestamp: this.leaderInfo.lastHeartbeat,
    });
  }

  /**
   * Start periodic check for leadership changes
   */
  private startPeriodicCheck(): void {
    if (this.checkTimer) {
      return;
    }

    const checkInterval = Math.floor(this.heartbeatInterval * 1.5);

    this.checkTimer = setInterval(() => {
      void (async () => {
        if (this.isShuttingDown) {
          return;
        }

        if (!this.isLeader) {
          // Try to acquire leadership
          await this.tryAcquireLeadership();
        } else {
          // Verify we still hold the lock
          await this.verifyLeadership();
        }
      })();
    }, checkInterval);

    // Don't keep process alive
    this.checkTimer.unref();
  }

  /**
   * Stop periodic check
   */
  private stopPeriodicCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  /**
   * Verify we still hold leadership
   */
  private async verifyLeadership(): Promise<void> {
    if (!this.isLeader) {
      return;
    }

    try {
      let stillLeader = false;

      if (this.strategy === 'file' && this.lockPath) {
        const lockData = await fs.promises.readFile(this.lockPath, 'utf-8');
        const currentLeader: LeaderInfo = JSON.parse(lockData);
        stillLeader = currentLeader.instanceId === this.instanceId;
      } else if (this.strategy === 'redis' && this.redisClient) {
        const lockData = await this.redisClient.get(LeaderElection.REDIS_LOCK_KEY);
        if (lockData) {
          const currentLeader: LeaderInfo = JSON.parse(lockData);
          stillLeader = currentLeader.instanceId === this.instanceId;
        }
      }

      if (!stillLeader) {
        this.logger.warn('Lost leadership', this.loggerContext, { instanceId: this.instanceId });
        await this.stepDown();
      }
    } catch (error) {
      this.logger.error('Failed to verify leadership', this.loggerContext, { error });
      await this.stepDown();
    }
  }

  /**
   * Check health of current leader
   */
  private async checkLeaderHealth(): Promise<void> {
    if (!this.leaderInfo || this.leaderInfo.instanceId === this.instanceId) {
      return;
    }

    const heartbeatAge = Date.now() - new Date(this.leaderInfo.lastHeartbeat).getTime();

    if (heartbeatAge > this.lockTimeout) {
      this.logger.warn('Current leader appears unhealthy', this.loggerContext, {
        leader: this.leaderInfo.instanceId,
        heartbeatAge,
      });

      this.emit('leader:unhealthy', {
        leader: this.leaderInfo.instanceId,
        heartbeatAge,
      });
    }
  }

  /**
   * Get instance metadata
   */
  private getInstanceMetadata(): Record<string, any> {
    const metadata: Record<string, any> = {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
    };

    // K8s detection
    if (process.env.KUBERNETES_SERVICE_HOST) {
      metadata.kubernetes = {
        podName: process.env.HOSTNAME || os.hostname(),
        namespace: process.env.POD_NAMESPACE,
        nodeName: process.env.NODE_NAME,
      };
    }

    // Container detection
    if (process.env.CONTAINER) {
      metadata.container = process.env.CONTAINER;
    }

    return metadata;
  }

  /**
   * Check if current instance is leader
   */
  public isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Get current leader info
   */
  public getLeaderInfo(): LeaderInfo | undefined {
    return this.leaderInfo ? { ...this.leaderInfo } : undefined;
  }

  /**
   * Get instance ID
   */
  public getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Force step down (for testing/admin)
   */
  public async forceStepDown(): Promise<void> {
    if (!this.isLeader) {
      return;
    }

    this.logger.warn('Forced step down requested', this.loggerContext, {
      instanceId: this.instanceId,
    });
    await this.stepDown();
  }

  /**
   * Shutdown and cleanup
   */
  public async shutdown(): Promise<void> {
    this.logger.info('LeaderElection shutting down...', this.loggerContext, {
      instanceId: this.instanceId,
      wasLeader: this.isLeader,
    });

    this.isShuttingDown = true;

    this.stopHeartbeat();
    this.stopPeriodicCheck();

    if (this.isLeader) {
      await this.stepDown();
    }

    this.removeAllListeners();
    this.logger.info('LeaderElection shutdown complete');
  }
}
