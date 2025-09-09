import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
interface MySQLConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionLimit?: number;
}
export declare class MySQLAdapter implements DatabaseAdapter {
  private pool;
  private logger;
  constructor(config: MySQLConfig);
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
