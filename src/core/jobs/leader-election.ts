// Production-grade Leader Election for Distributed Job Scheduling
// Supports file-based and Redis-based locking for K8s and clustered environments

import { EventEmitter } from 'events';
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
  private heartbeatTimer?: NodeJS.Timeout;
  private checkTimer?: NodeJS.Timeout;
  private logger: Logger;
  private loggerContext = 'LeaderElection';
  private instanceId: string;
  private leaderInfo?: LeaderInfo;
  private redisClient?: any;
  private isShuttingDown = false;
  private lockAcquireAttempts = 0;

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
      `${os.hostname()}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

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
   */
  private async tryAcquireFileLock(): Promise<boolean> {
    if (!this.lockPath) {
      throw new Error('Lock path not configured');
    }

    try {
      // Check if lock file exists
      const exists = await fs.promises
        .access(this.lockPath)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        // Read existing lock
        const lockData = await fs.promises.readFile(this.lockPath, 'utf-8');
        const existingLeader: LeaderInfo = JSON.parse(lockData);

        // Check if lock is expired
        const lockAge = Date.now() - new Date(existingLeader.lastHeartbeat).getTime();

        if (lockAge < this.lockTimeout) {
          // Lock is still valid
          this.leaderInfo = existingLeader;
          this.logger.debug('Leader lock held by another instance', this.loggerContext, {
            leader: existingLeader.instanceId,
            age: lockAge,
          });
          return false;
        }

        // Lock expired, take over
        this.logger.warn('Leader lock expired, taking over', this.loggerContext, {
          previousLeader: existingLeader.instanceId,
          lockAge,
        });
      }

      // Create/update lock file
      const lockInfo: LeaderInfo = {
        instanceId: this.instanceId,
        hostname: os.hostname(),
        pid: process.pid,
        electedAt: new Date(),
        lastHeartbeat: new Date(),
        metadata: this.getInstanceMetadata(),
      };

      await fs.promises.writeFile(this.lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');

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
   * Try to acquire Redis-based lock
   */
  private async tryAcquireRedisLock(): Promise<boolean> {
    if (!this.redisClient) {
      throw new Error('Redis client not configured');
    }

    try {
      const lockKey = 'moro:jobs:leader:lock';
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

    // Release lock
    try {
      if (this.strategy === 'file' && this.lockPath) {
        await fs.promises.unlink(this.lockPath).catch(() => {});
      } else if (this.strategy === 'redis' && this.redisClient) {
        await this.redisClient.del('moro:jobs:leader:lock');
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

    this.heartbeatTimer = setInterval(async () => {
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
        setTimeout(() => this.tryAcquireLeadership(), 1000);
      }
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
      await fs.promises.writeFile(this.lockPath, JSON.stringify(this.leaderInfo, null, 2), 'utf-8');
    } else if (this.strategy === 'redis' && this.redisClient) {
      const lockKey = 'moro:jobs:leader:lock';
      await this.redisClient.set(lockKey, JSON.stringify(this.leaderInfo), 'PX', this.lockTimeout);
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

    this.checkTimer = setInterval(async () => {
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
        const lockData = await this.redisClient.get('moro:jobs:leader:lock');
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
