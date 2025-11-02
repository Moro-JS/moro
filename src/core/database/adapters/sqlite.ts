// Database SQLite Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { resolveUserPackage } from '../../utilities/package-utils.js';

interface SQLiteConfig {
  filename?: string;
  memory?: boolean;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: boolean;
}

export class SQLiteAdapter implements DatabaseAdapter {
  private db: any;
  private logger = createFrameworkLogger('SQLite');
  private initPromise: Promise<void>;

  constructor(config: SQLiteConfig = {}) {
    this.initPromise = this.initialize(config);
  }

  private async initialize(config: SQLiteConfig): Promise<void> {
    try {
      const sqlite3Path = resolveUserPackage('better-sqlite3');
      const betterSqlite3 = await import(sqlite3Path);
      const Database = betterSqlite3.default;
      const filename = config.memory ? ':memory:' : config.filename || 'moro_app.db';
      this.db = new Database(filename, {
        readonly: config.readonly || false,
        fileMustExist: config.fileMustExist || false,
        timeout: config.timeout || 5000,
        verbose: config.verbose ? this.logger.debug.bind(this.logger) : undefined,
      });

      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');

      this.logger.info('SQLite connection established', 'Connection', {
        filename,
      });
    } catch {
      throw new Error(
        'better-sqlite3 package is required for SQLite adapter. Install it with: npm install better-sqlite3'
      );
    }
  }

  async connect(): Promise<void> {
    await this.initPromise;
    // SQLite doesn't require explicit connection - it's handled in constructor
    this.logger.info('SQLite adapter ready', 'Connection');
  }

  async disconnect(): Promise<void> {
    await this.initPromise;
    this.db.close();
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    await this.initPromise;
    try {
      const stmt = this.db.prepare(sql);
      const results = stmt.all(params || []);
      return results as T[];
    } catch (error) {
      this.logger.error('SQLite query failed', 'Query', {
        sql,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    await this.initPromise;
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.get(params || []);
      return (result as T) || null;
    } catch (error) {
      this.logger.error('SQLite queryOne failed', 'Query', {
        sql,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    await this.initPromise;
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;

    try {
      const stmt = this.db.prepare(sql);
      const info = stmt.run(values);

      // Return the inserted record
      const insertedRecord = await this.queryOne<T>(`SELECT * FROM ${table} WHERE rowid = ?`, [
        info.lastInsertRowid,
      ]);

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return insertedRecord!;
    } catch (error) {
      this.logger.error('SQLite insert failed', 'Insert', {
        table,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async update<T = any>(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    await this.initPromise;
    const setClause = Object.keys(data)
      .map(key => `${key} = ?`)
      .join(', ');
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const params = [...Object.values(data), ...Object.values(where)];

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(params);

      // Return the updated record
      const updatedRecord = await this.queryOne<T>(
        `SELECT * FROM ${table} WHERE ${whereClause}`,
        Object.values(where)
      );

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return updatedRecord!;
    } catch (error) {
      this.logger.error('SQLite update failed', 'Update', {
        table,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    await this.initPromise;
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;

    try {
      const stmt = this.db.prepare(sql);
      const info = stmt.run(Object.values(where));
      return info.changes;
    } catch (error) {
      this.logger.error('SQLite delete failed', 'Delete', {
        table,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    await this.initPromise;
    const transaction = this.db.transaction(async () => {
      const tx = new SQLiteTransaction(this.db);
      return await callback(tx);
    });

    return transaction();
  }
}

class SQLiteTransaction implements DatabaseTransaction {
  constructor(private db: any) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const results = stmt.all(params || []);
    return results as T[];
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const result = stmt.get(params || []);
    return (result as T) || null;
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const info = stmt.run(values);

    const insertedRecord = await this.queryOne<T>(`SELECT * FROM ${table} WHERE rowid = ?`, [
      info.lastInsertRowid,
    ]);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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

    const stmt = this.db.prepare(sql);
    stmt.run(params);

    const updatedRecord = await this.queryOne<T>(
      `SELECT * FROM ${table} WHERE ${whereClause}`,
      Object.values(where)
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return updatedRecord!;
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    const whereClause = Object.keys(where)
      .map(key => `${key} = ?`)
      .join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;

    const stmt = this.db.prepare(sql);
    const info = stmt.run(Object.values(where));
    return info.changes;
  }

  async commit(): Promise<void> {
    // SQLite transactions are handled automatically by better-sqlite3
    // This is just for interface compatibility
  }

  async rollback(): Promise<void> {
    // SQLite transactions are handled automatically by better-sqlite3
    // This is just for interface compatibility
    throw new Error('Transaction rollback');
  }
}
