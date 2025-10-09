// Cache Adapters
export { MemoryCacheAdapter } from './memory.js';
export { RedisCacheAdapter } from './redis.js';
export { FileCacheAdapter } from './file.js';

import { MemoryCacheAdapter } from './memory.js';
import { RedisCacheAdapter } from './redis.js';
import { FileCacheAdapter } from './file.js';
import { CacheAdapter } from '../../../../../types/cache.js';

// Adapter factory function for auto-loading
export function createCacheAdapter(type: string, options: any = {}): CacheAdapter {
  switch (type.toLowerCase()) {
    case 'memory':
      return new MemoryCacheAdapter();
    case 'redis':
      return new RedisCacheAdapter(options);
    case 'file':
      return new FileCacheAdapter(options);
    default:
      throw new Error(`Unknown cache adapter type: ${type}`);
  }
}
