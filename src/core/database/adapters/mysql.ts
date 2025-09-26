// Database MySQL Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database';
import { createFrameworkLogger } from '../../logger';

interface MySQLConfig {
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
        ciphers?: string;
        secureProtocol?: string;
      }
    | boolean;
}

export class MySQLAdapter implements DatabaseAdapter {
  private pool: any;
  private logger = createFrameworkLogger('MySQL');

  constructor(config: MySQLConfig) {
    try {
      const mysql = require('mysql2/promise');
      this.pool = mysql.createPool({
        host: config.host || 'localhost',
        port: config.port || 3306,
        user: config.user || 'root',
        password: config.password || '',
        database: config.database || 'moro_app',
        waitForConnections: true,
        connectionLimit: config.connectionLimit || 10,
        queueLimit: 0,
        ssl: typeof config.ssl === 'object' ? { ...config.ssl } : config.ssl || false,
      });
    } catch (error) {
      throw new Error(
        'mysql2 package is required for MySQL adapter. Install it with: npm install mysql2'
      );
    }
  }

  async connect(): Promise<void> {
    try {
      const connection = await this.pool.getConnection();
      connection.release();
      this.logger.info('MySQL connection established', 'Connection');
    } catch (error) {
      this.logger.error('MySQL connection failed', 'Connection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const [rows] = await this.pool.execute(sql, params);
    return rows as T[];
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
    const [result] = (await this.pool.execute(sql, values)) as any;

    // Return the inserted record
    const insertedRecord = await this.queryOne<T>(`SELECT * FROM ${table} WHERE id = ?`, [
      result.insertId,
    ]);

    return insertedRecord!;
  }

  async update<T = any>(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    const setClause = Object.keys(data)
      .map(key => `${key} = ?`)
      .join(', ');
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const params = [...Object.values(data), ...Object.values(where)];

    await this.pool.execute(sql, params);

    // Return the updated record
    const updatedRecord = await this.queryOne<T>(
      `SELECT * FROM ${table} WHERE ${whereClause}`,
      Object.values(where)
    );

    return updatedRecord!;
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;

    const [result] = (await this.pool.execute(sql, Object.values(where))) as any;
    return result.affectedRows;
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();

      const transaction = new MySQLTransaction(connection);
      const result = await callback(transaction);

      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

class MySQLTransaction implements DatabaseTransaction {
  constructor(private connection: any) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const [rows] = await this.connection.execute(sql, params);
    return rows as T[];
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
    const [result] = (await this.connection.execute(sql, values)) as any;

    const insertedRecord = await this.queryOne<T>(`SELECT * FROM ${table} WHERE id = ?`, [
      result.insertId,
    ]);

    return insertedRecord!;
  }

  async update<T = any>(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    const setClause = Object.keys(data)
      .map(key => `${key} = ?`)
      .join(', ');
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const params = [...Object.values(data), ...Object.values(where)];

    await this.connection.execute(sql, params);

    const updatedRecord = await this.queryOne<T>(
      `SELECT * FROM ${table} WHERE ${whereClause}`,
      Object.values(where)
    );

    return updatedRecord!;
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;

    const [result] = (await this.connection.execute(sql, Object.values(where))) as any;
    return result.affectedRows;
  }

  async commit(): Promise<void> {
    await this.connection.commit();
  }

  async rollback(): Promise<void> {
    await this.connection.rollback();
  }
}
