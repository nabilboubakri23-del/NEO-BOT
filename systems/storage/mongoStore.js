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

    async set(key, buffer, meta = {}) {
        // `type` is the entry's category only (e.g. "session"), used by the session cleaner.
        await this.col.updateOne(
            { _id: key },
            { $set: { data: new Binary(buffer), updatedAt: new Date(), ...(meta.type ? { type: meta.type } : {}) } },
            { upsert: true }
        );
    }

    async delete(key) {
        await this.col.deleteOne({ _id: key });
    }

    /** Keys of the given categories whose last write is older than `before` (Date). */
    async listStale({ types, before }) {
        const docs = await this.col.find({ type: { $in: types }, updatedAt: { $lt: before } }, { projection: { _id: 1 } }).toArray();
        return docs.map((d) => d._id);
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
