export { MemoryCacheAdapter } from './memory';
export { RedisCacheAdapter } from './redis';
export { FileCacheAdapter } from './file';
import { CacheAdapter } from '../../../../../types/cache';
export declare function createCacheAdapter(type: string, options?: any): CacheAdapter;
