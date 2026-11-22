import { mkdir, readFile, rename, rm, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INDEX = '.index.json';

/**
 * Local-disk store for opaque (already encrypted) session blobs.
 * Use only where the disk survives restarts (VPS, persistent volume, Termux).
 * A small side index remembers each entry's category (never its name or content)
 * so the session cleaner can tell disposable entries from critical ones.
 */
export class FileStore {
    constructor(dir) {
        this.dir = dir;
        this.kind = 'file';
        this.types = new Map();
        this.flushTimer = null;
    }

    async init() {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        try {
            this.types = new Map(Object.entries(JSON.parse(await readFile(path.join(this.dir, INDEX), 'utf8'))));
        } catch {
            this.types = new Map();
        }
    }

    #path(key) {
        return path.join(this.dir, `${key}.enc`);
    }

    #scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.#flush().catch(() => {});
        }, 5000);
        this.flushTimer.unref?.();
    }

    async #flush() {
        const file = path.join(this.dir, INDEX);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(Object.fromEntries(this.types)), { mode: 0o600 });
        await rename(tmp, file);
    }

    async get(key) {
        try {
            return await readFile(this.#path(key));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async set(key, buffer, meta = {}) {
        // Atomic write: never leave a half-written credential file.
        const file = this.#path(key);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, buffer, { mode: 0o600 });
        await rename(tmp, file);
        if (meta.type && this.types.get(key) !== meta.type) {
            this.types.set(key, meta.type);
            this.#scheduleFlush();
        }
    }

    async delete(key) {
        await unlink(this.#path(key)).catch(() => {});
        if (this.types.delete(key)) this.#scheduleFlush();
    }

    /** Keys of the given categories whose last write is older than `before` (Date). */
    async listStale({ types, before }) {
        const wanted = new Set(types);
        const keys = [];
        for (const [key, type] of this.types) {
            if (!wanted.has(type)) continue;
            const info = await stat(this.#path(key)).catch(() => null);
            if (!info) {
                this.types.delete(key);
                continue;
            }
            if (info.mtime < before) keys.push(key);
        }
        return keys;
    }

    async clear() {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        await rm(this.dir, { recursive: true, force: true });
        this.types = new Map();
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }

    async count() {
        const files = await readdir(this.dir).catch(() => []);
        return files.filter((f) => f.endsWith('.enc')).length;
    }

    async close() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
            await this.#flush().catch(() => {});
        }
    }
}
