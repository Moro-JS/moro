// Unified Object Pool Manager
// Consolidates object pooling from http-server, router, and other components

import { createFrameworkLogger } from '../logger/index.js';
import * as crypto from 'crypto';
const logger = createFrameworkLogger('ObjectPoolManager');

/**
 * Generic object pool for reusable objects
 */
class ObjectPool<T> {
  private pool: T[] = [];
  private readonly factory: () => T;
  private readonly reset?: (obj: T) => void;
  private readonly maxSize: number;
  private acquireCount = 0;
  private releaseCount = 0;
  private createCount = 0;

  constructor(factory: () => T, maxSize: number = 100, reset?: (obj: T) => void) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.reset = reset;
  }

  acquire(): T {
    this.acquireCount++;

    if (this.pool.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.pool.pop()!;
    }

    this.createCount++;
    return this.factory();
  }

  release(obj: T): void {
    if (this.pool.length >= this.maxSize) {
      return; // Pool is full, let it be garbage collected
    }

    this.releaseCount++;

    // Reset object if reset function provided
    if (this.reset) {
      this.reset(obj);
    }

    this.pool.push(obj);
  }

  get size(): number {
    return this.pool.length;
  }

  get stats() {
    return {
      poolSize: this.pool.length,
      maxSize: this.maxSize,
      acquireCount: this.acquireCount,
      releaseCount: this.releaseCount,
      createCount: this.createCount,
      utilization: this.maxSize > 0 ? this.pool.length / this.maxSize : 0,
    };
  }

  clear(): void {
    this.pool = [];
  }
}

/**
 * LRU Cache for route lookups
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 500) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.hits++;
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    this.misses++;
    return undefined;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.cache.size;
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

/**
 * ObjectPoolManager - Singleton for managing all object pools
 * Consolidates pools from:
 * - MoroHttpServer (paramObjectPool, bufferPool)
 * - Router (paramObjectPool)
 * - Various route caches
 */
export class ObjectPoolManager {
  private static instance: ObjectPoolManager | null = null;

  // Parameter object pool (for route params)
  private paramPool: ObjectPool<Record<string, string>>;

  // Header object pool (for parsed headers)
  private headerPool: ObjectPool<Record<string, string>>;

  // Query object pool (for parsed query strings)
  private queryPool: ObjectPool<Record<string, string>>;

  // Buffer pools by size
  private bufferPools: Map<number, ObjectPool<Buffer>>;
  private readonly bufferSizes = [64, 256, 1024, 4096, 16384];

  // Route lookup cache
  private routeCache: LRUCache<string, any>;

  // Response cache (for common responses - now includes full response metadata)
  private responseCache: LRUCache<
    string,
    { buffer: Buffer; headers: Record<string, string>; statusCode: number }
  >;

  // Performance monitoring
  private performanceStats = {
    poolHits: 0,
    poolMisses: 0,
    totalAcquisitions: 0,
    totalReleases: 0,
    lastAdjustment: 0,
    adjustmentInterval: 60000, // 1 minute
  };

  // Adaptive pool sizing
  private poolUsageHistory: Map<string, number[]> = new Map();
  private adaptiveMode = true;

  private constructor() {
    // Set initial last adjustment time to prevent immediate adjustment
    this.performanceStats.lastAdjustment = Date.now();

    // Initialize parameter object pool with adaptive sizing
    this.paramPool = new ObjectPool(
      () => ({}),
      100, // Initial size
      (obj: Record<string, string>) => {
        // Clear all properties
        for (const key in obj) {
          delete obj[key];
        }
      }
    );

    // Initialize header object pool
    this.headerPool = new ObjectPool(
      () => ({}),
      50, // Initial size - headers are less common to pool
      (obj: Record<string, string>) => {
        // Clear all properties
        for (const key in obj) {
          delete obj[key];
        }
      }
    );

    // Initialize query object pool
    this.queryPool = new ObjectPool(
      () => ({}),
      100, // Initial size - queries are very common
      (obj: Record<string, string>) => {
        // Clear all properties
        for (const key in obj) {
          delete obj[key];
        }
      }
    );

    // Initialize buffer pools with enhanced sizing
    this.bufferPools = new Map();
    const bufferSizesLen = this.bufferSizes.length;
    for (let i = 0; i < bufferSizesLen; i++) {
      const size = this.bufferSizes[i];
      this.bufferPools.set(
        size,
        new ObjectPool<Buffer>(() => Buffer.allocUnsafe(size), this.getOptimalPoolSize(size))
      );
    }

    // Initialize caches with enhanced statistics
    this.routeCache = new LRUCache(500);
    this.responseCache = new LRUCache(200); // Increased for full response caching

    // Pre-warm pools with optimal defaults
    this.preWarmPools();

    logger.debug(
      'ObjectPoolManager initialized with enhanced performance features',
      'Initialization'
    );
  }

