"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MySQLAdapter = void 0;
const logger_1 = require("../../logger");
class MySQLAdapter {
    pool;
    logger = (0, logger_1.createFrameworkLogger)("MySQL");
    constructor(config) {
        try {
            const mysql = require("mysql2/promise");
            this.pool = mysql.createPool({
                host: config.host || "localhost",
                port: config.port || 3306,
                user: config.user || "root",
                password: config.password || "",
                database: config.database || "moro_app",
                waitForConnections: true,
                connectionLimit: config.connectionLimit || 10,
                queueLimit: 0,
            });
        }
        catch (error) {
            throw new Error("mysql2 package is required for MySQL adapter. Install it with: npm install mysql2");
        }
    }
    async connect() {
        try {
            const connection = await this.pool.getConnection();
            connection.release();
            this.logger.info("MySQL connection established", "Connection");
        }
        catch (error) {
            this.logger.error("MySQL connection failed", "Connection", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async disconnect() {
        await this.pool.end();
    }
    async query(sql, params) {
        const [rows] = await this.pool.execute(sql, params);
        return rows;
    }
    async queryOne(sql, params) {
        const results = await this.query(sql, params);
        return results.length > 0 ? results[0] : null;
    }
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
        const [result] = (await this.pool.execute(sql, values));
        // Return the inserted record
        const insertedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE id = ?`, [result.insertId]);
        return insertedRecord;
    }
    async update(table, data, where) {
        const setClause = Object.keys(data)
            .map((key) => `${key} = ?`)
            .join(", ");
        const whereClause = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(" AND ");
        const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
        const params = [...Object.values(data), ...Object.values(where)];
        await this.pool.execute(sql, params);
        // Return the updated record
        const updatedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE ${whereClause}`, Object.values(where));
        return updatedRecord;
    }
    async delete(table, where) {
        const whereClause = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(" AND ");
        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        const [result] = (await this.pool.execute(sql, Object.values(where)));
        return result.affectedRows;
    }
    async transaction(callback) {
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            const transaction = new MySQLTransaction(connection);
            const result = await callback(transaction);
            await connection.commit();
            return result;
        }
        catch (error) {
            await connection.rollback();
            throw error;
        }
        finally {
            connection.release();
        }
    }
}
exports.MySQLAdapter = MySQLAdapter;
class MySQLTransaction {
    connection;
    constructor(connection) {
        this.connection = connection;
    }
    async query(sql, params) {
        const [rows] = await this.connection.execute(sql, params);
        return rows;
    }
    async queryOne(sql, params) {
        const results = await this.query(sql, params);
        return results.length > 0 ? results[0] : null;
    }
    async insert(table, data) {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
        const [result] = (await this.connection.execute(sql, values));
        const insertedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE id = ?`, [result.insertId]);
        return insertedRecord;
    }
    async update(table, data, where) {
        const setClause = Object.keys(data)
            .map((key) => `${key} = ?`)
            .join(", ");
        const whereClause = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(" AND ");
        const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
        const params = [...Object.values(data), ...Object.values(where)];
        await this.connection.execute(sql, params);
        const updatedRecord = await this.queryOne(`SELECT * FROM ${table} WHERE ${whereClause}`, Object.values(where));
        return updatedRecord;
    }
    async delete(table, where) {
        const whereClause = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(" AND ");
        const sql = `DELETE FROM ${table} WHERE ${whereClause}`;
        const [result] = (await this.connection.execute(sql, Object.values(where)));
        return result.affectedRows;
    }
    async commit() {
        await this.connection.commit();
    }
    async rollback() {
        await this.connection.rollback();
    }
}
