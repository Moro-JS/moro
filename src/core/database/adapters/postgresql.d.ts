import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
interface PostgreSQLConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionLimit?: number;
  ssl?: boolean;
}
export declare class PostgreSQLAdapter implements DatabaseAdapter {
  private pool;
  private logger;
  constructor(config: PostgreSQLConfig);
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
