// Database MongoDB Adapter
import { DatabaseAdapter, DatabaseTransaction } from '../../../types/database.js';
import { createFrameworkLogger } from '../../logger/index.js';
import { promises as fs } from 'fs';
import { importDriver, acceptAnyServerIdentity } from './driver-support.js';

interface MongoDBConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  authSource?: string;
  ssl?: boolean;
  /**
   * TLS settings; giving this object turns TLS on. `ca`, `cert` and `key` are
   * each a file path or the PEM text itself. `key` may be a file that holds
   * both the client key and its certificate, in which case `cert` is not needed.
   */
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

// interface MongoDocument {
//   _id?: any;
//   [key: string]: any;
// }

const isPemText = (value: string): boolean => value.includes('-----BEGIN');

/**
 * The driver options for a `tls` config object. The driver reads the CA and
 * the client key from files (`tlsCAFile`, `tlsCertificateKeyFile`) and has no
 * file option for a certificate kept apart from its key, so a `cert` path is
 * read here; PEM text goes to the socket options the driver passes to Node.
 */
async function mongoTlsOptions(tls: NonNullable<MongoDBConfig['tls']>): Promise<any> {
  const options: any = { tls: true };
  if (tls.ca) {
    if (isPemText(tls.ca)) options.ca = tls.ca;
    else options.tlsCAFile = tls.ca;
  }
  if (tls.key) {
    if (isPemText(tls.key)) options.key = tls.key;
    else options.tlsCertificateKeyFile = tls.key;
  }
  if (tls.cert) {
    options.cert = isPemText(tls.cert) ? tls.cert : await fs.readFile(tls.cert, 'utf8');
  } else if (options.key) {
    // PEM text holding both the key and its certificate, as a key file may
    options.cert = options.key;
  }
  if (tls.passphrase) options.tlsCertificateKeyFilePassword = tls.passphrase;
  if (tls.insecure) options.tlsInsecure = tls.insecure;
  if (tls.allowInvalidCertificates) {
    options.tlsAllowInvalidCertificates = tls.allowInvalidCertificates;
  }
  if (tls.allowInvalidHostnames) options.tlsAllowInvalidHostnames = tls.allowInvalidHostnames;
  // The socket option is a function: `false` means "accept any host name",
  // `true` is the default check and is left to the driver.
  const identity: unknown = tls.checkServerIdentity;
  if (identity === false) options.checkServerIdentity = acceptAnyServerIdentity;
  else if (typeof identity === 'function') options.checkServerIdentity = identity;
  return options;
}

// Characters that end or split the userinfo part of a connection string
const USERINFO_DELIMITERS = /[:/?#[\]@]/;

/**
 * A username or password as it goes into the connection string. One holding a
 * delimiter is percent-encoded (the driver decodes it); any other value,
 * including one the caller already percent-encoded, is used as given.
 */
function userinfoPart(value: string): string {
  return USERINFO_DELIMITERS.test(value) ? encodeURIComponent(value) : value;
}

/**
 * findOneAndUpdate() resolves to the document itself from driver 6 on, and to
 * `{ value, lastErrorObject, ok }` on earlier drivers.
 */
function updatedDocument(result: any): any {
  if (result && typeof result === 'object' && 'lastErrorObject' in result && 'ok' in result) {
    return result.value;
  }
  return result;
}

export class MongoDBAdapter implements DatabaseAdapter {
  private client: any;
  private db: any;
  private logger = createFrameworkLogger('MongoDB');
  private initPromise: Promise<void>;
  // Marked false on a client 'error'/'close' so callers can observe an unhealthy adapter
  private isConnected = false;

  constructor(config: MongoDBConfig) {
    this.initPromise = this.initialize(config);
  }

  private async initialize(config: MongoDBConfig): Promise<void> {
    const mongodb = await importDriver(
      'mongodb',
      'mongodb package is required for MongoDB adapter. Install it with: npm install mongodb'
    );
    const { MongoClient } = mongodb;

    const url = config.url || this.buildConnectionString(config);

    const clientOptions: any = {
      maxPoolSize: config.maxPoolSize || 10,
      minPoolSize: config.minPoolSize || 0,
    };

    if (config.tls) {
      // The driver refuses `ssl` and `tls` that disagree, so `ssl` is only
      // repeated when it was set.
      Object.assign(clientOptions, await mongoTlsOptions(config.tls));
      if (config.ssl) clientOptions.ssl = true;
    } else {
      clientOptions.ssl = config.ssl || false;
    }

    this.client = new MongoClient(url, clientOptions);

    // MongoClient is an EventEmitter; without an 'error' listener a topology
    // error (e.g. after a server restart) could surface as an unhandled 'error'
    // and crash the process.
    this.client.on('error', (err: Error) => {
      this.isConnected = false;
      this.logger.error('MongoDB client error', 'Connection', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.client.on('close', () => {
      this.isConnected = false;
      this.logger.warn('MongoDB connection closed', 'Connection');
    });

    this.db = this.client.db(config.database || 'moro_app');

    this.logger.info('MongoDB adapter initialized', 'MongoDB');
  }

  private buildConnectionString(config: MongoDBConfig): string {
    const host = config.host || 'localhost';
    const port = config.port || 27017;
    const auth =
      config.username && config.password
        ? `${userinfoPart(config.username)}:${userinfoPart(config.password)}@`
        : '';
    const authSource = config.authSource ? `?authSource=${config.authSource}` : '';

    return `mongodb://${auth}${host}:${port}/${config.database || 'moro_app'}${authSource}`;
  }

  async connect(): Promise<void> {
    await this.initPromise;
    try {
      await this.client.connect();
      await this.client.db('admin').command({ ping: 1 });
      this.isConnected = true;
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
        { returnDocument: 'after', includeResultMetadata: false }
      );

      return updatedDocument(result) as T;
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
      { returnDocument: 'after', includeResultMetadata: false, session: this.session }
    );
    return updatedDocument(result) as T;
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
