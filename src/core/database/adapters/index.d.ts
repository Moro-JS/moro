export { MySQLAdapter } from './mysql';
export { PostgreSQLAdapter } from './postgresql';
export { SQLiteAdapter } from './sqlite';
export { MongoDBAdapter } from './mongodb';
export { RedisAdapter } from './redis';
export { DrizzleAdapter } from './drizzle';
import { DatabaseAdapter } from '../../../types/database';
export declare function createDatabaseAdapter(type: string, options?: any): DatabaseAdapter;
