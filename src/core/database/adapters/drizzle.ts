// Database Drizzle ORM Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { resolveUserPackage } from '../../utilities/package-utils.js';
import {
  quoteIdentifier as qi,
  quoteColumns,
  buildSetClause,
  buildWhereClause,
} from './sql-safety.js';

// Cache the drizzle-orm module
let drizzleOrm: any = null;
async function getDrizzleOrm() {
  if (!drizzleOrm) {
    const drizzlePath = resolveUserPackage('drizzle-orm');
    const module = await import(drizzlePath);
    drizzleOrm = module;
  }
  return drizzleOrm;
}

/**
 * Refuse an update/delete with no conditions. Drizzle treats `.where(undefined)`
 * as "no WHERE clause", so an empty `where` object would touch every row of the
 * table. The other SQL adapters fail on the same input (the database rejects
 * their statement); this keeps the shared adapter contract fail-closed.
 */
function assertNonEmptyWhere(
  operation: 'update' | 'delete',
  table: string,
  where: Record<string, any>
): void {
  if (!where || typeof where !== 'object' || Object.keys(where).length === 0) {
    throw new Error(
      `Drizzle ${operation} on "${table}" requires a non-empty where object; ` +
        'refusing to affect every row. Use query() for an intentional full-table statement.'
    );
  }
}

/**
 * Where the placeholders of a SQL text are. Quoted strings and identifiers,
 * comments and PostgreSQL dollar-quoted bodies are skipped, so a `$1` or `?`
 * inside one is left alone.
 */
function findPlaceholders(text: string): {
  dollar: Array<{ start: number; end: number; index: number }>;
  question: number[];
} {
  const dollar: Array<{ start: number; end: number; index: number }> = [];
  const question: number[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      // Quoted: runs to the closing quote; a doubled quote is an escaped one
      i++;
      while (i < length) {
        if (text[i] === ch) {
          if (text[i + 1] === ch) i++;
          else break;
        }
        i++;
      }
      i++;
    } else if (ch === '-' && text[i + 1] === '-') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? length : eol + 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? length : close + 2;
    } else if (ch === '$') {
      const numbered = /^\$(\d+)/.exec(text.slice(i, i + 8));
      const tag = numbered ? null : /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 66));
      if (numbered) {
        dollar.push({ start: i, end: i + numbered[0].length, index: Number(numbered[1]) });
        i += numbered[0].length;
      } else if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? length : close + tag[0].length;
      } else {
        i++;
      }
    } else {
      if (ch === '?') question.push(i);
      i++;
    }
  }
  return { dollar, question };
}

/**
 * What to hand to Drizzle's execute() for a SQL text and its parameters.
 *
 * execute() takes one argument, a `sql` object that carries its own
 * parameters; a second argument is ignored. The text is therefore split at
 * its placeholders (`$1`, `$2`, ... or `?`) and rebuilt as a `sql` object with
 * each value bound, which Drizzle then renders in the placeholder style of
 * the database it is connected to. A text with no parameters, or whose
 * placeholders do not line up with them, goes to execute() unchanged.
 */
async function toExecutable(text: string, params?: any[]): Promise<any> {
  if (!params || params.length === 0) return text;

  const { dollar, question } = findPlaceholders(text);
  let slots: Array<{ start: number; end: number; value: any }>;
  if (dollar.length > 0) {
    if (dollar.some(slot => slot.index < 1 || slot.index > params.length)) return text;
    slots = dollar.map(slot => ({
      start: slot.start,
      end: slot.end,
      value: params[slot.index - 1],
    }));
  } else if (question.length > 0 && question.length === params.length) {
    slots = question.map((start, n) => ({ start, end: start + 1, value: params[n] }));
  } else {
    return text;
  }

  const { sql: sqlTag } = await getDrizzleOrm();
  const strings: string[] = [];
  const values: any[] = [];
  let from = 0;
  for (const slot of slots) {
    strings.push(text.slice(from, slot.start));
    // param() binds the value as one parameter (a bare array would be spread
    // into a list of parameters)
    values.push(typeof sqlTag.param === 'function' ? sqlTag.param(slot.value) : slot.value);
    from = slot.end;
  }
  strings.push(text.slice(from));
  return sqlTag(strings, ...values);
}

interface DrizzleConfig {
  database: any; // Drizzle database instance
  schema?: any; // Optional schema for additional type safety
  logger?: boolean;
}

export class DrizzleAdapter implements DatabaseAdapter {
  private db: any;
  private schema: any;
  private logger = createFrameworkLogger('Drizzle');

  constructor(config: DrizzleConfig) {
    try {
      if (!config.database) {
        throw new Error('Drizzle database instance is required');
      }

      this.db = config.database;
      this.schema = config.schema;

      this.logger.info('Drizzle ORM adapter initialized', 'Drizzle');
    } catch {
      this.logger.error('Drizzle ORM initialization failed', 'Drizzle');
      throw new Error(
        'Drizzle ORM configuration error. Ensure you have a valid Drizzle database instance.'
      );
    }
  }

