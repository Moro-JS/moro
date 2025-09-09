// src/types/database.ts
export interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  insert<T = any>(table: string, data: Record<string, any>): Promise<T>;
  update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<T>;
  delete(table: string, where: Record<string, any>): Promise<number>;
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
}

export interface DatabaseTransaction {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  insert<T = any>(table: string, data: Record<string, any>): Promise<T>;
  update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<T>;
  delete(table: string, where: Record<string, any>): Promise<number>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
  acquireTimeout?: number;
  timeout?: number;
}
