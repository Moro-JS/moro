"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQLiteAdapter = void 0;
const logger_1 = require("../../logger");
class SQLiteAdapter {
    db;
    logger = (0, logger_1.createFrameworkLogger)('SQLite');
    constructor(config = {}) {
        try {
            const Database = require('better-sqlite3');
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
        catch (error) {
            throw new Error('better-sqlite3 package is required for SQLite adapter. Install it with: npm install better-sqlite3');
        }
    }
    async connect() {
        // SQLite doesn't require explicit connection - it's handled in constructor
        this.logger.info('SQLite adapter ready', 'Connection');
    }
    async disconnect() {
        this.db.close();
    }
    async query(sql, params) {
        try {
            const stmt = this.db.prepare(sql);
            const results = stmt.all(params || []);
            return results;
        }
        catch (error) {
            this.logger.error('SQLite query failed', 'Query', {
                sql,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async queryOne(sql, params) {
        try {
            const stmt = this.db.prepare(sql);
            const result = stmt.get(params || []);
            return result || null;
        }
        catch (error) {
            this.logger.error('SQLite queryOne failed', 'Query', {
                sql,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map(() => '?').join(', ');
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
        try {
            const stmt = this.db.prepare(sql);
            const info = stmt.run(values);
            // Return the inserted record
            const insertedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE rowid = ?`, [
                info.lastInsertRowid,
            ]);
            return insertedRecord;
        }
        catch (error) {
            this.logger.error('SQLite insert failed', 'Insert', {
                table,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async update(table, data, where) {
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
            const updatedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE ${whereClause}`, Object.values(where));
            return updatedRecord;
        }
        catch (error) {
            this.logger.error('SQLite update failed', 'Update', {
                table,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async delete(table, where) {
        const whereClause = Object.keys(where)
            .map(key => `${key} = ?`)
            .join(' AND ');
        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        try {
            const stmt = this.db.prepare(sql);
            const info = stmt.run(Object.values(where));
            return info.changes;
        }
        catch (error) {
            this.logger.error('SQLite delete failed', 'Delete', {
                table,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async transaction(callback) {
        const transaction = this.db.transaction(async () => {
            const tx = new SQLiteTransaction(this.db);
            return await callback(tx);
        });
        return transaction();
    }
}
exports.SQLiteAdapter = SQLiteAdapter;
class SQLiteTransaction {
    db;
    constructor(db) {
        this.db = db;
    }
    async query(sql, params) {
        const stmt = this.db.prepare(sql);
        const results = stmt.all(params || []);
        return results;
    }
    async queryOne(sql, params) {
        const stmt = this.db.prepare(sql);
        const result = stmt.get(params || []);
        return result || null;
    }
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map(() => '?').join(', ');
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
        const stmt = this.db.prepare(sql);
        const info = stmt.run(values);
        const insertedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE rowid = ?`, [
            info.lastInsertRowid,
        ]);
        return insertedRecord;
    }
    async update(table, data, where) {
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
        const updatedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE ${whereClause}`, Object.values(where));
        return updatedRecord;
    }
    async delete(table, where) {
        const whereClause = Object.keys(where)
            .map(key => `${key} = ?`)
            .join(' AND ');
        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        const stmt = this.db.prepare(sql);
        const info = stmt.run(Object.values(where));
        return info.changes;
    }
    async commit() {
        // SQLite transactions are handled automatically by better-sqlite3
        // This is just for interface compatibility
    }
    async rollback() {
        // SQLite transactions are handled automatically by better-sqlite3
        // This is just for interface compatibility
        throw new Error('Transaction rollback');
    }
}
