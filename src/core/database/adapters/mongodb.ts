// Database MongoDB Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { resolveUserPackage } from '../../utilities/package-utils.js';

interface MongoDBConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  authSource?: string;
  ssl?: boolean;
  tls?: {
    ca?: string;
    cert?: string;
    key?: string;
    passphrase?: string;
    insecure?: boolean;
    allowInvalidCertificates?: boolean;
    allowInvalidHostnames?: boolean;
    checkServerIdentity?: boolean;
  };
  replicaSet?: string;
  maxPoolSize?: number;
  minPoolSize?: number;
}

interface MongoDocument {
  _id?: any;
  [key: string]: any;
}

export class MongoDBAdapter implements DatabaseAdapter {
  private client: any;
  private db: any;
  private logger = createFrameworkLogger('MongoDB');
  private initPromise: Promise<void>;

  constructor(config: MongoDBConfig) {
    this.initPromise = this.initialize(config);
  }

  private async initialize(config: MongoDBConfig): Promise<void> {
    try {
      const mongodbPath = resolveUserPackage('mongodb');
      const mongodb = await import(mongodbPath);
      const { MongoClient } = mongodb;

      const url = config.url || this.buildConnectionString(config);

      const clientOptions: any = {
        maxPoolSize: config.maxPoolSize || 10,
        minPoolSize: config.minPoolSize || 0,
        ssl: config.ssl || false,
      };

      // Add TLS options if provided
      if (config.tls) {
        clientOptions.tls = true;
        if (config.tls.ca) clientOptions.tlsCAFile = config.tls.ca;
        if (config.tls.cert) clientOptions.tlsCertificateFile = config.tls.cert;
        if (config.tls.key) clientOptions.tlsCertificateKeyFile = config.tls.key;
        if (config.tls.passphrase)
          clientOptions.tlsCertificateKeyFilePassword = config.tls.passphrase;
        if (config.tls.insecure) clientOptions.tlsInsecure = config.tls.insecure;
        if (config.tls.allowInvalidCertificates)
          clientOptions.tlsAllowInvalidCertificates = config.tls.allowInvalidCertificates;
        if (config.tls.allowInvalidHostnames)
          clientOptions.tlsAllowInvalidHostnames = config.tls.allowInvalidHostnames;
        if (config.tls.checkServerIdentity === false) clientOptions.checkServerIdentity = false;
      }

      this.client = new MongoClient(url, clientOptions);

      this.db = this.client.db(config.database || 'moro_app');

      this.logger.info('MongoDB adapter initialized', 'MongoDB');
    } catch (error) {
      throw new Error(
        'mongodb package is required for MongoDB adapter. Install it with: npm install mongodb'
      );
    }
  }

  private buildConnectionString(config: MongoDBConfig): string {
    const host = config.host || 'localhost';
    const port = config.port || 27017;
    const auth = config.username && config.password ? `${config.username}:${config.password}@` : '';
    const authSource = config.authSource ? `?authSource=${config.authSource}` : '';

    return `mongodb://${auth}${host}:${port}/${config.database || 'moro_app'}${authSource}`;
  }

