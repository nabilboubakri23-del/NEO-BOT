import docStore from '../database/docStore.js';
import { audit } from './auditLog.js';
import { STORED_RANKS } from './ranks.js';

/**
 * Granted ranks (moderator, vip, premium), stored in the "ranks" document.
 *
 *   { "<number or lid>": { number, lid, rank, grantedBy, grantedAt, expiresAt|null, reason } }
 *
 * Other ranks have their own single source of truth and are never stored here:
 *   creator / owner  → data/owners.json (systems/owners/ownerStore.js)
 *   banned           → the user record (systems/users/userStore.js)
 *   user             → the default when nothing else applies
 *
 * Temporary ranks fall back to "user" as soon as they expire: expiry is checked
 * on every read and expired entries are cleaned periodically.
 */

const NAME = 'ranks';
const CLEAN_EVERY_MS = 10 * 60 * 1000;
let doc = null;
let timer = null;

const digits = (value) => String(value || '').replace(/\D/g, '');

export const loadRanks = async () => {
    doc = await docStore.open(NAME, () => ({}));
    cleanExpired();
    if (!timer) {
        timer = setInterval(cleanExpired, CLEAN_EVERY_MS);
        timer.unref?.();
    }
    return doc;
};

const isExpired = (entry, now = Date.now()) => Boolean(entry.expiresAt && entry.expiresAt <= now);

/** Finds the stored entry key for a person ({ number, lid }). */
const findKey = (person) => {
    if (!doc) return null;
    const number = digits(person.number);
    const lid = digits(person.lid);
    if (number && doc[number]) return number;
    if (lid && doc[lid]) return lid;
    return Object.keys(doc).find((k) => (number && doc[k].number === number) || (lid && doc[k].lid === lid)) || null;
};

const expire = (key) => {
    const entry = doc[key];
    delete doc[key];
    docStore.touch(NAME);
    audit({ action: 'rank:expire', actor: 'system', target: entry, detail: entry.rank });
};

/** The live (not expired) stored rank entry of a person, or null. */
export const getStoredRank = (person) => {
    const key = findKey(person);
    if (!key) return null;
    if (isExpired(doc[key])) {
        expire(key);
        return null;
    }
    return { ...doc[key] };
};

/**
 * Stores a rank for a person. `durationMs` null = permanent.
 * Rules (who may grant what) are enforced by the caller through rankRules.js.
 */
export const setStoredRank = (person, rank, { grantedBy = 'system', durationMs = null, reason = '' } = {}) => {
    if (!doc) throw new Error('Ranks not loaded.');
    if (!STORED_RANKS.includes(rank)) throw new Error(`Rank "${rank}" cannot be stored.`);
    const number = digits(person.number);
    const lid = digits(person.lid);
    if (!number && !lid) throw new Error('No user given.');
    const old = findKey(person);
    if (old) delete doc[old];
    const now = Date.now();
    const entry = { number, lid, rank, grantedBy, grantedAt: now, expiresAt: durationMs ? now + durationMs : null, reason: String(reason || '') };
    doc[number || lid] = entry;
    docStore.touch(NAME);
    return { ...entry };
};

/** Removes a stored rank. Returns the removed entry or null. */
export const removeStoredRank = (person) => {
    const key = findKey(person);
    if (!key) return null;
    const entry = doc[key];
    delete doc[key];
    docStore.touch(NAME);
    return entry;
};

/** Live entries, optionally only one rank. */
export const listStoredRanks = (rank = null) => {
    cleanExpired();
    return Object.values(doc || {})
        .filter((e) => !rank || e.rank === rank)
        .map((e) => ({ ...e }));
};

/** Drops every expired entry. Returns how many were removed. */
export const cleanExpired = () => {
    if (!doc) return 0;
    const now = Date.now();
    const keys = Object.keys(doc).filter((k) => isExpired(doc[k], now));
    keys.forEach(expire);
    return keys.length;
};

/** Fills in the missing half (number or LID) of a stored entry when a message reveals both. */
export const learnRankIdentity = (message) => {
    const number = digits(message.senderNumber);
    const lid = digits(message.senderLid);
    if (!doc || !number || !lid || number === lid) return;
    for (const entry of Object.values(doc)) {
        if (entry.number === number && entry.lid !== lid) entry.lid = lid;
        else if (entry.lid === lid && entry.number !== number) entry.number = number;
        else continue;
        docStore.touch(NAME);
    }
};
