import { MongoClient, Binary } from 'mongodb';

/**
 * MongoDB store for opaque (already encrypted) session blobs.
 * Used on hosts with an ephemeral filesystem (Render free, etc.).
 * The database only ever sees hashed keys and AES-256-GCM ciphertext.
 */
export class MongoStore {
    constructor(uri, { dbName = 'neobot', collection = 'auth_state' } = {}) {
        this.uri = uri;
        this.dbName = dbName;
        this.collectionName = collection;
        this.kind = 'mongodb';
        this.client = null;
        this.col = null;
    }

    async init() {
        if (this.col) return;
        this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000 });
        await this.client.connect();
        this.col = this.client.db(this.dbName).collection(this.collectionName);
    }

    async get(key) {
        const doc = await this.col.findOne({ _id: key });
        return doc ? Buffer.from(doc.data.buffer) : null;
    }

    async set(key, buffer) {
        await this.col.updateOne(
            { _id: key },
            { $set: { data: new Binary(buffer), updatedAt: new Date() } },
            { upsert: true }
        );
    }

    async delete(key) {
        await this.col.deleteOne({ _id: key });
    }

    async clear() {
        await this.col.deleteMany({});
    }

    async count() {
        return this.col.countDocuments();
    }

    async close() {
        await this.client?.close().catch(() => {});
        this.client = null;
        this.col = null;
    }
}
