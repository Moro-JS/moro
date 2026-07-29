import { describe, it, expect } from '@jest/globals';
import {
  ObjectPool,
  LRUCache,
  ObjectPoolManager,
  WorkerManager,
  getWorkerManager,
  workerTasks,
} from '../../../src/index.js';

describe('Public pooling exports', () => {
  it('ObjectPool acquires, releases, resets, and respects maxSize', () => {
    const created: object[] = [];
    const pool = new ObjectPool<Record<string, string>>(
      () => {
        const obj = {};
        created.push(obj);
        return obj;
      },
      2,
      obj => {
        for (const key in obj) delete obj[key];
      }
    );

    const a = pool.acquire();
    a.dirty = 'yes';
    pool.release(a);
    expect(pool.size).toBe(1);

    const b = pool.acquire();
    expect(b).toBe(a); // reused, not re-created
    expect(b.dirty).toBeUndefined(); // reset ran
    expect(created.length).toBe(1);

    // maxSize 2: releasing a third distinct object beyond capacity is dropped
    pool.release(pool.acquire());
    pool.release({ x: '1' });
    pool.release({ x: '2' });
    expect(pool.size).toBe(2);
    expect(pool.stats.maxSize).toBe(2);
  });

  it('LRUCache evicts least-recently-used and tracks hit rate', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.get('a')).toBe(1); // 'a' is now most recently used
    cache.set('c', 3); // evicts 'b'

    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);

    const stats = cache.stats;
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(0);
    expect(stats.hitRate).toBe(1);
  });

  it('ObjectPoolManager singleton exposes pool and cache stats', () => {
    const manager = ObjectPoolManager.getInstance();
    expect(ObjectPoolManager.getInstance()).toBe(manager);

    const params = manager.acquireParams();
    params.id = '42';
    manager.releaseParams(params);

    const buffer = manager.acquireBuffer(1024);
    expect(buffer.length).toBeGreaterThanOrEqual(1024);
    manager.releaseBuffer(buffer);

    const stats = manager.getStats();
    expect(stats.paramPool.acquireCount).toBeGreaterThan(0);
    expect(stats.routeCache).toBeDefined();
  });
});

describe('Public worker exports', () => {
  // Worker entry is stubbed under jest (no real thread spawning here);
  // real spawning is covered by the dist smoke script.
  it('exports the manager class, singleton accessor, and task helpers', () => {
    expect(typeof WorkerManager).toBe('function');
    expect(typeof getWorkerManager).toBe('function');
    expect(typeof workerTasks.verifyJWT).toBe('function');
    expect(typeof workerTasks.signJWT).toBe('function');
    expect(typeof workerTasks.hash).toBe('function');
    expect(typeof workerTasks.compress).toBe('function');
    expect(typeof workerTasks.decompress).toBe('function');
    expect(typeof workerTasks.heavyComputation).toBe('function');
    expect(typeof workerTasks.transformJSON).toBe('function');
  });
});

describe('Adaptive pool sizing', () => {
  afterEach(() => {
    ObjectPoolManager.reset();
  });

  it('ObjectPool.setMaxSize grows and shrinks capacity', () => {
    const pool = new ObjectPool<Record<string, string>>(() => ({}), 2);
    pool.release({});
    pool.release({});
    expect(pool.size).toBe(2);

    // Shrink: surplus pooled objects are dropped immediately
    pool.setMaxSize(1);
    expect(pool.size).toBe(1);
    expect(pool.stats.maxSize).toBe(1);
    pool.release({});
    expect(pool.size).toBe(1); // capacity enforced

    // Grow: new capacity accepts more objects
    pool.setMaxSize(3);
    pool.release({});
    pool.release({});
    expect(pool.size).toBe(3);
  });

  it('ObjectPoolManager applies usage-based pool resizing', () => {
    ObjectPoolManager.reset();
    const manager = ObjectPoolManager.getInstance();

    // Force an adjustment cycle on the next release: zero interval + seeded
    // usage history averaging 150 → target 150 * 1.2 = 180 (within 50-200).
    // Acquire first — acquireParams() itself appends a usage sample.
    const obj = manager.acquireParams();
    (manager as any).performanceStats.adjustmentInterval = 0;
    (manager as any).performanceStats.lastAdjustment = 0;
    (manager as any).poolUsageHistory.set('params', new Array(20).fill(150));

    manager.releaseParams(obj);

    expect(manager.getStats().paramPool.maxSize).toBe(180);
  });

  it('does not resize when adaptive mode is disabled', () => {
    ObjectPoolManager.reset();
    const manager = ObjectPoolManager.getInstance();
    manager.setAdaptiveMode(false);

    (manager as any).performanceStats.adjustmentInterval = 0;
    (manager as any).performanceStats.lastAdjustment = 0;
    (manager as any).poolUsageHistory.set('params', new Array(20).fill(150));

    const before = manager.getStats().paramPool.maxSize;
    manager.releaseParams(manager.acquireParams());

    expect(manager.getStats().paramPool.maxSize).toBe(before);
  });
});
