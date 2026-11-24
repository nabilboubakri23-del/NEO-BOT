import { fetchJson } from './.lib.js';
import { withTimeout } from '../../utils/async.js';

/**
 * Song lyrics from LRCLIB (lrclib.net, free, no key, community lyrics with timings).
 *   findLyrics({ title, artist, duration }) → { plain, synced, source } | null
 * The best match is the row whose title/artist fit and whose length is closest.
 */

const BASE = 'https://lrclib.net/api/search';
const HOSTS = ['lrclib.net'];
const HEADERS = { 'User-Agent': 'NEO-BOT (https://github.com/nabilboubakri23-del)' };

const norm = (text) => String(text || '').toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, '')
    .replace(/feat\.?.*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** "3:20" / "03:20" / 200 → seconds, or 0. */
export const toSeconds = (value) => {
    if (typeof value === 'number') return value;
    const parts = String(value || '').split(':').map(Number);
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
    return parts.reduce((total, n) => total * 60 + n, 0);
};

/** Scores LRCLIB rows against the track; higher is better, null when it is not the song. */
export const scoreRow = (row, { title, artist, duration }) => {
    if (row.instrumental || !(row.plainLyrics || row.syncedLyrics)) return null;
    const t = norm(title);
    const rt = norm(row.trackName || row.name);
    if (!t || !rt || !(rt.includes(t) || t.includes(rt))) return null;
    let score = rt === t ? 30 : 15;
    const a = norm(artist).split(' ')[0];
    if (a && norm(row.artistName).includes(a)) score += 30;
    const seconds = toSeconds(duration);
    if (seconds && row.duration) {
        const off = Math.abs(row.duration - seconds);
        if (off > 15) score -= 25; else score += 20 - off;
    }
    if (row.syncedLyrics) score += 5;
    return score;
};

export const pickBest = (rows, track) => rows
    .map((row) => ({ row, score: scoreRow(row, track) }))
    .filter((r) => r.score !== null)
    .sort((x, y) => y.score - x.score)[0]?.row || null;

const search = (params) => withTimeout(
    fetchJson(`${BASE}?${new URLSearchParams(params)}`, { headers: HEADERS, allowHosts: HOSTS }),
    12_000,
    'lyrics timeout'
).then((rows) => (Array.isArray(rows) ? rows : []));

/** Lyrics text without timings, from the synced lines when there is no plain text. */
export const plainFromSynced = (synced) => String(synced || '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\[\d+:\d+(?:\.\d+)?\]\s*)+/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const findLyrics = async (track) => {
    const title = norm(track.title) || track.title;
    const attempts = [
        { track_name: title, ...(track.artist ? { artist_name: track.artist.split(/,|&/)[0].trim() } : {}) },
        { q: [title, track.artist].filter(Boolean).join(' ') }
    ];
    for (const params of attempts) {
        const rows = await search(params).catch(() => []);
        const best = pickBest(rows, track);
        if (best) {
            const plain = String(best.plainLyrics || '').trim() || plainFromSynced(best.syncedLyrics);
            return { plain, synced: best.syncedLyrics || '', source: 'LRCLIB' };
        }
    }
    return null;
};
