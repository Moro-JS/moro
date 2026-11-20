// Memory Cache Adapter
import { CacheAdapter } from '../../../../../../types/cache.js';
import { createFrameworkLogger } from '../../../../../logger/index.js';
import { keyTag } from './log-key.js';

const logger = createFrameworkLogger('MemoryCacheAdapter');

export interface MemoryCacheAdapterOptions {
  /**
   * Most entries kept at once. Past it, the least recently used entry leaves
   * to make room. Unbounded when omitted: the adapter also backs stores whose
   * entries must not be dropped early (sessions), so the cap is opt-in here
   * and `middleware.cache()` passes its own (10,000 by default).
   */
  maxEntries?: number;
  /**
   * Log a short tag in place of each key. For stores whose keys are secrets:
   * the session middleware sets it on the store it uses, because a session id
   * in a log line is a session anyone reading the log can take over.
   */
  redactKeys?: boolean;
}

export class MemoryCacheAdapter implements CacheAdapter {
  // Insertion order doubles as recency order: a read or a write moves the key
  // to the end, so the first key is always the least recently used one.
  private cache = new Map<string, { value: any; expires: number }>();
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly maxEntries: number;
  /** Log a tag in place of each key (see MemoryCacheAdapterOptions.redactKeys) */
  redactKeys: boolean;

  constructor(options: MemoryCacheAdapterOptions = {}) {
    const max = options?.maxEntries;
    this.maxEntries = typeof max === 'number' && max > 0 ? Math.floor(max) : Infinity;
    this.redactKeys = options?.redactKeys === true;
  }

  /** Entries currently held (expired ones included until they are read or timed out). */
  get size(): number {
    return this.cache.size;
  }

  async get(key: string): Promise<any> {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expires) {
      await this.del(key);
      return null;
    }

    // Mark as recently used (only worth doing when there is a cap to evict by)
    if (this.maxEntries !== Infinity) {
      this.cache.delete(key);
      this.cache.set(key, item);
    }

    return item.value;
  }

  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
    const expires = Date.now() + ttl * 1000;

    // Clear existing timer
    const existingTimer = this.timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new value (re-inserted, so it counts as the most recently used)
    this.cache.delete(key);
    this.cache.set(key, { value, expires });

    // Set expiration timer. unref() so eviction housekeeping never holds the
    // process open — a pending TTL (sessions default to ~24h) must not block
    // shutdown. Entries are also expiry-checked on read, so eviction stays
    // correct even if the process exits and restarts before the timer fires.
    const timer = setTimeout(() => {
      this.cache.delete(key);
      this.timers.delete(key);
    }, ttl * 1000);
    timer.unref?.();

    this.timers.set(key, timer);

    // Over the cap: the least recently used entries make room
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.cache.delete(oldest);
      const oldTimer = this.timers.get(oldest);
      if (oldTimer) {
        clearTimeout(oldTimer);
        this.timers.delete(oldest);
      }
    }

    logger.debug(
      `Cached item: ${this.redactKeys ? keyTag(key) : key} (TTL: ${ttl}s)`,
      'MemoryCache'
    );
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    logger.debug(`Deleted cache item: ${this.redactKeys ? keyTag(key) : key}`, 'MemoryCache');
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    logger.debug('Cleared all cache items', 'MemoryCache');
  }

  async exists(key: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.cache.has(key) && Date.now() <= this.cache.get(key)!.expires;
  }

  async ttl(key: string): Promise<number> {
    const item = this.cache.get(key);
    if (!item) return -1;

    const remaining = Math.floor((item.expires - Date.now()) / 1000);
    return remaining > 0 ? remaining : -1;
  }
}
