import { USyncQuery, USyncUser } from 'baileys';
import docStore from '../database/docStore.js';

/**
 * Looks a username up on WhatsApp the way the app resolves "@name" (USync contact query).
 *
 *   taken   an account uses the name
 *   free    no account found. NOT a guarantee: reserved names, names held for an
 *           Instagram/Facebook owner and blocked words also return nothing.
 *   unknown WhatsApp gave an error
 *
 * Lookups go through the bot's own number, so they are slow on purpose and capped per day.
 * The account behind a taken name is never stored or shown.
 */

const NAME = 'usernameChecks';
const DAY = 24 * 60 * 60_000;
const KEEP = { taken: 3 * DAY, free: 6 * 60 * 60_000, unknown: 0 };
export const LIMITS = { perRun: 25, perDay: 200, minGapMs: 2500, jitterMs: 1500, maxErrorsInRow: 3 };

let doc = null;
const load = async () => (doc ||= await docStore.open(NAME, () => ({ results: {}, day: '', used: 0 })));
const today = () => new Date().toISOString().slice(0, 10);

/** Cached result still fresh, or null. */
export const cached = async (u) => {
    await load();
    const r = doc.results[u];
    if (!r || Date.now() - r.at > (KEEP[r.status] ?? 0)) return null;
    return r.status;
};

export const quotaLeft = async () => {
    await load();
    if (doc.day !== today()) { doc.day = today(); doc.used = 0; }
    return Math.max(0, LIMITS.perDay - doc.used);
};

const remember = (u, status) => {
    if (status !== 'unknown') doc.results[u] = { status, at: Date.now() };
    const now = Date.now();
    for (const [k, v] of Object.entries(doc.results)) if (now - v.at > 3 * DAY) delete doc.results[k];
    docStore.touch(NAME);
};

/** One lookup. Throws only for errors that mean "stop the whole run" (rate limit / not allowed). */
export const lookup = async (sock, u) => {
    const query = new USyncQuery().withContactProtocol().withUser(new USyncUser().withUsername(u));
    let result;
    try {
        result = await sock.executeUSyncQuery(query);
    } catch (error) {
        const code = Number(error?.output?.statusCode || error?.data?.code || 0);
        const text = String(error?.message || '');
        if (code === 429 || /rate|overlimit/i.test(text)) { const e = new Error('rate-limited'); e.stop = true; throw e; }
        if (code === 401 || code === 403 || /not-authorized|forbidden|feature/i.test(text)) { const e = new Error('not-allowed'); e.stop = true; throw e; }
        return 'unknown';
    }
    if (!result) return 'unknown';
    return result.list.some((e) => e.contact === true || (e.id && e.contact !== false)) ? 'taken' : 'free';
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
export const isBusy = () => running;

/**
 * Checks names one by one with a gap, using the cache first.
 * onProgress(done, total) is called after each name. Returns { results, stopped, reason }.
 */
export const checkNames = async (sock, names, { onProgress, lookupImpl = lookup, gap = true } = {}) => {
    if (running) throw Object.assign(new Error('busy'), { busy: true });
    running = true;
    await load();
    const results = [];
    let stopped = false;
    let reason = '';
    let errorsInRow = 0;
    try {
        for (const u of names) {
            const hit = await cached(u);
            if (hit) { results.push({ u, status: hit, cached: true }); onProgress?.(results.length, names.length); continue; }
            if ((await quotaLeft()) <= 0) { stopped = true; reason = 'daily-limit'; break; }
            let status;
            try {
                status = await lookupImpl(sock, u);
            } catch (error) {
                stopped = true;
                reason = error.message;
                break;
            }
            doc.used += 1;
            errorsInRow = status === 'unknown' ? errorsInRow + 1 : 0;
            remember(u, status);
            results.push({ u, status });
            onProgress?.(results.length, names.length);
            if (errorsInRow >= LIMITS.maxErrorsInRow) { stopped = true; reason = 'errors'; break; }
            if (gap && results.length < names.length) await sleep(LIMITS.minGapMs + Math.random() * LIMITS.jitterMs);
        }
    } finally {
        running = false;
    }
    return { results, stopped, reason };
};

/** Test hook. */
export const _reset = async () => {
    await load();
    Object.assign(doc, { results: {}, day: today(), used: 0 });
    running = false;
};
