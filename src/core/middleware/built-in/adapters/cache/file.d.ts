import { CacheAdapter } from '../../../../../types/cache';
export declare class FileCacheAdapter implements CacheAdapter {
  private cacheDir;
  constructor(options?: { cacheDir?: string });
  private ensureCacheDir;
  private getFilePath;
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}
