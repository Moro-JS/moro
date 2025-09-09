import { CacheAdapter } from '../../../../../types/cache';
export declare class MemoryCacheAdapter implements CacheAdapter {
  private cache;
  private timers;
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}
