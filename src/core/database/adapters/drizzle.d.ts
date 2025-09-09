import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
interface DrizzleConfig {
  database: any;
  schema?: any;
  logger?: boolean;
}
export declare class DrizzleAdapter implements DatabaseAdapter {
  private db;
  private schema;
  private logger;
  constructor(config: DrizzleConfig);
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  insert<T = any>(table: string, data: Record<string, any>): Promise<T>;
  update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<T>;
  delete(table: string, where: Record<string, any>): Promise<number>;
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
  select(table?: string): any;
  insertInto(table: string): any;
  updateTable(table: string): any;
  deleteFrom(table: string): any;
  getSchema(): any;
  getDb(): any;
  getTableNames(): string[];
  hasTable(tableName: string): boolean;
}
export {};
