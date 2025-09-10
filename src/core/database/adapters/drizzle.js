"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DrizzleAdapter = void 0;
const logger_1 = require("../../logger");
class DrizzleAdapter {
    db;
    schema;
    logger = (0, logger_1.createFrameworkLogger)('Drizzle');
    constructor(config) {
        try {
            if (!config.database) {
                throw new Error('Drizzle database instance is required');
            }
            this.db = config.database;
            this.schema = config.schema;
            this.logger.info('Drizzle ORM adapter initialized', 'Drizzle');
        }
        catch (error) {
            this.logger.error('Drizzle ORM initialization failed', 'Drizzle');
            throw new Error('Drizzle ORM configuration error. Ensure you have a valid Drizzle database instance.');
        }
    }
    async connect() {
        // Drizzle doesn't have an explicit connect method
        // Connection is handled by the underlying driver
        this.logger.info('Drizzle ORM adapter ready', 'Connection');
    }
    async disconnect() {
        // Drizzle doesn't have an explicit disconnect method
        // This would be handled by the underlying driver
        this.logger.info('Drizzle ORM adapter disconnected', 'Connection');
    }
    // Raw SQL query support
    async query(sql, params) {
        try {
            // Using Drizzle's execute method for raw SQL
            const result = await this.db.execute(sql, params);
            // Handle different result formats from different drivers
            if (Array.isArray(result)) {
                return result;
            }
            else if (result.rows) {
                return result.rows;
            }
            else if (result.recordset) {
                return result.recordset;
            }
            else {
                return [result];
            }
        }
        catch (error) {
            this.logger.error('Drizzle query failed', 'Query', {
                sql,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async queryOne(sql, params) {
        const results = await this.query(sql, params);
        return results.length > 0 ? results[0] : null;
    }
    // ORM-style operations (requires schema)
    async insert(table, data) {
        try {
            if (this.schema && this.schema[table]) {
                // Use schema-based insert
                const result = await this.db.insert(this.schema[table]).values(data).returning();
                return result[0];
            }
            else {
                // Fallback to raw SQL
                const keys = Object.keys(data);
                const values = Object.values(data);
                const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
                const result = await this.query(sql, values);
                return result[0];
            }
        }
        catch (error) {
            this.logger.error('Drizzle insert failed', 'Insert', {
                table,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async update(table, data, where) {
        try {
            if (this.schema && this.schema[table]) {
                // Use schema-based update
                try {
                    const { eq, and } = require('drizzle-orm');
                    // Build where conditions
                    const conditions = Object.entries(where).map(([key, value]) => eq(this.schema[table][key], value));
                    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
                    const result = await this.db
                        .update(this.schema[table])
                        .set(data)
                        .where(whereClause)
                        .returning();
                    return result[0];
                }
                catch (importError) {
                    // Fallback to raw SQL if drizzle-orm is not available
                    const setClause = Object.keys(data)
                        .map((key, i) => `${key} = $${i + 1}`)
                        .join(', ');
                    const whereClause = Object.keys(where)
                        .map((key, i) => `${key} = $${Object.keys(data).length + i + 1}`)
                        .join(' AND ');
                    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
                    const params = [...Object.values(data), ...Object.values(where)];
                    const result = await this.query(sql, params);
                    return result[0];
                }
            }
            else {
                // Fallback to raw SQL
                const setClause = Object.keys(data)
                    .map((key, i) => `${key} = $${i + 1}`)
                    .join(', ');
                const whereClause = Object.keys(where)
                    .map((key, i) => `${key} = $${Object.keys(data).length + i + 1}`)
                    .join(' AND ');
                const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
                const params = [...Object.values(data), ...Object.values(where)];
                const result = await this.query(sql, params);
                return result[0];
            }
        }
        catch (error) {
            this.logger.error('Drizzle update failed', 'Update', {
                table,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async delete(table, where) {
        try {
            if (this.schema && this.schema[table]) {
                // Use schema-based delete
                try {
                    const { eq, and } = require('drizzle-orm');
                    const conditions = Object.entries(where).map(([key, value]) => eq(this.schema[table][key], value));
                    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
                    const result = await this.db.delete(this.schema[table]).where(whereClause);
                    return (result.changes || result.rowCount || result.affectedRows || 0);
                }
                catch (importError) {
                    // Fallback to raw SQL if drizzle-orm is not available
                    const whereClause = Object.keys(where)
                        .map((key, i) => `${key} = $${i + 1}`)
                        .join(' AND ');
                    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
                    await this.query(sql, Object.values(where));
                    return 1; // Can't determine exact count without result metadata
                }
            }
            else {
                // Fallback to raw SQL
                const whereClause = Object.keys(where)
                    .map((key, i) => `${key} = $${i + 1}`)
                    .join(' AND ');
                const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
                await this.query(sql, Object.values(where));
                return 1; // Can't determine exact count without result metadata
            }
        }
        catch (error) {
            this.logger.error('Drizzle delete failed', 'Delete', {
                table,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async transaction(callback) {
        return await this.db.transaction(async (tx) => {
            const transaction = new DrizzleTransaction(tx, this.schema, this.logger);
            return await callback(transaction);
        });
    }
    // Drizzle-specific methods
    select(table) {
        if (table && this.schema && this.schema[table]) {
            return this.db.select().from(this.schema[table]);
        }
        return this.db.select();
    }
    insertInto(table) {
        if (this.schema && this.schema[table]) {
            return this.db.insert(this.schema[table]);
        }
        throw new Error(`Table ${table} not found in schema`);
    }
    updateTable(table) {
        if (this.schema && this.schema[table]) {
            return this.db.update(this.schema[table]);
        }
        throw new Error(`Table ${table} not found in schema`);
    }
    deleteFrom(table) {
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
    getTableNames() {
        return this.schema ? Object.keys(this.schema) : [];
    }
    hasTable(tableName) {
        return this.schema ? !!this.schema[tableName] : false;
    }
}
exports.DrizzleAdapter = DrizzleAdapter;
class DrizzleTransaction {
    tx;
    schema;
    logger;
    constructor(tx, schema, logger) {
        this.tx = tx;
        this.schema = schema;
        this.logger = logger;
    }
    async query(sql, params) {
        try {
            const result = await this.tx.execute(sql, params);
            if (Array.isArray(result)) {
                return result;
            }
            else if (result.rows) {
                return result.rows;
            }
            else if (result.recordset) {
                return result.recordset;
            }
            else {
                return [result];
            }
        }
        catch (error) {
            this.logger.error('Drizzle transaction query failed', 'Query', {
                sql,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async queryOne(sql, params) {
        const results = await this.query(sql, params);
        return results.length > 0 ? results[0] : null;
    }
    async insert(table, data) {
        if (this.schema && this.schema[table]) {
            const result = await this.tx.insert(this.schema[table]).values(data).returning();
            return result[0];
        }
        else {
            const keys = Object.keys(data);
            const values = Object.values(data);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
            const result = await this.query(sql, values);
            return result[0];
        }
    }
    async update(table, data, where) {
        if (this.schema && this.schema[table]) {
            try {
                const { eq, and } = require('drizzle-orm');
                const conditions = Object.entries(where).map(([key, value]) => eq(this.schema[table][key], value));
                const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
                const result = await this.tx
                    .update(this.schema[table])
                    .set(data)
                    .where(whereClause)
                    .returning();
                return result[0];
            }
            catch (importError) {
                // Fallback to raw SQL
                const setClause = Object.keys(data)
                    .map((key, i) => `${key} = $${i + 1}`)
                    .join(', ');
                const whereClause = Object.keys(where)
                    .map((key, i) => `${key} = $${Object.keys(data).length + i + 1}`)
                    .join(' AND ');
                const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
                const params = [...Object.values(data), ...Object.values(where)];
                const result = await this.query(sql, params);
                return result[0];
            }
        }
        else {
            const setClause = Object.keys(data)
                .map((key, i) => `${key} = $${i + 1}`)
                .join(', ');
            const whereClause = Object.keys(where)
                .map((key, i) => `${key} = $${Object.keys(data).length + i + 1}`)
                .join(' AND ');
            const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
            const params = [...Object.values(data), ...Object.values(where)];
            const result = await this.query(sql, params);
            return result[0];
        }
    }
    async delete(table, where) {
        if (this.schema && this.schema[table]) {
            try {
                const { eq, and } = require('drizzle-orm');
                const conditions = Object.entries(where).map(([key, value]) => eq(this.schema[table][key], value));
                const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
                const result = await this.tx.delete(this.schema[table]).where(whereClause);
                return (result.changes || result.rowCount || result.affectedRows || 0);
            }
            catch (importError) {
                // Fallback to raw SQL
                const whereClause = Object.keys(where)
                    .map((key, i) => `${key} = $${i + 1}`)
                    .join(' AND ');
                const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
                await this.query(sql, Object.values(where));
                return 1; // Can't determine exact count
            }
        }
        else {
            const whereClause = Object.keys(where)
                .map((key, i) => `${key} = $${i + 1}`)
                .join(' AND ');
            const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
            await this.query(sql, Object.values(where));
            return 1; // Can't determine exact count
        }
    }
    async commit() {
        // Drizzle transactions are auto-committed
        // This is just for interface compatibility
    }
    async rollback() {
        // Drizzle transactions will auto-rollback on error
        throw new Error('Transaction rollback');
    }
}
