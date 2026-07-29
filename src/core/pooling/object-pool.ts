// Generic Object Pool
// Reuses objects to avoid allocation/GC pressure on hot paths.

/**
 * Generic object pool for reusable objects
 *
 * @example
 * ```ts
 * import { ObjectPool } from '@morojs/moro';
 *
 * const pool = new ObjectPool(() => ({}), 100, obj => {
 *   for (const key in obj) delete obj[key];
 * });
 * const obj = pool.acquire();
 * // ... use obj ...
 * pool.release(obj);
 * ```
 */
export class ObjectPool<T> {
  private pool: T[] = [];
  private readonly factory: () => T;
  private readonly reset?: ((obj: T) => void) | undefined;
  private maxSize: number;
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

  /**
   * Adjust the pool's capacity. Shrinking drops surplus pooled objects
   * immediately (they are left for garbage collection).
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = Math.max(0, Math.floor(maxSize));
    if (this.pool.length > this.maxSize) {
      this.pool.length = this.maxSize;
    }
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
