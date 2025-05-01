# Database Adapters

The MoroJS database module provides a pluggable adapter system for different database backends, similar to the middleware adapter pattern.

## Available Adapters

### SQL Databases

#### MySQL Adapter
- **Package Required**: `mysql2`
- **Usage**: Production-ready with connection pooling
- **Type**: `mysql`

#### PostgreSQL Adapter  
- **Package Required**: `pg` and `@types/pg`
- **Usage**: Full PostgreSQL feature support
- **Type**: `postgresql`, `postgres`, or `pg`

#### SQLite Adapter
- **Package Required**: `better-sqlite3`
- **Usage**: Lightweight, file-based database
- **Type**: `sqlite` or `sqlite3`

### NoSQL Databases

#### MongoDB Adapter
- **Package Required**: `mongodb`
- **Usage**: Document database with aggregation support
- **Type**: `mongodb` or `mongo`

#### Redis Adapter
- **Package Required**: `ioredis`
- **Usage**: In-memory key-value store with pub/sub
- **Type**: `redis`

### ORM

#### Drizzle Adapter
- **Package Required**: `drizzle-orm` + database driver
- **Usage**: Type-safe ORM with schema validation
- **Type**: `drizzle` or `orm`

## Factory Pattern (Recommended)

```typescript
import { createDatabaseAdapter } from 'moro';

// SQL Databases
const mysql = createDatabaseAdapter('mysql', {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'password',
  database: 'my_app',
  connectionLimit: 10
});

const postgres = createDatabaseAdapter('postgresql', {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'password',
  database: 'my_app',
  connectionLimit: 10,
  ssl: false
});

const sqlite = createDatabaseAdapter('sqlite', {
  filename: 'app.db',
  memory: false
});

// NoSQL Databases
const mongodb = createDatabaseAdapter('mongodb', {
  host: 'localhost',
  port: 27017,
  database: 'my_app',
  username: 'user',
  password: 'password'
});

const redis = createDatabaseAdapter('redis', {
  host: 'localhost',
  port: 6379,
  password: 'password',
  keyPrefix: 'myapp:'
});

// ORM
const drizzle = createDatabaseAdapter('drizzle', {
  database: drizzleInstance,
  schema: schemaObject
});
```

## Direct Instantiation

```typescript
import { 
  MySQLAdapter, 
  PostgreSQLAdapter, 
  SQLiteAdapter,
  MongoDBAdapter,
  RedisAdapter,
  DrizzleAdapter
} from 'moro';

// SQL
const mysql = new MySQLAdapter({ host: 'localhost', ... });
const postgres = new PostgreSQLAdapter({ host: 'localhost', ... });
const sqlite = new SQLiteAdapter({ filename: 'app.db' });

// NoSQL
const mongodb = new MongoDBAdapter({ host: 'localhost', ... });
const redis = new RedisAdapter({ host: 'localhost', ... });

// ORM
const drizzle = new DrizzleAdapter({ database: drizzleInstance, schema });
```

## Common Interface

All adapters implement the same `DatabaseAdapter` interface:

```typescript
interface DatabaseAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: any[]): Promise<T | null>;
  insert<T>(table: string, data: Record<string, any>): Promise<T>;
  update<T>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<T>;
  delete(table: string, where: Record<string, any>): Promise<number>;
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
}
```

## Usage Example

```typescript
// Initialize
await db.connect();

// Basic operations
const users = await db.query('SELECT * FROM users');
const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [1]);

// ORM-like helpers
const newUser = await db.insert('users', { name: 'John', email: 'john@example.com' });
const updated = await db.update('users', { name: 'Jane' }, { id: 1 });
const deleted = await db.delete('users', { id: 1 });

// Transactions
const result = await db.transaction(async (tx) => {
  const user = await tx.insert('users', userData);
  await tx.insert('profiles', { user_id: user.id, ...profileData });
  return user;
});
```

## Usage Examples

### SQL Operations
```typescript
// Standard CRUD operations work across all SQL adapters
const users = await db.query('SELECT * FROM users WHERE age > ?', [18]);
const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [1]);
const newUser = await db.insert('users', { name: 'John', email: 'john@example.com' });
const updated = await db.update('users', { name: 'Jane' }, { id: 1 });
const deleted = await db.delete('users', { id: 1 });
```

### MongoDB Operations
```typescript
// MongoDB uses collections instead of tables
const users = await mongoDb.query('users'); // Get all
const users = await mongoDb.query('users', { age: { $gte: 18 } }); // Query
const user = await mongoDb.queryOne('users', { email: 'john@example.com' });

// MongoDB-specific methods
const stats = await mongoDb.aggregate('users', [
  { $group: { _id: null, avgAge: { $avg: '$age' } } }
]);
await mongoDb.createIndex('users', { email: 1 }, { unique: true });
```

### Redis Operations
```typescript
// Key-value operations
await redisDb.set('user:123', userData, 3600); // with TTL
const user = await redisDb.get('user:123');

// Redis-specific methods
await redisDb.incr('page:views');
await redisDb.lpush('tasks', taskData);
await redisDb.publish('notifications', message);
```

### Drizzle ORM Operations
```typescript
// Type-safe queries (requires schema setup)
const users = await drizzleDb.select('users').where(eq(schema.users.age, 25));
const newUser = await drizzleDb.insertInto('users').values(userData).returning();

// Raw SQL fallback
const users = await drizzleDb.query('SELECT * FROM users WHERE age > ?', [18]);
```

## Installation

Choose and install the appropriate database package:

```bash
# SQL Databases
npm install mysql2                    # MySQL
npm install pg @types/pg             # PostgreSQL  
npm install better-sqlite3           # SQLite

# NoSQL Databases
npm install mongodb                  # MongoDB
npm install ioredis                  # Redis

# ORM
npm install drizzle-orm              # Drizzle ORM
# Plus the appropriate driver (mysql2, pg, better-sqlite3, etc.)
```

The adapters will gracefully handle missing packages with helpful error messages. 