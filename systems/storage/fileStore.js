import { mkdir, readFile, rename, rm, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Local-disk store for opaque (already encrypted) session blobs.
 * Use only where the disk survives restarts (VPS, persistent volume).
 */
export class FileStore {
    constructor(dir) {
        this.dir = dir;
        this.kind = 'file';
    }

    async init() {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }

    #path(key) {
        return path.join(this.dir, `${key}.enc`);
    }

    async get(key) {
        try {
            return await readFile(this.#path(key));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async set(key, buffer) {
        // Atomic write: never leave a half-written credential file.
        const file = this.#path(key);
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, buffer, { mode: 0o600 });
        await rename(tmp, file);
    }

    async delete(key) {
        await unlink(this.#path(key)).catch(() => {});
    }

    async clear() {
        await rm(this.dir, { recursive: true, force: true });
        await this.init();
    }

    async count() {
        const files = await readdir(this.dir).catch(() => []);
        return files.filter((f) => f.endsWith('.enc')).length;
    }

    async close() {}
}
