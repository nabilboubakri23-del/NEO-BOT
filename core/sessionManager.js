import { mkdir, readFile, rename, rm, stat, unlink, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Mutex } from 'async-mutex';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import config from '../config/config.js';
import { decrypt, encrypt, hashName, assertEncryptionReady } from '../systems/security/encryption.js';
import { EncryptionError, SessionIntegrityError } from '../utils/errors.js';
import { child } from './logger.js';

const log = child('session');

/**
 * Encrypted authentication-state storage adapter for Baileys.
 *
 * It implements the same contract as Baileys' useMultiFileAuthState
 * ({ state: { creds, keys: { get, set } }, saveCreds }) but every file is
 * written with AES-256-GCM and read back through integrity verification.
 * Baileys never touches plaintext files on disk.
 */
class SessionManager {
    constructor(dir = config.session.dir) {
        this.dir = dir;
        this.locks = new Map();
    }

    #lock(file) {
        let mutex = this.locks.get(file);
        if (!mutex) {
            mutex = new Mutex();
            this.locks.set(file, mutex);
        }
        return mutex;
    }

    #filePath(name) {
        return path.join(this.dir, `${hashName(name)}.enc`);
    }

    async #ensureDir() {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }

    async #write(name, value) {
        const file = this.#filePath(name);
        const payload = encrypt(JSON.stringify(value, BufferJSON.replacer), name);
        await this.#lock(file).runExclusive(async () => {
            // Atomic write: never leave a half-written credential file.
            const tmp = `${file}.${process.pid}.tmp`;
            await writeFile(tmp, payload, { mode: 0o600 });
            await rename(tmp, file);
        });
    }

    async #read(name) {
        const file = this.#filePath(name);
        return this.#lock(file).runExclusive(async () => {
            let payload;
            try {
                payload = await readFile(file);
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
            try {
                return JSON.parse(decrypt(payload, name).toString('utf8'), BufferJSON.reviver);
            } catch (error) {
                if (error instanceof EncryptionError) {
                    throw new SessionIntegrityError(`Session file could not be verified (${name}). ${error.message}`);
                }
                throw new SessionIntegrityError(`Session file is corrupted (${name}).`);
            }
        });
    }

    async #remove(name) {
        const file = this.#filePath(name);
        await this.#lock(file).runExclusive(() => unlink(file).catch(() => {}));
    }

    /** Returns true when stored credentials represent a completed WhatsApp link. */
    async hasValidSession() {
        assertEncryptionReady();
        await this.#ensureDir();
        const creds = await this.#read('creds.json');
        return Boolean(creds?.me?.id && creds?.account);
    }

    /** Baileys-compatible auth state backed by encrypted files. */
    async loadAuthState() {
        assertEncryptionReady();
        await this.#ensureDir();
        const creds = (await this.#read('creds.json')) || initAuthCreds();

        const state = {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await this.#read(`${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const name = `${category}-${id}.json`;
                            tasks.push(value ? this.#write(name, value) : this.#remove(name));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        };

        const saveCreds = () => this.#write('creds.json', state.creds);
        return { state, saveCreds };
    }

    /** Permanently deletes the stored session (logout / revoked / reset). */
    async deleteSession() {
        await rm(this.dir, { recursive: true, force: true });
        await this.#ensureDir();
        this.locks.clear();
        log.warn('Session data deleted.');
    }

    async fileCount() {
        const info = await stat(this.dir).catch(() => null);
        if (!info) return 0;
        return (await readdir(this.dir)).filter((f) => f.endsWith('.enc')).length;
    }
}

const sessionManager = new SessionManager();
export default sessionManager;
export { SessionManager };
