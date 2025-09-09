"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoDBAdapter = void 0;
const logger_1 = require("../../logger");
class MongoDBAdapter {
    client;
    db;
    logger = (0, logger_1.createFrameworkLogger)("MongoDB");
    constructor(config) {
        try {
            const { MongoClient } = require("mongodb");
            const url = config.url || this.buildConnectionString(config);
            this.client = new MongoClient(url, {
                maxPoolSize: config.maxPoolSize || 10,
                minPoolSize: config.minPoolSize || 0,
                ssl: config.ssl || false,
            });
            this.db = this.client.db(config.database || "moro_app");
            this.logger.info("MongoDB adapter initialized", "MongoDB");
        }
        catch (error) {
            throw new Error("mongodb package is required for MongoDB adapter. Install it with: npm install mongodb");
        }
    }
    buildConnectionString(config) {
        const host = config.host || "localhost";
        const port = config.port || 27017;
        const auth = config.username && config.password
            ? `${config.username}:${config.password}@`
            : "";
        const authSource = config.authSource
            ? `?authSource=${config.authSource}`
            : "";
        return `mongodb://${auth}${host}:${port}/${config.database || "moro_app"}${authSource}`;
    }
    async connect() {
        try {
            await this.client.connect();
            await this.client.db("admin").command({ ping: 1 });
            this.logger.info("MongoDB connection established", "Connection");
        }
        catch (error) {
            this.logger.error("MongoDB connection failed", "Connection", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async disconnect() {
        await this.client.close();
    }
    // For MongoDB, we'll treat "sql" as collection name and "params" as query/pipeline
    async query(collection, pipeline) {
        try {
            const coll = this.db.collection(collection);
            if (pipeline && Array.isArray(pipeline)) {
                // Aggregation pipeline
                const cursor = coll.aggregate(pipeline);
                return await cursor.toArray();
            }
            else if (pipeline) {
                // Find query
                const cursor = coll.find(pipeline);
                return await cursor.toArray();
            }
            else {
                // Find all
                const cursor = coll.find({});
                return await cursor.toArray();
            }
        }
        catch (error) {
            this.logger.error("MongoDB query failed", "Query", {
                collection,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async queryOne(collection, query) {
        try {
            const coll = this.db.collection(collection);
            return await coll.findOne(query || {});
        }
        catch (error) {
            this.logger.error("MongoDB queryOne failed", "Query", {
                collection,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async insert(collection, data) {
        try {
            const coll = this.db.collection(collection);
            const result = await coll.insertOne(data);
            // Return the inserted document with _id
            return { ...data, _id: result.insertedId };
        }
        catch (error) {
            this.logger.error("MongoDB insert failed", "Insert", {
                collection,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async update(collection, data, where) {
        try {
            const coll = this.db.collection(collection);
            const result = await coll.findOneAndUpdate(where, { $set: data }, { returnDocument: "after" });
            return result.value;
        }
        catch (error) {
            this.logger.error("MongoDB update failed", "Update", {
                collection,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async delete(collection, where) {
        try {
            const coll = this.db.collection(collection);
            const result = await coll.deleteMany(where);
            return result.deletedCount || 0;
        }
        catch (error) {
            this.logger.error("MongoDB delete failed", "Delete", {
                collection,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    async transaction(callback) {
        const session = this.client.startSession();
        try {
            return await session.withTransaction(async () => {
                const transaction = new MongoDBTransaction(this.db, session);
                return await callback(transaction);
            });
        }
        finally {
            await session.endSession();
        }
    }
    // MongoDB-specific methods
    async aggregate(collection, pipeline) {
        const coll = this.db.collection(collection);
        const cursor = coll.aggregate(pipeline);
        return await cursor.toArray();
    }
    async createIndex(collection, index, options) {
        const coll = this.db.collection(collection);
        return await coll.createIndex(index, options);
    }
    async dropIndex(collection, indexName) {
        const coll = this.db.collection(collection);
        return await coll.dropIndex(indexName);
    }
    async count(collection, query) {
        const coll = this.db.collection(collection);
        return await coll.countDocuments(query || {});
    }
    getCollection(name) {
        return this.db.collection(name);
    }
}
exports.MongoDBAdapter = MongoDBAdapter;
class MongoDBTransaction {
    db;
    session;
    constructor(db, session) {
        this.db = db;
        this.session = session;
    }
    async query(collection, pipeline) {
        const coll = this.db.collection(collection);
        if (pipeline && Array.isArray(pipeline)) {
            const cursor = coll.aggregate(pipeline, { session: this.session });
            return await cursor.toArray();
        }
        else if (pipeline) {
            const cursor = coll.find(pipeline, { session: this.session });
            return await cursor.toArray();
        }
        else {
            const cursor = coll.find({}, { session: this.session });
            return await cursor.toArray();
        }
    }
    async queryOne(collection, query) {
        const coll = this.db.collection(collection);
        return await coll.findOne(query || {}, { session: this.session });
    }
    async insert(collection, data) {
        const coll = this.db.collection(collection);
        const result = await coll.insertOne(data, { session: this.session });
        return { ...data, _id: result.insertedId };
    }
    async update(collection, data, where) {
        const coll = this.db.collection(collection);
        const result = await coll.findOneAndUpdate(where, { $set: data }, { returnDocument: "after", session: this.session });
        return result.value;
    }
    async delete(collection, where) {
        const coll = this.db.collection(collection);
        const result = await coll.deleteMany(where, { session: this.session });
        return result.deletedCount || 0;
    }
    async commit() {
        await this.session.commitTransaction();
    }
    async rollback() {
        await this.session.abortTransaction();
    }
}
