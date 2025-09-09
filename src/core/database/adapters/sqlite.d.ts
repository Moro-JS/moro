import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
interface SQLiteConfig {
  filename?: string;
  memory?: boolean;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: boolean;
}
export declare class SQLiteAdapter implements DatabaseAdapter {
  private db;
  private logger;
  constructor(config?: SQLiteConfig);
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  insert<T = any>(table: string, data: Record<string, any>): Promise<T>;
  update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<T>;
  delete(table: string, where: Record<string, any>): Promise<number>;
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
}
export {};
