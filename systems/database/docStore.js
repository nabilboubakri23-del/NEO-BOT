import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { describeError } from '../../utils/errors.js';

const log = child('database');

/**
 * Small JSON document database for bot data (settings, users, stats).
 * Each document is one named JSON value:
 *   - MongoDB (when MONGODB_URI is set): collection "documents", { _id: name, data }
 *   - otherwise: data/<name>.json (atomic writes)
 * Documents are kept in memory and written back with a short debounce,
 * so hot paths (every message) never wait on disk or network.
 */

const DATA_DIR = path.join(config.rootDir, 'data');
const SAVE_DELAY_MS = 3000;

class FileBackend {
    kind = 'file';
    async init() {
        await mkdir(DATA_DIR, { recursive: true });
    }
    async read(name) {
        const file = path.join(DATA_DIR, `${name}.json`);
        if (!existsSync(file)) return undefined;
        return JSON.parse(await readFile(file, 'utf8'));
    }
    async write(name, data) {
        const file = path.join(DATA_DIR, `${name}.json`);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await rename(tmp, file);
    }
    async close() {}
}

class MongoBackend {
    kind = 'mongodb';
    constructor(uri, dbName) {
        this.uri = uri;
        this.dbName = dbName;
    }
    async init() {
        this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 15000 });
        await this.client.connect();
        this.col = this.client.db(this.dbName).collection('documents');
    }
    async read(name) {
        const doc = await this.col.findOne({ _id: name });
        return doc?.data;
    }
    async write(name, data) {
        await this.col.updateOne({ _id: name }, { $set: { data, updatedAt: new Date() } }, { upsert: true });
    }
    async close() {
        await this.client?.close().catch(() => {});
    }
}

class DocStore {
    constructor() {
        this.backend = null;
        this.docs = new Map(); // name → { data, timer, dirty }
        this.ready = null;
    }

    /** Opens the backend once. Falls back to files if MongoDB is unreachable. */
    init(backend) {
        this.ready ||= (async () => {
            this.backend = backend || (config.session.mongoUri ? new MongoBackend(config.session.mongoUri, config.session.mongoDb) : new FileBackend());
            try {
                await this.backend.init();
            } catch (error) {
                log.error(`Database "${this.backend.kind}" unavailable, using local files: ${describeError(error)}`);
                this.backend = new FileBackend();
                await this.backend.init();
            }
            log.info({ backend: this.backend.kind }, 'Database ready.');
        })();
        return this.ready;
    }

    get kind() {
        return this.backend?.kind || 'none';
    }

    /** Loads a document (once) and returns its live in-memory object. */
    async open(name, defaults = () => ({})) {
        await this.init();
        if (this.docs.has(name)) return this.docs.get(name).data;
        let data;
        try {
            data = await this.backend.read(name);
        } catch (error) {
            log.error(`Failed to read "${name}": ${describeError(error)}`);
        }
        const entry = { data: data ?? defaults(), timer: null, dirty: false };
        this.docs.set(name, entry);
        return entry.data;
    }

    /** Marks a document as changed; it is written after a short delay. */
    touch(name) {
        const entry = this.docs.get(name);
        if (!entry) return;
        entry.dirty = true;
        if (entry.timer) return;
        entry.timer = setTimeout(() => this.#write(name).catch(() => {}), SAVE_DELAY_MS);
        entry.timer.unref?.();
    }

    async #write(name) {
        const entry = this.docs.get(name);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.timer = null;
        if (!entry.dirty) return;
        entry.dirty = false;
        try {
            await this.backend.write(name, entry.data);
        } catch (error) {
            entry.dirty = true;
            log.error(`Failed to save "${name}": ${describeError(error)}`);
            throw error;
        }
    }

    /** Writes every pending document now (shutdown, tests). */
    async flush() {
        await Promise.allSettled([...this.docs.keys()].map((name) => this.#write(name)));
    }

    async close() {
        await this.flush();
        await this.backend?.close();
    }
}

const docStore = new DocStore();
export default docStore;
export { DocStore, FileBackend };
