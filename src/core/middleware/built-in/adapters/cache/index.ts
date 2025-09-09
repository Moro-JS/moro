// Cache Adapters
export { MemoryCacheAdapter } from './memory';
export { RedisCacheAdapter } from './redis';
export { FileCacheAdapter } from './file';

import { MemoryCacheAdapter } from './memory';
import { RedisCacheAdapter } from './redis';
import { FileCacheAdapter } from './file';
import { CacheAdapter } from '../../../../../types/cache';

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