  async connect(): Promise<void> {
    await this.initPromise;
    try {
      await this.client.connect();
      await this.client.db('admin').command({ ping: 1 });
      this.logger.info('MongoDB connection established', 'Connection');
    } catch (error) {
      this.logger.error('MongoDB connection failed', 'Connection', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.initPromise;
    await this.client.close();
  }

  // For MongoDB, we'll treat "sql" as collection name and "params" as query/pipeline
  async query<T = any>(collection: string, pipeline?: any[]): Promise<T[]> {
    await this.initPromise;
    try {
      const coll = this.db.collection(collection);

      if (pipeline && Array.isArray(pipeline)) {
        // Aggregation pipeline
        const cursor = coll.aggregate(pipeline);
        return await cursor.toArray();
      } else if (pipeline) {
        // Find query
        const cursor = coll.find(pipeline);
        return await cursor.toArray();
      } else {
        // Find all
        const cursor = coll.find({});
        return await cursor.toArray();
      }
    } catch (error) {
      this.logger.error('MongoDB query failed', 'Query', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async queryOne<T = any>(collection: string, query?: any): Promise<T | null> {
    await this.initPromise;
    try {
      const coll = this.db.collection(collection);
      return await coll.findOne(query || {});
    } catch (error) {
      this.logger.error('MongoDB queryOne failed', 'Query', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async insert<T = any>(collection: string, data: Record<string, any>): Promise<T> {
    await this.initPromise;
    try {
      const coll = this.db.collection(collection);
      const result = await coll.insertOne(data);

      // Return the inserted document with _id
      return { ...data, _id: result.insertedId } as T;
    } catch (error) {
      this.logger.error('MongoDB insert failed', 'Insert', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async update<T = any>(
    collection: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    await this.initPromise;
    try {
      const coll = this.db.collection(collection);
      const result = await coll.findOneAndUpdate(
        where,
        { $set: data },
        { returnDocument: 'after' }
      );

      return result.value as T;
    } catch (error) {
      this.logger.error('MongoDB update failed', 'Update', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async delete(collection: string, where: Record<string, any>): Promise<number> {
    await this.initPromise;
    try {
      const coll = this.db.collection(collection);
      const result = await coll.deleteMany(where);
      return result.deletedCount || 0;
    } catch (error) {
      this.logger.error('MongoDB delete failed', 'Delete', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    await this.initPromise;
    const session = this.client.startSession();

    try {
      return await session.withTransaction(async () => {
        const transaction = new MongoDBTransaction(this.db, session);
        return await callback(transaction);
      });
    } finally {
      await session.endSession();
    }
  }

  // MongoDB-specific methods
  async aggregate<T = any>(collection: string, pipeline: any[]): Promise<T[]> {
    await this.initPromise;
    const coll = this.db.collection(collection);
    const cursor = coll.aggregate(pipeline);
    return await cursor.toArray();
  }

  async createIndex(collection: string, index: any, options?: any): Promise<string> {
    await this.initPromise;
    const coll = this.db.collection(collection);
    return await coll.createIndex(index, options);
  }

  async dropIndex(collection: string, indexName: string): Promise<any> {
    await this.initPromise;
    const coll = this.db.collection(collection);
    return await coll.dropIndex(indexName);
  }

  async count(collection: string, query?: any): Promise<number> {
    await this.initPromise;
    const coll = this.db.collection(collection);
    return await coll.countDocuments(query || {});
  }

  getCollection(name: string) {
    return this.db.collection(name);
  }
}

class MongoDBTransaction implements DatabaseTransaction {
  constructor(
    private db: any,
    private session: any
  ) {}

  async query<T = any>(collection: string, pipeline?: any[]): Promise<T[]> {
    const coll = this.db.collection(collection);

    if (pipeline && Array.isArray(pipeline)) {
      const cursor = coll.aggregate(pipeline, { session: this.session });
      return await cursor.toArray();
    } else if (pipeline) {
      const cursor = coll.find(pipeline, { session: this.session });
      return await cursor.toArray();
    } else {
      const cursor = coll.find({}, { session: this.session });
      return await cursor.toArray();
    }
  }

  async queryOne<T = any>(collection: string, query?: any): Promise<T | null> {
    const coll = this.db.collection(collection);
    return await coll.findOne(query || {}, { session: this.session });
  }

  async insert<T = any>(collection: string, data: Record<string, any>): Promise<T> {
    const coll = this.db.collection(collection);
    const result = await coll.insertOne(data, { session: this.session });
    return { ...data, _id: result.insertedId } as T;
  }

  async update<T = any>(
    collection: string,
    data: Record<string, any>,
    where: Record<string, any>
  ): Promise<T> {
    const coll = this.db.collection(collection);
    const result = await coll.findOneAndUpdate(
      where,
      { $set: data },
      { returnDocument: 'after', session: this.session }
    );
    return result.value as T;
  }

  async delete(collection: string, where: Record<string, any>): Promise<number> {
    const coll = this.db.collection(collection);
    const result = await coll.deleteMany(where, { session: this.session });
    return result.deletedCount || 0;
  }

  async commit(): Promise<void> {
    await this.session.commitTransaction();
  }

  async rollback(): Promise<void> {
    await this.session.abortTransaction();
  }
}