  /**
   * Pre-warm pools with optimal sizes for better startup performance
   * Can be called with custom sizes to override defaults
   */
  preWarmPools(sizes?: {
    params?: number;
    query?: number;
    headers?: number;
    buffers?: Record<number, number>;
  }): void {
    // Aggressive pre-warming for common scenarios
    const paramSize = sizes?.params ?? 50; // More aggressive default
    const querySize = sizes?.query ?? 50;
    const headerSize = sizes?.headers ?? 10;

    // Pre-warm parameter pool
    for (let i = 0; i < paramSize; i++) {
      const obj = this.paramPool.acquire();
      this.paramPool.release(obj);
    }

    // Pre-warm query pool
    for (let i = 0; i < querySize; i++) {
      const obj = this.queryPool.acquire();
      this.queryPool.release(obj);
    }

    // Pre-warm header pool
    for (let i = 0; i < headerSize; i++) {
      const obj = this.headerPool.acquire();
      this.headerPool.release(obj);
    }

    // Pre-warm buffer pools with configurable sizes
    const bufferSizes = sizes?.buffers ?? {};
    const bufferSizesLen = this.bufferSizes.length;
    for (let i = 0; i < bufferSizesLen; i++) {
      const size = this.bufferSizes[i];
      const pool = this.bufferPools.get(size);
      if (pool) {
        const warmCount = bufferSizes[size] ?? Math.min(25, pool.stats.maxSize);
        for (let j = 0; j < warmCount; j++) {
          const buffer = pool.acquire();
          pool.release(buffer);
        }
      }
    }

    logger.debug('Object pools pre-warmed with optimal sizes', 'PoolManager', {
      params: paramSize,
      query: querySize,
      headers: headerSize,
    });
  }

  /**
   * Get optimal pool size based on buffer size and usage patterns
   */
  private getOptimalPoolSize(bufferSize: number): number {
    // Smaller buffers can have larger pools
    if (bufferSize <= 256) return 100;
    if (bufferSize <= 1024) return 75;
    if (bufferSize <= 4096) return 50;
    return 25; // Large buffers need smaller pools
  }

  static getInstance(): ObjectPoolManager {
    if (!this.instance) {
      this.instance = new ObjectPoolManager();
    }
    return this.instance;
  }

  /**
   * Reset the singleton (useful for testing)
   */
  static reset(): void {
    if (this.instance) {
      this.instance.clearAll();
    }
    this.instance = null;
  }

  // Parameter Object Pool

  acquireParams(): Record<string, string> {
    this.performanceStats.totalAcquisitions++;
    const obj = this.paramPool.acquire();

    if (this.poolUsageHistory.has('params')) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const history = this.poolUsageHistory.get('params')!;
      if (history.length >= 100) {
        history.shift(); // Keep only last 100 measurements
      }
      history.push(this.paramPool.size);
    } else {
      this.poolUsageHistory.set('params', [this.paramPool.size]);
    }

