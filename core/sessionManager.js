import { Mutex } from 'async-mutex';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { decrypt, encrypt, hashName, assertEncryptionReady } from '../systems/security/encryption.js';
import { createSessionStore } from '../systems/storage/index.js';
import { EncryptionError, SessionIntegrityError } from '../utils/errors.js';
import { child } from './logger.js';

const log = child('session');

// Longest names first so "sender-key-memory" is not read as "sender-key".
const CATEGORIES = [
    'app-state-sync-version',
    'app-state-sync-key',
    'sender-key-memory',
    'identity-key',
    'lid-mapping',
    'device-list',
    'sender-key',
    'pre-key',
    'session',
    'tctoken'
];

/** Category of a session entry name ("creds.json" → "creds", "session-123.0.json" → "session"). */
export const entryCategory = (name) => {
    if (name === 'creds.json') return 'creds';
    return CATEGORIES.find((c) => name.startsWith(`${c}-`)) || 'other';
};

/**
 * Categories that are safe to drop when stale: Signal sessions, group sender keys and
 * caches that WhatsApp renegotiates on the next message. Never creds, pre-keys,
 * app-state keys or LID mappings.
 */
export const DISPOSABLE_CATEGORIES = Object.freeze(['session', 'sender-key', 'sender-key-memory', 'device-list']);

/**
 * Encrypted authentication-state adapter for Baileys.
 *
 * It implements the same contract as Baileys' useMultiFileAuthState
 * ({ state: { creds, keys: { get, set } }, saveCreds }). Every entry is
 * encrypted with AES-256-GCM here before it reaches the store (local files
 * or MongoDB), and verified on the way back. Stores only see ciphertext.
 */
class SessionManager {
    constructor(store = createSessionStore()) {
        this.store = store;
        this.locks = new Map();
        this.ready = null;
    }

    #lock(file) {
        let mutex = this.locks.get(file);
        if (!mutex) {
            mutex = new Mutex();
            this.locks.set(file, mutex);
        }
        return mutex;
    }

    /** Runs `fn` under the entry's lock, then drops the idle lock so the map cannot grow forever. */
    async #exclusive(key, fn) {
        const mutex = this.#lock(key);
        try {
            return await mutex.runExclusive(fn);
        } finally {
            if (!mutex.isLocked() && this.locks.get(key) === mutex) this.locks.delete(key);
        }
    }

    #key(name) {
        return hashName(name);
    }

    async #ensureReady() {
        this.ready ||= this.store.init().then(() => log.info({ store: this.store.kind }, 'Session store ready.'));
        try {
            await this.ready;
        } catch (error) {
            this.ready = null;
            throw error;
        }
    }

    async #write(name, value) {
        await this.#ensureReady();
        const key = this.#key(name);
        const payload = encrypt(JSON.stringify(value, BufferJSON.replacer), name);
        await this.#exclusive(key, () => this.store.set(key, payload, { type: entryCategory(name) }));
    }

    async #read(name) {
        await this.#ensureReady();
        const key = this.#key(name);
        return this.#exclusive(key, async () => {
            const payload = await this.store.get(key);
            if (!payload) return null;
            try {
                return JSON.parse(decrypt(payload, name).toString('utf8'), BufferJSON.reviver);
            } catch (error) {
                if (error instanceof EncryptionError) {
                    throw new SessionIntegrityError(`Session entry could not be verified (${name}). ${error.message}`);
                }
                throw new SessionIntegrityError(`Session entry is corrupted (${name}).`);
            }
        });
    }

    async #remove(name) {
        await this.#ensureReady();
        const key = this.#key(name);
        await this.#exclusive(key, () => this.store.delete(key));
    }

    /** Returns true when stored credentials represent a completed WhatsApp link. */
    async hasValidSession() {
        assertEncryptionReady();
        await this.#ensureReady();
        const creds = await this.#read('creds.json');
        return Boolean(creds?.me?.id && creds?.account);
    }

    /** Baileys-compatible auth state backed by encrypted files. */
    async loadAuthState() {
        assertEncryptionReady();
        await this.#ensureReady();
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
        await this.#ensureReady();
        await this.store.clear();
        this.locks.clear();
        log.warn('Session data deleted.');
    }

    /**
     * Removes disposable entries untouched for `minAgeMs`. Critical files are never touched.
     * Returns the number of removed entries.
     */
    async cleanup({ minAgeMs }) {
        await this.#ensureReady();
        if (typeof this.store.listStale !== 'function') return 0;
        const keys = await this.store.listStale({ types: [...DISPOSABLE_CATEGORIES], before: new Date(Date.now() - minAgeMs) });
        for (const key of keys) {
            await this.#exclusive(key, () => this.store.delete(key));
        }
        return keys.length;
    }

    async fileCount() {
        await this.#ensureReady();
        return this.store.count();
    }

    async close() {
        await this.store.close();
        this.ready = null;
    }
}

const sessionManager = new SessionManager();
export default sessionManager;
export { SessionManager };
