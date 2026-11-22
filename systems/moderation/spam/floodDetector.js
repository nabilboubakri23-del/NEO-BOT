import crypto from 'node:crypto';
import { squeeze, words } from '../profanity/normalize.js';

/**
 * Anti-spam detector. Keeps a short in-memory history per group member and flags:
 *   flood    too many messages in a short window (any type: text, stickers, media)
 *   repeat   the same content again and again (normalized, so "hi", "h i", "HIII!" are equal)
 *   mentions one message tagging many people
 *   bomb     oversized / crash-style text (huge length, hundreds of lines, invisible characters)
 * Strikes inside a cool-down window escalate the punishment (see guard).
 * Memory is bounded: old entries are pruned and the map is capped.
 */

const WINDOW_MS = 10_000;
const REPEAT_WINDOW_MS = 60_000;
const REPEAT_LIMIT = 3;
const STRIKE_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 5000;
const MAX_KEYS_KEPT = 10;

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u034F\u115F\u1160\u3164\uFFA0]/g;

/** Content fingerprint: normalized text, or media hash, or type. */
export const fingerprint = (message) => {
    const text = squeeze(words(message.text || '', { leet: false }).join(''));
    const media = message.raw?.message && Object.values(message.raw.message).find((v) => v?.fileSha256);
    const sha = media?.fileSha256 ? Buffer.from(media.fileSha256).toString('base64') : '';
    // Short texts ("ok", "😂") and media without a hash are too common to call repeats.
    if (!sha && text.length < 6) return null;
    const basis = `${message.type}|${text}|${sha}`;
    return crypto.createHash('sha1').update(basis).digest('base64').slice(0, 16);
};

/** Crash / bomb text check. Pure. */
export const isBombText = (text) => {
    const s = String(text || '');
    if (!s) return false;
    if (s.length > 4000) return true;
    if (s.split('\n').length > 80) return true;
    if ((s.match(INVISIBLE) || []).length > 40) return true;
    if (/(.)\1{300,}/su.test(s)) return true;
    // Long runs of combining marks (Zalgo) freeze some phones.
    if (/\p{M}{30,}/u.test(s)) return true;
    return false;
};

export class FloodDetector {
    constructor({ now = () => Date.now() } = {}) {
        this.now = now;
        this.people = new Map();
    }

    #entry(key) {
        let e = this.people.get(key);
        if (!e) {
            e = { times: [], prints: [], keys: [], strikes: [] };
            this.people.set(key, e);
            if (this.people.size > MAX_TRACKED) this.#prune();
        }
        return e;
    }

    #prune() {
        const cutoff = this.now() - STRIKE_WINDOW_MS;
        for (const [k, e] of this.people) {
            if ((e.times.at(-1) ?? 0) < cutoff && (e.strikes.at(-1) ?? 0) < cutoff) this.people.delete(k);
        }
        while (this.people.size > MAX_TRACKED) this.people.delete(this.people.keys().next().value);
    }

    /**
     * Records one message and returns the spam kind it triggers, or null.
     * @param {string} key group|person
     * @param {object} message serialized message
     * @param {{ limit: number, mentionLimit: number }} options limit = messages per 10 s
     */
    record(key, message, { limit = 7, mentionLimit = 10 } = {}) {
        const now = this.now();
        const e = this.#entry(key);
        e.times = e.times.filter((t) => now - t < WINDOW_MS);
        e.times.push(now);
        e.prints = e.prints.filter((p) => now - p.at < REPEAT_WINDOW_MS);
        const print = fingerprint(message);
        e.prints.push({ at: now, print });
        e.keys.push({ at: now, key: message.raw?.key });
        if (e.keys.length > MAX_KEYS_KEPT) e.keys.shift();

        if (isBombText(message.text)) return 'bomb';
        if ((message.mentions?.length || 0) >= mentionLimit) return 'mentions';
        if (e.times.length > limit) return 'flood';
        if (print && e.prints.filter((p) => p.print === print).length >= REPEAT_LIMIT) return 'repeat';
        return null;
    }

    /** Adds a strike and returns how many this person has in the cool-down window. */
    strike(key) {
        const now = this.now();
        const e = this.#entry(key);
        e.strikes = e.strikes.filter((t) => now - t < STRIKE_WINDOW_MS);
        e.strikes.push(now);
        return e.strikes.length;
    }

    /** Keys of this person's recent messages (to delete a whole burst), then forgets them. */
    takeRecentKeys(key, withinMs = WINDOW_MS) {
        const e = this.people.get(key);
        if (!e) return [];
        const now = this.now();
        const keys = e.keys.filter((k) => k.key && now - k.at < withinMs).map((k) => k.key);
        e.keys = [];
        e.times = [];
        e.prints = [];
        return keys;
    }

    reset() {
        this.people.clear();
    }
}
