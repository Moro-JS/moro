export interface CacheAdapter {
  get(key: string): Promise<any>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
}
export interface CacheStrategy {
  key: (req: any) => string;
  ttl: number;
  condition?: (req: any, res: any) => boolean;
  invalidateOn?: string[];
}
export interface CacheOptions {
  adapter?: string | CacheAdapter;
  adapterOptions?: any;
  strategies?: {
    [pattern: string]: CacheStrategy;
  };
  defaultTtl?: number;
  keyPrefix?: string;
  maxAge?: number;
  staleWhileRevalidate?: number;
  vary?: string[];
  etag?: boolean | 'weak' | 'strong';
}
export interface CachedResponse {
  body: any;
  status: number;
  headers: Record<string, any>;
  contentType?: string;
  timestamp: number;
}
