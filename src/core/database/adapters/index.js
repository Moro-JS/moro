"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DrizzleAdapter = exports.RedisAdapter = exports.MongoDBAdapter = exports.SQLiteAdapter = exports.PostgreSQLAdapter = exports.MySQLAdapter = void 0;
exports.createDatabaseAdapter = createDatabaseAdapter;
// Database Adapters
var mysql_1 = require("./mysql");
Object.defineProperty(exports, "MySQLAdapter", { enumerable: true, get: function () { return mysql_1.MySQLAdapter; } });
var postgresql_1 = require("./postgresql");
Object.defineProperty(exports, "PostgreSQLAdapter", { enumerable: true, get: function () { return postgresql_1.PostgreSQLAdapter; } });
var sqlite_1 = require("./sqlite");
Object.defineProperty(exports, "SQLiteAdapter", { enumerable: true, get: function () { return sqlite_1.SQLiteAdapter; } });
var mongodb_1 = require("./mongodb");
Object.defineProperty(exports, "MongoDBAdapter", { enumerable: true, get: function () { return mongodb_1.MongoDBAdapter; } });
var redis_1 = require("./redis");
Object.defineProperty(exports, "RedisAdapter", { enumerable: true, get: function () { return redis_1.RedisAdapter; } });
var drizzle_1 = require("./drizzle");
Object.defineProperty(exports, "DrizzleAdapter", { enumerable: true, get: function () { return drizzle_1.DrizzleAdapter; } });
const mysql_2 = require("./mysql");
const postgresql_2 = require("./postgresql");
const sqlite_2 = require("./sqlite");
const mongodb_2 = require("./mongodb");
const redis_2 = require("./redis");
const drizzle_2 = require("./drizzle");
// Adapter factory function for auto-loading
function createDatabaseAdapter(type, options = {}) {
    switch (type.toLowerCase()) {
        case "mysql":
            return new mysql_2.MySQLAdapter(options);
        case "postgresql":
        case "postgres":
        case "pg":
            return new postgresql_2.PostgreSQLAdapter(options);
        case "sqlite":
        case "sqlite3":
            return new sqlite_2.SQLiteAdapter(options);
        case "mongodb":
        case "mongo":
            return new mongodb_2.MongoDBAdapter(options);
        case "redis":
            return new redis_2.RedisAdapter(options);
        case "drizzle":
        case "orm":
            return new drizzle_2.DrizzleAdapter(options);
        default:
            throw new Error(`Unknown database adapter type: ${type}. Available types: mysql, postgresql, sqlite, mongodb, redis, drizzle`);
    }
}
