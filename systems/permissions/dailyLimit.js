import docStore from '../database/docStore.js';

/**
 * Commands-per-day counter behind the rank perk "dailyLimit".
 * One "usage" document for the current UTC day: { day, counts: { user: n }, warned: { user: true } }.
 * A new day starts a fresh document. The limit is announced once per day, then silent.
 */

const NAME = 'usage';
let doc = null;

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export const loadDailyUsage = async () => {
    doc = await docStore.open(NAME, () => ({ day: today(), counts: {}, warned: {} }));
    return doc;
};

const current = (now) => {
    if (!doc) return null;
    const day = today(now);
    if (doc.day !== day) {
        doc.day = day;
        doc.counts = {};
        doc.warned = {};
        docStore.touch(NAME);
    }
    doc.counts ||= {};
    doc.warned ||= {};
    return doc;
};

export const usedToday = (user, now = Date.now()) => current(now)?.counts[user] || 0;

/**
 * Counts one command for `user` when under `limit` (Infinity = unlimited).
 * @returns {{ ok: true, used: number } | { ok: false, used: number, notify: boolean }}
 */
export const consumeDaily = (user, limit, now = Date.now()) => {
    const d = current(now);
    if (!d || limit === Infinity) return { ok: true, used: 0 };
    const used = d.counts[user] || 0;
    if (used >= limit) {
        const notify = !d.warned[user];
        if (notify) {
            d.warned[user] = true;
            docStore.touch(NAME);
        }
        return { ok: false, used, notify };
    }
    d.counts[user] = used + 1;
    docStore.touch(NAME);
    return { ok: true, used: used + 1 };
};

export const resetDailyUsage = () => {
    if (!doc) return;
    doc.counts = {};
    doc.warned = {};
    docStore.touch(NAME);
};