    return obj;
  }

  releaseParams(obj: Record<string, string>): void {
    this.performanceStats.totalReleases++;
    this.paramPool.release(obj);

    // Adaptive pool sizing based on usage patterns
    if (
      this.adaptiveMode &&
      Date.now() - this.performanceStats.lastAdjustment > this.performanceStats.adjustmentInterval
    ) {
      this.adjustPoolSizes();
    }
  }

  // Header Object Pool

  acquireHeaders(): Record<string, string> {
    this.performanceStats.totalAcquisitions++;
    return this.headerPool.acquire();
  }

  releaseHeaders(obj: Record<string, string>): void {
    this.performanceStats.totalReleases++;
    this.headerPool.release(obj);
  }

  // Query Object Pool

  acquireQuery(): Record<string, string> {
    this.performanceStats.totalAcquisitions++;
    return this.queryPool.acquire();
  }

  releaseQuery(obj: Record<string, string>): void {
    this.performanceStats.totalReleases++;
    this.queryPool.release(obj);
  }

  // Request ID Generation

  generateRequestId(): string {
    return crypto.randomUUID();
  }

  // Buffer Pool

  acquireBuffer(size: number): Buffer {
    this.performanceStats.totalAcquisitions++;

    // Find smallest buffer that fits
    for (const poolSize of this.bufferSizes) {
      if (size <= poolSize) {
        const pool = this.bufferPools.get(poolSize);
        if (pool) {
          const buffer = pool.acquire();
          this.performanceStats.poolHits++;

          // Track usage for adaptive sizing
          const poolKey = `buffer_${poolSize}`;
          if (this.poolUsageHistory.has(poolKey)) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const history = this.poolUsageHistory.get(poolKey)!;
            if (history.length >= 100) {
              history.shift();
            }
            history.push(pool.size);
          } else {
            this.poolUsageHistory.set(poolKey, [pool.size]);
          }

          return buffer;
        }
      }
    }

    // No pool available for this size, allocate directly
    this.performanceStats.poolMisses++;
    return Buffer.allocUnsafe(size);
  }

  releaseBuffer(buffer: Buffer): void {
    this.performanceStats.totalReleases++;
    const size = buffer.length;
    const pool = this.bufferPools.get(size);
    if (pool) {
      pool.release(buffer);

      // Adaptive pool sizing based on usage patterns
      if (
        this.adaptiveMode &&
        Date.now() - this.performanceStats.lastAdjustment > this.performanceStats.adjustmentInterval
      ) {
        this.adjustPoolSizes();
      }
    }
    // If no pool for this size, let it be garbage collected
  }

  // Route Cache

  getCachedRoute(key: string): any {
    return this.routeCache.get(key);
  }

  cacheRoute(key: string, route: any): void {
    this.routeCache.set(key, route);
  }

  hasCachedRoute(key: string): boolean {
    return this.routeCache.has(key);
  }

  clearRouteCache(): void {
    this.routeCache.clear();
  }

  // Response Cache (For Opt-In Explicit Caching Only)
  // NOTE: This cache is NOT used automatically by the framework.
  // It's available for developers who explicitly want to cache specific responses.
  // Developers must carefully manage cache keys to avoid stale/incorrect data.

  getCachedResponse(
    key: string
  ): { buffer: Buffer; headers: Record<string, string>; statusCode: number } | undefined {
    return this.responseCache.get(key);
  }

  cacheResponse(
    key: string,
    buffer: Buffer,
    headers: Record<string, string>,
    statusCode: number = 200
  ): void {
    // Cache responses up to 4KB
    // WARNING: Only use this for static responses that never change
    if (buffer.length < 4096) {
      this.responseCache.set(key, {
        buffer: Buffer.from(buffer), // Clone to avoid mutations
        headers: { ...headers }, // Clone headers
        statusCode,
      });
    }
  }

  hasCachedResponse(key: string): boolean {
    return this.responseCache.has(key);
  }

  clearResponseCache(): void {
    this.responseCache.clear();
  }

  /**
   * Adaptively adjust pool sizes based on usage patterns
   */
  private adjustPoolSizes(): void {
    this.performanceStats.lastAdjustment = Date.now();

    // Adjust parameter pool size
    const paramHistory = this.poolUsageHistory.get('params') || [];
    if (paramHistory.length >= 10) {
      const avgUsage = paramHistory.reduce((sum, size) => sum + size, 0) / paramHistory.length;
      const targetSize = Math.min(Math.max(Math.round(avgUsage * 1.2), 50), 200); // 20% buffer, 50-200 range

      if (Math.abs(this.paramPool.stats.maxSize - targetSize) > 10) {
        logger.debug(
          `Adjusting param pool size from ${this.paramPool.stats.maxSize} to ${targetSize}`,
          'PoolManager'
        );
        // Note: We can't directly change maxSize, but we can log the recommendation
        // In a real implementation, we'd recreate the pool with the new size
      }
    }

    // Adjust buffer pool sizes
    const bufferSizesLen = this.bufferSizes.length;
    for (let i = 0; i < bufferSizesLen; i++) {
      const size = this.bufferSizes[i];
      const poolKey = `buffer_${size}`;
      const history = this.poolUsageHistory.get(poolKey) || [];
      if (history.length >= 10) {
        const avgUsage = history.reduce((sum, size) => sum + size, 0) / history.length;
        const pool = this.bufferPools.get(size);
        if (pool) {
          const currentMax = pool.stats.maxSize;
          const targetMax = this.getOptimalPoolSize(size);

          if (Math.abs(currentMax - targetMax) > 5) {
            logger.debug(
              `Buffer pool ${size}B: usage ${avgUsage.toFixed(1)}/${currentMax}, target ${targetMax}`,
              'PoolManager'
            );
          }
        }
      }
    }

    logger.debug('Pool size adjustment cycle completed', 'PoolManager');
  }

  /**
   * Enable or disable adaptive pool sizing
   */
  setAdaptiveMode(enabled: boolean): void {
    this.adaptiveMode = enabled;
    logger.debug(`Adaptive pool sizing ${enabled ? 'enabled' : 'disabled'}`, 'PoolManager');
  }

  // Utility Methods

  /**
   * Clear all pools and caches
   */
  clearAll(): void {
    this.paramPool.clear();
    this.headerPool.clear();
    this.queryPool.clear();
    this.bufferPools.forEach(pool => pool.clear());
    this.routeCache.clear();
    this.responseCache.clear();
    logger.debug('All pools and caches cleared', 'Maintenance');
  }

  /**
   * Force garbage collection on pooled objects
   */
  forceCleanup(): void {
    this.clearAll();

    // Force GC if available
    if (globalThis?.gc) {
      globalThis.gc();
      logger.debug('Forced garbage collection', 'Maintenance');
    }
  }

  /**
   * Get comprehensive performance statistics
   */
  getStats() {
    const bufferPoolStats: Record<string, any> = {};
    this.bufferPools.forEach((pool, size) => {
      bufferPoolStats[`${size}B`] = pool.stats;
    });

    return {
      paramPool: this.paramPool.stats,
      headerPool: this.headerPool.stats,
      queryPool: this.queryPool.stats,
      bufferPools: bufferPoolStats,
      routeCache: this.routeCache.stats,
      responseCache: this.responseCache.stats,
      totalMemory: {
        params: this.paramPool.size * 50, // Rough estimate
        headers: this.headerPool.size * 100, // Rough estimate
        queries: this.queryPool.size * 50, // Rough estimate
        buffers: Array.from(this.bufferPools.values()).reduce((sum, pool) => sum + pool.size, 0),
        routes: this.routeCache.size * 200, // Rough estimate
        responses: this.responseCache.size * 1000, // Rough estimate (increased for full responses)
      },
    };
  }

  /**
   * Get performance summary for monitoring
   */
  getPerformanceSummary() {
    const stats = this.getStats();
    const routeCacheTotal = stats.routeCache.hits + stats.routeCache.misses;
    const responseCacheTotal = stats.responseCache.hits + stats.responseCache.misses;

    // Manually sum memory instead of Object.values().reduce()
    let totalMemory = 0;
    totalMemory += stats.totalMemory.params;
    totalMemory += stats.totalMemory.headers;
    totalMemory += stats.totalMemory.queries;
    totalMemory += stats.totalMemory.buffers;
    totalMemory += stats.totalMemory.routes;
    totalMemory += stats.totalMemory.responses;

    return {
      routeCacheHitRate: routeCacheTotal > 0 ? (stats.routeCache.hits / routeCacheTotal) * 100 : 0,
      responseCacheHitRate:
        responseCacheTotal > 0 ? (stats.responseCache.hits / responseCacheTotal) * 100 : 0,
      paramPoolUtilization: stats.paramPool.utilization * 100,
      totalMemoryKB: totalMemory / 1024,
    };
  }

  /**
   * Log performance statistics
   */
  logStats(): void {
    const summary = this.getPerformanceSummary();
    logger.info('ObjectPoolManager Performance', 'Stats', {
      routeCacheHitRate: `${summary.routeCacheHitRate.toFixed(1)}%`,
      responseCacheHitRate: `${summary.responseCacheHitRate.toFixed(1)}%`,
      paramPoolUtilization: `${summary.paramPoolUtilization.toFixed(1)}%`,
      totalMemory: `${summary.totalMemoryKB.toFixed(1)} KB`,
    });
  }
}

/**
 * Convenience function to get the singleton instance
 */
export function getPoolManager(): ObjectPoolManager {
  return ObjectPoolManager.getInstance();
}
