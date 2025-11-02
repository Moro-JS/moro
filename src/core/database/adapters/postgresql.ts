// Database PostgreSQL Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { resolveUserPackage } from '../../utilities/package-utils.js';

interface PostgreSQLConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  connectionLimit?: number;
  ssl?:
    | {
        rejectUnauthorized?: boolean;
        ca?: string;
        cert?: string;
        key?: string;
        passphrase?: string;
        servername?: string;
        checkServerIdentity?: boolean;
      }
    | boolean;
}

export class PostgreSQLAdapter implements DatabaseAdapter {
  private pool: any;
  private logger = createFrameworkLogger('PostgreSQL');
  private initPromise: Promise<void>;

  constructor(config: PostgreSQLConfig) {
    this.initPromise = this.initialize(config);
  }

  private async initialize(config: PostgreSQLConfig): Promise<void> {
    try {
      const pgPath = resolveUserPackage('pg');
      const pg = await import(pgPath);
      const { Pool } = pg.default;
      this.pool = new Pool({
        host: config.host || 'localhost',
        port: config.port || 5432,
        user: config.user || 'postgres',
        password: config.password || '',
        database: config.database || 'moro_app',
        max: config.connectionLimit || 10,
        ssl: typeof config.ssl === 'object' ? { ...config.ssl } : config.ssl || false,
      });

      this.pool.on('error', (err: Error) => {
        this.logger.error('PostgreSQL pool error', 'Pool', {
          error: err.message,
        });
      });

      this.logger.info('PostgreSQL adapter initialized', 'PostgreSQL');
    } catch {
      throw new Error(
        'pg package is required for PostgreSQL adapter. Install it with: npm install pg'
      );
    }
  }

  async connect(): Promise<void> {
    await this.initPromise;
    try {
      const client = await this.pool.connect();
      client.release();
      this.logger.info('PostgreSQL connection established', 'Connection');
    } catch (error) {
      this.logger.error('PostgreSQL connection failed', 'Connection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.initPromise;
    await this.pool.end();
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    await this.initPromise;
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    await this.initPromise;
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await this.pool.query(sql, values);

    return result.rows[0] as T;
  }

  async update<T = any>(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    await this.initPromise;
    const dataKeys = Object.keys(data);
    const dataValues = Object.values(data);
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);

    const setClause = dataKeys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    const whereClause = whereKeys
      .map((key, index) => `${key} = $${dataKeys.length + index + 1}`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
    const params = [...dataValues, ...whereValues];

    const result = await this.pool.query(sql, params);
    return result.rows[0] as T;
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    await this.initPromise;
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClause = whereKeys.map((key, index) => `${key} = $${index + 1}`).join(' AND ');

    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
    const result = await this.pool.query(sql, whereValues);

    return result.rowCount || 0;
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    await this.initPromise;
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const transaction = new PostgreSQLTransaction(client);
      const result = await callback(transaction);

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgreSQLTransaction implements DatabaseTransaction {
  constructor(private client: any) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const result = await this.client.query(sql, params);
    return result.rows as T[];
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
    const result = await this.client.query(sql, values);

    return result.rows[0] as T;
  }

  async update<T = any>(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    const dataKeys = Object.keys(data);
    const dataValues = Object.values(data);
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);

    const setClause = dataKeys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    const whereClause = whereKeys
      .map((key, index) => `${key} = $${dataKeys.length + index + 1}`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
    const params = [...dataValues, ...whereValues];

    const result = await this.client.query(sql, params);
    return result.rows[0] as T;
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClause = whereKeys.map((key, index) => `${key} = $${index + 1}`).join(' AND ');

    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
    const result = await this.client.query(sql, whereValues);

    return result.rowCount || 0;
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK');
  }
}
