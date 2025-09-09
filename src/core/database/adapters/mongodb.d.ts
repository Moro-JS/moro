import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
interface MongoDBConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  authSource?: string;
  ssl?: boolean;
  replicaSet?: string;
  maxPoolSize?: number;
  minPoolSize?: number;
}
export declare class MongoDBAdapter implements DatabaseAdapter {
  private client;
  private db;
  private logger;
  constructor(config: MongoDBConfig);
  private buildConnectionString;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T = any>(collection: string, pipeline?: any[]): Promise<T[]>;
  queryOne<T = any>(collection: string, query?: any): Promise<T | null>;
  insert<T = any>(collection: string, data: Record<string, any>): Promise<T>;
  update<T = any>(
    collection: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T>;
  delete(collection: string, where: Record<string, any>): Promise<number>;
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
  aggregate<T = any>(collection: string, pipeline: any[]): Promise<T[]>;
  createIndex(collection: string, index: any, options?: any): Promise<string>;
  dropIndex(collection: string, indexName: string): Promise<any>;
  count(collection: string, query?: any): Promise<number>;
  getCollection(name: string): any;
}
export {};
