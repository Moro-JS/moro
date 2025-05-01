// Database Adapters
export { MySQLAdapter } from "./mysql";
export { PostgreSQLAdapter } from "./postgresql";
export { SQLiteAdapter } from "./sqlite";
export { MongoDBAdapter } from "./mongodb";
export { RedisAdapter } from "./redis";
export { DrizzleAdapter } from "./drizzle";

import { MySQLAdapter } from "./mysql";
import { PostgreSQLAdapter } from "./postgresql";
import { SQLiteAdapter } from "./sqlite";
import { MongoDBAdapter } from "./mongodb";
import { RedisAdapter } from "./redis";
import { DrizzleAdapter } from "./drizzle";
import { DatabaseAdapter } from "../../../types/database";

// Adapter factory function for auto-loading
export function createDatabaseAdapter(
  type: string,
  options: any = {},
): DatabaseAdapter {
  switch (type.toLowerCase()) {
    case "mysql":
      return new MySQLAdapter(options);
    case "postgresql":
    case "postgres":
    case "pg":
      return new PostgreSQLAdapter(options);
    case "sqlite":
    case "sqlite3":
      return new SQLiteAdapter(options);
    case "mongodb":
    case "mongo":
      return new MongoDBAdapter(options);
    case "redis":
      return new RedisAdapter(options);
    case "drizzle":
    case "orm":
      return new DrizzleAdapter(options);
    default:
      throw new Error(
        `Unknown database adapter type: ${type}. Available types: mysql, postgresql, sqlite, mongodb, redis, drizzle`,
      );
  }
}
