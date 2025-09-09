import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  retryDelayOnFailover?: number;
  lazyConnect?: boolean;
  cluster?: {
    enableReadyCheck?: boolean;
    redisOptions?: any;
    nodes: Array<{
      host: string;
      port: number;
    }>;
  };
}
export declare class RedisAdapter implements DatabaseAdapter {
  private client;
  private logger;
  private keyPrefix;
  constructor(config?: RedisConfig);
  private prefixKey;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T = any>(pattern: string, _params?: any[]): Promise<T[]>;
  queryOne<T = any>(key: string, _params?: any[]): Promise<T | null>;
  insert<T = any>(key: string, data: Record<string, any>): Promise<T>;
  update<T = any>(key: string, data: Record<string, any>, _where?: Record<string, any>): Promise<T>;
  delete(pattern: string, _where?: Record<string, any>): Promise<number>;
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
  set(key: string, value: any, ttl?: number): Promise<void>;
  get(key: string): Promise<any>;
  exists(key: string): Promise<boolean>;
  expire(key: string, ttl: number): Promise<boolean>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  hset(hash: string, field: string, value: any): Promise<void>;
  hget(hash: string, field: string): Promise<any>;
  hgetall(hash: string): Promise<Record<string, any>>;
  lpush(list: string, ...values: any[]): Promise<number>;
  rpop(list: string): Promise<any>;
  lrange(list: string, start: number, stop: number): Promise<any[]>;
  publish(channel: string, message: any): Promise<number>;
  subscribe(channel: string, callback: (message: any) => void): Promise<void>;
  getClient(): any;
}
export {};