  async connect(): Promise<void> {
    // Drizzle doesn't have an explicit connect method
    // Connection is handled by the underlying driver
    this.logger.info('Drizzle ORM adapter ready', 'Connection');
  }

  async disconnect(): Promise<void> {
    // Drizzle doesn't have an explicit disconnect method
    // This would be handled by the underlying driver
    this.logger.info('Drizzle ORM adapter disconnected', 'Connection');
  }

  // Raw SQL query support
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    try {
      // Using Drizzle's execute method for raw SQL
      const result = await this.db.execute(await toExecutable(sql, params));

      // Handle different result formats from different drivers
      if (Array.isArray(result)) {
        return result;
      } else if (result.rows) {
        return result.rows;
      } else if (result.recordset) {
        return result.recordset;
      } else {
        return [result];
      }
    } catch (error) {
      this.logger.error('Drizzle query failed', 'Query', {
        sql,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results[0] ?? null;
  }

  // ORM-style operations (requires schema)
  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    try {
      if (this.schema && this.schema[table]) {
        // Use schema-based insert
        const result = await this.db.insert(this.schema[table]).values(data).returning();
        return result[0] as T;
      } else {
        // Fallback to raw SQL
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

        const sql = `INSERT INTO ${qi(table)} (${quoteColumns(keys, qi)}) VALUES (${placeholders}) RETURNING *`;
        const result = await this.query<T>(sql, values);
        return result[0] as T;
      }
    } catch (error) {
      this.logger.error('Drizzle insert failed', 'Insert', {
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
    try {
      assertNonEmptyWhere('update', table, where);

      if (this.schema && this.schema[table]) {
        // Use schema-based update
        try {
          const { eq, and } = await getDrizzleOrm();

          // Build where conditions
          const conditions = Object.entries(where).map(([key, value]) =>
            eq(this.schema[table][key], value)
          );
          const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

          const result = await this.db
            .update(this.schema[table])
            .set(data)
            .where(whereClause)
            .returning();

          return result[0] as T;
        } catch {
          // Fallback to raw SQL if drizzle-orm is not available
          const dataKeys = Object.keys(data);
          const whereKeys = Object.keys(where);
          const setClause = buildSetClause(dataKeys, qi, 'dollar');
          const whereClause = buildWhereClause(whereKeys, qi, 'dollar', dataKeys.length + 1);

          const sql = `UPDATE ${qi(table)} SET ${setClause} WHERE ${whereClause} RETURNING *`;
          const params = [...Object.values(data), ...Object.values(where)];
          const result = await this.query<T>(sql, params);
          return result[0] as T;
        }
      } else {
        // Fallback to raw SQL
        const dataKeys = Object.keys(data);
        const whereKeys = Object.keys(where);
        const setClause = buildSetClause(dataKeys, qi, 'dollar');
        const whereClause = buildWhereClause(whereKeys, qi, 'dollar', dataKeys.length + 1);

        const sql = `UPDATE ${qi(table)} SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const params = [...Object.values(data), ...Object.values(where)];
        const result = await this.query<T>(sql, params);
        return result[0] as T;
      }
    } catch (error) {
      this.logger.error('Drizzle update failed', 'Update', {
        table,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    try {
      assertNonEmptyWhere('delete', table, where);

      if (this.schema && this.schema[table]) {
        // Use schema-based delete
        try {
          const { eq, and } = await getDrizzleOrm();

          const conditions = Object.entries(where).map(([key, value]) =>
            eq(this.schema[table][key], value)
          );
          const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

          const result = await this.db.delete(this.schema[table]).where(whereClause);

          return (
            (result as any).changes || (result as any).rowCount || (result as any).affectedRows || 0
          );
        } catch {
          // Fallback to raw SQL if drizzle-orm is not available
          const whereClause = buildWhereClause(Object.keys(where), qi, 'dollar');
          const sql = `DELETE FROM ${qi(table)} WHERE ${whereClause}`;
          await this.query(sql, Object.values(where));
          return 1; // Can't determine exact count without result metadata
        }
      } else {
        // Fallback to raw SQL
        const whereClause = buildWhereClause(Object.keys(where), qi, 'dollar');
        const sql = `DELETE FROM ${qi(table)} WHERE ${whereClause}`;
        await this.query(sql, Object.values(where));
        return 1; // Can't determine exact count without result metadata
      }
    } catch (error) {
      this.logger.error('Drizzle delete failed', 'Delete', {
        table,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    return await this.db.transaction(async (tx: any) => {
      const transaction = new DrizzleTransaction(tx, this.schema, this.logger);
      return await callback(transaction);
    });
  }

  // Drizzle-specific methods
  select(table?: string) {
    if (table && this.schema && this.schema[table]) {
      return this.db.select().from(this.schema[table]);
    }
    return this.db.select();
  }

  insertInto(table: string) {
    if (this.schema && this.schema[table]) {
      return this.db.insert(this.schema[table]);
    }
    throw new Error(`Table ${table} not found in schema`);
  }

  updateTable(table: string) {
    if (this.schema && this.schema[table]) {
      return this.db.update(this.schema[table]);
    }
    throw new Error(`Table ${table} not found in schema`);
  }

  deleteFrom(table: string) {
    if (this.schema && this.schema[table]) {
      return this.db.delete(this.schema[table]);
    }
    throw new Error(`Table ${table} not found in schema`);
  }

  getSchema() {
    return this.schema;
  }

  getDb() {
    return this.db;
  }

  // Schema introspection helpers
  getTableNames(): string[] {
    return this.schema ? Object.keys(this.schema) : [];
  }

  hasTable(tableName: string): boolean {
    return this.schema ? !!this.schema[tableName] : false;
  }
}

class DrizzleTransaction implements DatabaseTransaction {
  constructor(
    private tx: any,
    private schema: any,
    private logger: any
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    try {
      const result = await this.tx.execute(await toExecutable(sql, params));

      if (Array.isArray(result)) {
        return result;
      } else if (result.rows) {
        return result.rows;
      } else if (result.recordset) {
        return result.recordset;
      } else {
        return [result];
      }
    } catch (error) {
      this.logger.error('Drizzle transaction query failed', 'Query', {
        sql,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results[0] ?? null;
  }

  async insert<T = any>(table: string, data: Record<string, any>): Promise<T> {
    if (this.schema && this.schema[table]) {
      const result = await this.tx.insert(this.schema[table]).values(data).returning();
      return result[0] as T;
    } else {
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

      const sql = `INSERT INTO ${qi(table)} (${quoteColumns(keys, qi)}) VALUES (${placeholders}) RETURNING *`;
      const result = await this.query<T>(sql, values);
      return result[0] as T;
    }
  }

  async update<T = any>(
    table: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    assertNonEmptyWhere('update', table, where);

    if (this.schema && this.schema[table]) {
      try {
        const { eq, and } = await getDrizzleOrm();

        const conditions = Object.entries(where).map(([key, value]) =>
          eq(this.schema[table][key], value)
        );
        const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

        const result = await this.tx
          .update(this.schema[table])
          .set(data)
          .where(whereClause)
          .returning();

        return result[0] as T;
      } catch {
        // Fallback to raw SQL
        const setClause = buildSetClause(Object.keys(data), qi, 'dollar');
        const whereClause = buildWhereClause(
          Object.keys(where),
          qi,
          'dollar',
          Object.keys(data).length + 1
        );

        const sql = `UPDATE ${qi(table)} SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const params = [...Object.values(data), ...Object.values(where)];
        const result = await this.query<T>(sql, params);
        return result[0] as T;
      }
    } else {
      const setClause = buildSetClause(Object.keys(data), qi, 'dollar');
      const whereClause = buildWhereClause(
        Object.keys(where),
        qi,
        'dollar',
        Object.keys(data).length + 1
      );

      const sql = `UPDATE ${qi(table)} SET ${setClause} WHERE ${whereClause} RETURNING *`;
      const params = [...Object.values(data), ...Object.values(where)];
      const result = await this.query<T>(sql, params);
      return result[0] as T;
    }
  }

  async delete(table: string, where: Record<string, any>): Promise<number> {
    assertNonEmptyWhere('delete', table, where);

    if (this.schema && this.schema[table]) {
      try {
        const { eq, and } = await getDrizzleOrm();

        const conditions = Object.entries(where).map(([key, value]) =>
          eq(this.schema[table][key], value)
        );
        const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

        const result = await this.tx.delete(this.schema[table]).where(whereClause);

        return (
          (result as any).changes || (result as any).rowCount || (result as any).affectedRows || 0
        );
      } catch {
        // Fallback to raw SQL
        const whereClause = buildWhereClause(Object.keys(where), qi, 'dollar');
        const sql = `DELETE FROM ${qi(table)} WHERE ${whereClause}`;
        await this.query(sql, Object.values(where));
        return 1; // Can't determine exact count
      }
    } else {
      const whereClause = buildWhereClause(Object.keys(where), qi, 'dollar');
      const sql = `DELETE FROM ${qi(table)} WHERE ${whereClause}`;
      await this.query(sql, Object.values(where));
      return 1; // Can't determine exact count
    }
  }

  async commit(): Promise<void> {
    // Drizzle transactions are auto-committed
    // This is just for interface compatibility
  }

  async rollback(): Promise<void> {
    // Drizzle transactions will auto-rollback on error
    throw new Error('Transaction rollback');
  }
}
