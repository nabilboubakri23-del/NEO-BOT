import docStore from '../database/docStore.js';

/**
 * Instagram check for the username finder. WhatsApp refuses a username that matches an
 * Instagram account ("Connect to Instagram to create username"), so those are filtered out.
 *
 * Uses Instagram's public web profile endpoint:
 *   200 + data.user      → taken on Instagram
 *   404 (not HTML)       → no Instagram account
 *   anything else        → unknown (login wall, rate limit, blocked server IP)
 *
 * Instagram often blocks datacenter IPs (Render). Each run first checks a control name that
 * surely exists; if that does not read as taken, the checker is "blind" and nothing is trusted.
 * Optional IG_SESSIONID env (a logged-in sessionid cookie) helps on blocked servers.
 */

const NAME = 'instagramChecks';
const DAY = 24 * 60 * 60_000;
const KEEP = { taken: 7 * DAY, free: 12 * 60 * 60_000 };
export const IG_LIMITS = { perRun: 60, perDay: 400, gapMs: 1200, jitterMs: 800 };
const CONTROL = 'instagram';
const APP_ID = '936619743392459';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

let doc = null;
const load = async () => (doc ||= await docStore.open(NAME, () => ({ results: {}, day: '', used: 0 })));
const today = () => new Date().toISOString().slice(0, 10);

/** Fresh cached Instagram status, or null. */
export const igCached = async (u) => {
    await load();
    const r = doc.results[u];
    return r && Date.now() - r.at <= (KEEP[r.status] ?? 0) ? r.status : null;
};

/** One raw lookup: 'taken' | 'free' | 'unknown'. */
export const igLookup = async (u, { fetchImpl = fetch } = {}) => {
    const headers = { 'x-ig-app-id': APP_ID, 'user-agent': UA, accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' };
    if (process.env.IG_SESSIONID) headers.cookie = `sessionid=${process.env.IG_SESSIONID}`;
    let res;
    try {
        res = await fetchImpl(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`, {
            headers, redirect: 'manual', signal: AbortSignal.timeout(12_000)
        });
    } catch {
        return 'unknown';
    }
    const type = String(res.headers?.get?.('content-type') || '');
    if (res.status === 200) {
        const data = await res.json().catch(() => null);
        return data?.data?.user ? 'taken' : data?.data && data.data.user === null ? 'free' : 'unknown';
    }
    if (res.status === 404 && !type.includes('text/html')) return 'free';
    return 'unknown';
};

/** True when the endpoint can see accounts from this server right now. */
export const igWorks = async (opts) => (await igLookup(CONTROL, opts)) === 'taken';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks names on Instagram (cache first). Returns { results:[{u,status}], blind, stopped }.
 * Stops after 4 unknowns in a row (rate limit).
 */
export const igCheckNames = async (names, { lookupImpl = igLookup, worksImpl = igWorks, gap = true, onProgress } = {}) => {
    await load();
    if (doc.day !== today()) { doc.day = today(); doc.used = 0; }
    const results = [];
    const now = Date.now();
    const todo = [];
    for (const u of names) {
        const r = doc.results[u];
        if (r && now - r.at <= (KEEP[r.status] ?? 0)) results.push({ u, status: r.status, cached: true });
        else todo.push(u);
    }
    if (!todo.length) return { results, blind: false, stopped: false };
    if (!(await worksImpl())) return { results, blind: true, stopped: false };
    let unknownRow = 0;
    let stopped = false;
    for (const u of todo) {
        if (doc.used >= IG_LIMITS.perDay) { stopped = true; break; }
        const status = await lookupImpl(u);
        doc.used += 1;
        if (status !== 'unknown') doc.results[u] = { status, at: Date.now() };
        results.push({ u, status });
        onProgress?.(results.length, names.length);
        unknownRow = status === 'unknown' ? unknownRow + 1 : 0;
        if (unknownRow >= 4) { stopped = true; break; }
        if (gap) await sleep(IG_LIMITS.gapMs + Math.random() * IG_LIMITS.jitterMs);
    }
    for (const [k, v] of Object.entries(doc.results)) if (Date.now() - v.at > 7 * DAY) delete doc.results[k];
    docStore.touch(NAME);
    return { results, blind: false, stopped };
};

/** Test hook. */
export const _resetIg = async () => {
    await load();
    Object.assign(doc, { results: {}, day: today(), used: 0 });
};
