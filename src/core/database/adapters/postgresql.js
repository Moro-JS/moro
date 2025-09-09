"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgreSQLAdapter = void 0;
const logger_1 = require("../../logger");
class PostgreSQLAdapter {
    pool;
    logger = (0, logger_1.createFrameworkLogger)("PostgreSQL");
    constructor(config) {
        try {
            const { Pool } = require("pg");
            this.pool = new Pool({
                host: config.host || "localhost",
                port: config.port || 5432,
                user: config.user || "postgres",
                password: config.password || "",
                database: config.database || "moro_app",
                max: config.connectionLimit || 10,
                ssl: config.ssl || false,
            });
            this.pool.on("error", (err) => {
                this.logger.error("PostgreSQL pool error", "Pool", {
                    error: err.message,
                });
            });
            this.logger.info("PostgreSQL adapter initialized", "PostgreSQL");
        }
        catch (error) {
            throw new Error("pg package is required for PostgreSQL adapter. Install it with: npm install pg");
        }
    }
    async connect() {
        try {
            const client = await this.pool.connect();
            client.release();
            this.logger.info("PostgreSQL connection established", "Connection");
        }
        catch (error) {
            this.logger.error("PostgreSQL connection failed", "Connection", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async disconnect() {
        await this.pool.end();
    }
    async query(sql, params) {
        const result = await this.pool.query(sql, params);
        return result.rows;
    }
    async queryOne(sql, params) {
        const results = await this.query(sql, params);
        return results.length > 0 ? results[0] : null;
    }
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
        const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`;
        const result = await this.pool.query(sql, values);
        return result.rows[0];
    }
    async update(table, data, where) {
        const dataKeys = Object.keys(data);
        const dataValues = Object.values(data);
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);
        const setClause = dataKeys
            .map((key, index) => `${key} = $${index + 1}`)
            .join(", ");
        const whereClause = whereKeys
            .map((key, index) => `${key} = $${dataKeys.length + index + 1}`)
            .join(" AND ");
        const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const params = [...dataValues, ...whereValues];
        const result = await this.pool.query(sql, params);
        return result.rows[0];
    }
    async delete(table, where) {
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);
        const whereClause = whereKeys
            .map((key, index) => `${key} = $${index + 1}`)
            .join(" AND ");
        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        const result = await this.pool.query(sql, whereValues);
        return result.rowCount || 0;
    }
    async transaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const transaction = new PostgreSQLTransaction(client);
            const result = await callback(transaction);
            await client.query("COMMIT");
            return result;
        }
        catch (error) {
            await client.query("ROLLBACK");
            throw error;
        }
        finally {
            client.release();
        }
    }
}
exports.PostgreSQLAdapter = PostgreSQLAdapter;
class PostgreSQLTransaction {
    client;
    constructor(client) {
        this.client = client;
    }
    async query(sql, params) {
        const result = await this.client.query(sql, params);
        return result.rows;
    }
    async queryOne(sql, params) {
        const results = await this.query(sql, params);
        return results.length > 0 ? results[0] : null;
    }
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
        const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`;
        const result = await this.client.query(sql, values);
        return result.rows[0];
    }
    async update(table, data, where) {
        const dataKeys = Object.keys(data);
        const dataValues = Object.values(data);
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);
        const setClause = dataKeys
            .map((key, index) => `${key} = $${index + 1}`)
            .join(", ");
        const whereClause = whereKeys
            .map((key, index) => `${key} = $${dataKeys.length + index + 1}`)
            .join(" AND ");
        const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const params = [...dataValues, ...whereValues];
        const result = await this.client.query(sql, params);
        return result.rows[0];
    }
    async delete(table, where) {
        const whereKeys = Object.keys(where);
        const whereValues = Object.values(where);
        const whereClause = whereKeys
            .map((key, index) => `${key} = $${index + 1}`)
            .join(" AND ");
        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        const result = await this.client.query(sql, whereValues);
        return result.rowCount || 0;
    }
    async commit() {
        await this.client.query("COMMIT");
    }
    async rollback() {
        await this.client.query("ROLLBACK");
    }
}
