// Database SQLite Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { importDriver } from './driver-support.js';
import {
  quoteIdentifier as qi,
  quoteColumns,
  buildSetClause,
  buildWhereClause,
} from './sql-safety.js';

interface SQLiteConfig {
  filename?: string;
  memory?: boolean;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: boolean;
}

/**
 * Run a prepared statement and return its rows. better-sqlite3 only lets
 * all()/get() run a statement that returns data (`stmt.reader`); anything
 * else (CREATE, UPDATE, DELETE, INSERT without RETURNING) has to go through
 * run() and has no rows.
 */
function allRows<T>(db: any, sql: string, params?: any[]): T[] {
  const stmt = db.prepare(sql);
  if (stmt.reader) return stmt.all(params || []) as T[];
  stmt.run(params || []);
  return [];
}

function firstRow<T>(db: any, sql: string, params?: any[]): T | null {
  const stmt = db.prepare(sql);
  if (stmt.reader) return (stmt.get(params || []) as T) || null;
  stmt.run(params || []);
  return null;
}

export class SQLiteAdapter implements DatabaseAdapter {
  private db: any;
  private logger = createFrameworkLogger('SQLite');
  private initPromise: Promise<void>;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  constructor(config: SQLiteConfig = {}) {
    this.initPromise = this.initialize(config);
  }

  private async initialize(config: SQLiteConfig): Promise<void> {
    const betterSqlite3 = await importDriver(
      'better-sqlite3',
      'better-sqlite3 package is required for SQLite adapter. Install it with: npm install better-sqlite3'
    );
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

  async getDatabase() {
    await this.initPromise;
    return this.db;
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    await this.initPromise;
    try {
      return allRows<T>(this.db, sql, params);
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
      return firstRow<T>(this.db, sql, params);
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

    const sql = `INSERT INTO ${qi(table)} (${quoteColumns(keys, qi)}) VALUES (${placeholders})`;

    try {
      const stmt = this.db.prepare(sql);
      const info = stmt.run(values);

      // Return the inserted record
      const insertedRecord = await this.queryOne<T>(`SELECT * FROM ${qi(table)} WHERE rowid = ?`, [
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
    const setClause = buildSetClause(Object.keys(data), qi);
    const whereClause = buildWhereClause(Object.keys(where), qi);

    const sql = `UPDATE ${qi(table)} SET ${setClause} WHERE ${whereClause}`;
    const params = [...Object.values(data), ...Object.values(where)];

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(params);

      // Return the updated record
      const updatedRecord = await this.queryOne<T>(
        `SELECT * FROM ${qi(table)} WHERE ${whereClause}`,
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
    const whereClause = buildWhereClause(Object.keys(where), qi);
    const sql = `DELETE FROM ${qi(table)} WHERE ${whereClause}`;

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
    // better-sqlite3's own transaction() only takes a synchronous function
    // and the callback here is async, so the transaction is opened and closed
    // with statements. There is one connection: transactions run one after
    // another, each waiting for the previous one to commit or roll back.
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN');
      try {
        const result = await callback(new SQLiteTransaction(this.db));
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    };
    const result = this.transactionQueue.then(run, run);
    this.transactionQueue = result.catch(() => undefined);
    return result;
  }
}

class SQLiteTransaction implements DatabaseTransaction {
  constructor(private db: any) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    return allRows<T>(this.db, sql, params);
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    return firstRow<T>(this.db, sql, params);
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');

    const sql = `INSERT INTO ${qi(table)} (${quoteColumns(keys, qi)}) VALUES (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const info = stmt.run(values);

    const insertedRecord = await this.queryOne<T>(`SELECT * FROM ${qi(table)} WHERE rowid = ?`, [
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
    const setClause = buildSetClause(Object.keys(data), qi);
    const whereClause = buildWhereClause(Object.keys(where), qi);

    const sql = `UPDATE ${qi(table)} SET ${setClause} WHERE ${whereClause}`;
    const params = [...Object.values(data), ...Object.values(where)];

    const stmt = this.db.prepare(sql);
    stmt.run(params);

    const updatedRecord = await this.queryOne<T>(
      `SELECT * FROM ${qi(table)} WHERE ${whereClause}`,
      Object.values(where)
    );

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return updatedRecord!;
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    const whereClause = buildWhereClause(Object.keys(where), qi);
    const sql = `DELETE FROM ${qi(table)} WHERE ${whereClause}`;

    const stmt = this.db.prepare(sql);
    const info = stmt.run(Object.values(where));
    return info.changes;
  }

  async commit(): Promise<void> {
    // The adapter commits when the transaction callback resolves
    // This is just for interface compatibility
  }

  async rollback(): Promise<void> {
    // The adapter rolls back when the transaction callback throws
    throw new Error('Transaction rollback');
  }
}
