// Database Adapters
export { MySQLAdapter } from './mysql.js';
export { PostgreSQLAdapter } from './postgresql.js';
export { SQLiteAdapter } from './sqlite.js';
export { MongoDBAdapter } from './mongodb.js';
export { RedisAdapter } from './redis.js';
export { DrizzleAdapter } from './drizzle.js';

import { MySQLAdapter } from './mysql.js';
import { PostgreSQLAdapter } from './postgresql.js';
import { SQLiteAdapter } from './sqlite.js';
import { MongoDBAdapter } from './mongodb.js';
import { RedisAdapter } from './redis.js';
import { DrizzleAdapter } from './drizzle.js';
import { DatabaseAdapter } from '../../../types/database.js';

// Adapter factory function for auto-loading
export function createDatabaseAdapter(type: string, options: any = {}): DatabaseAdapter {
  switch (type.toLowerCase()) {
    case 'mysql':
      return new MySQLAdapter(options);
    case 'postgresql':
    case 'postgres':
    case 'pg':
      return new PostgreSQLAdapter(options);
    case 'sqlite':
    case 'sqlite3':
      return new SQLiteAdapter(options);
    case 'mongodb':
    case 'mongo':
      return new MongoDBAdapter(options);
    case 'redis':
      return new RedisAdapter(options);
    case 'drizzle':
    case 'orm':
      return new DrizzleAdapter(options);
    default:
      throw new Error(
        `Unknown database adapter type: ${type}. Available types: mysql, postgresql, sqlite, mongodb, redis, drizzle`
      );
  }
}
