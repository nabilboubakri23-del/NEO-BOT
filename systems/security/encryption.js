import crypto from 'node:crypto';
import config from '../../config/config.js';
import { EncryptionError } from '../../utils/errors.js';
import { isHexKey } from '../../utils/validators.js';

/**
 * AES-256-GCM encryption for data stored at rest.
 *
 * Payload layout (binary):
 *   [ magic "NEO1" (4) | iv (12) | authTag (16) | ciphertext (n) ]
 *
 * A fresh random IV is generated for every encryption. The auth tag is
 * verified on every decryption, so any tampering or wrong key fails loudly.
 */

const ALGORITHM = 'aes-256-gcm';
const MAGIC = Buffer.from('NEO1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + TAG_LENGTH;

let cachedKey = null;

const getKey = () => {
    if (cachedKey) return cachedKey;
    const raw = config.session.encryptionKey;
    if (!isHexKey(raw, 32)) {
        throw new EncryptionError(
            'SESSION_ENCRYPTION_KEY is missing or invalid. It must be 64 hex characters (32 bytes). Generate one with: npm run genkey'
        );
    }
    cachedKey = Buffer.from(raw, 'hex');
    return cachedKey;
};

/** Throws early if the key is not configured correctly. */
export const assertEncryptionReady = () => {
    getKey();
};

/**
 * @param {Buffer|string} plaintext
 * @param {string} [aad] additional authenticated data (binds ciphertext to its purpose)
 */
export const encrypt = (plaintext, aad = '') => {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
    if (aad) cipher.setAAD(Buffer.from(aad));
    const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
};

/**
 * @param {Buffer} payload
 * @param {string} [aad]
 * @returns {Buffer}
 */
export const decrypt = (payload, aad = '') => {
    if (!Buffer.isBuffer(payload) || payload.length < HEADER_LENGTH || !payload.subarray(0, 4).equals(MAGIC)) {
        throw new EncryptionError('Encrypted payload is malformed or not a NEO BOT encrypted file.');
    }
    const iv = payload.subarray(4, 4 + IV_LENGTH);
    const tag = payload.subarray(4 + IV_LENGTH, HEADER_LENGTH);
    const ciphertext = payload.subarray(HEADER_LENGTH);
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH });
        if (aad) decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        throw new EncryptionError('Integrity check failed: wrong encryption key or tampered data.');
    }
};

/**
 * Deterministic, non-reversible file name for a storage key, so file names
 * do not reveal what they contain (e.g. "pre-key-12").
 */
export const hashName = (name) =>
    crypto.createHmac('sha256', getKey()).update(`neo-file:${name}`).digest('hex').slice(0, 40);
