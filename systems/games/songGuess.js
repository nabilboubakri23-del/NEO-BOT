import { UserError } from '../../utils/errors.js';
import { downloadFile, fetchJson } from '../../commands/download/.lib.js';
import { convert } from '../media/ffmpeg.js';

/**
 * Guess-the-song engine: song pools from Deezer's public API (no key; every track
 * has an official 30 s preview), clip cutting, answer matching and scoring.
 * The chat side (rounds, timers, buttons) lives in plugins/songguess.js.
 */

const API = 'https://api.deezer.com';
const API_HOSTS = ['deezer.com'];
const MEDIA_HOSTS = ['dzcdn.net'];

/** Ready-made packs: a Deezer genre chart, or a playlist search. */
export const PACKS = Object.freeze({
    hits: { icon: '🔥', label: 'Global hits', chart: 0 },
    pop: { icon: '🎤', label: 'Pop', chart: 132 },
    rap: { icon: '🎧', label: 'Rap / Hip-hop', chart: 116 },
    rock: { icon: '🎸', label: 'Rock', chart: 152 },
    dance: { icon: '🪩', label: 'Dance', chart: 113 },
    rnb: { icon: '💜', label: 'R&B', chart: 165 },
    latin: { icon: '💃', label: 'Latin', chart: 197 },
    afro: { icon: '🌍', label: 'Afro', chart: 2 },
    arabic: { icon: '🌙', label: 'Arabic hits', search: 'arabic hits' },
    maghreb: { icon: '🇲🇦', label: 'Maghreb rap & rai', search: 'rap marocain' },
    rai: { icon: '🎺', label: 'Rai', search: 'rai hits' },
    french: { icon: '🇫🇷', label: 'French hits', search: 'hits france' },
    kpop: { icon: '💫', label: 'K-pop', search: 'kpop hits' },
    anime: { icon: '🍥', label: 'Anime', search: 'anime openings' },
    '2000s': { icon: '📼', label: '2000s', search: '2000s hits' },
    '90s': { icon: '📻', label: '90s', search: '90s hits' },
    classics: { icon: '🎼', label: 'Classics', search: 'greatest hits of all time' }
});

export const DIFFICULTY = Object.freeze({
    easy: { label: 'Easy', clip: 15, window: 25, multiplier: 0.75 },
    normal: { label: 'Normal', clip: 10, window: 20, multiplier: 1 },
    hard: { label: 'Hard', clip: 5, window: 15, multiplier: 1.5 }
});

const api = (path) => fetchJson(`${API}${path}`, { allowHosts: API_HOSTS, timeoutMs: 15_000 });

const toTrack = (t) => ({
    id: String(t.id),
    title: String(t.title_short || t.title || '').trim(),
    artist: String(t.artist?.name || '').trim(),
    album: String(t.album?.title || '').trim(),
    cover: t.album?.cover_xl || t.album?.cover_big || '',
    preview: t.preview || '',
    link: t.link || `https://www.deezer.com/track/${t.id}`
});

/** Keeps playable tracks, one per title+artist. */
export const cleanTracks = (rows) => {
    const seen = new Set();
    return (rows || [])
        .filter((t) => t && t.readable !== false && t.preview && t.title)
        .map(toTrack)
        .filter((t) => {
            const key = `${normalize(baseTitle(t.title))}|${normalize(t.artist)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
};

const playlistTracks = async (query) => {
    const found = await api(`/search/playlist?q=${encodeURIComponent(query)}&limit=10`);
    const lists = (found?.data || []).filter((p) => p.nb_tracks >= 20).slice(0, 3);
    if (!lists.length) return [];
    const list = lists[Math.floor(Math.random() * lists.length)];
    const rows = await api(`/playlist/${list.id}/tracks?limit=150`);
    return cleanTracks(rows?.data);
};

/**
 * A pool of tracks for a game.
 * source: { pack } | { artist } | { query }
 * Returns { title, artistMode, tracks }.
 */
export const loadPool = async (source) => {
    if (source.artist) {
        const found = await api(`/search/artist?q=${encodeURIComponent(source.artist)}&limit=1`);
        const artist = found?.data?.[0];
        if (!artist) throw new UserError(`No artist found for "${source.artist.slice(0, 40)}".`);
        const rows = await api(`/artist/${artist.id}/top?limit=60`);
        return { title: `🎙️ ${artist.name}`, artistMode: true, tracks: cleanTracks(rows?.data) };
    }
    const pack = source.pack ? PACKS[source.pack] : null;
    if (pack && pack.chart !== undefined) {
        const rows = await api(`/chart/${pack.chart}/tracks?limit=100`);
        return { title: `${pack.icon} ${pack.label}`, artistMode: false, tracks: cleanTracks(rows?.data) };
    }
    const query = pack ? pack.search : source.query;
    let tracks = await playlistTracks(query);
    if (tracks.length < 12) {
        const rows = await api(`/search?q=${encodeURIComponent(query)}&limit=60`);
        const extra = cleanTracks(rows?.data).filter((t) => !tracks.some((x) => x.id === t.id));
        tracks = [...tracks, ...extra];
    }
    return { title: pack ? `${pack.icon} ${pack.label}` : `🔎 ${query}`, artistMode: false, tracks };
};

export const shuffle = (list, random = Math.random) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

/** Title without "(feat. ...)", "[Remix]" or " - Radio Edit". */
export const baseTitle = (title) => String(title || '').replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || String(title || '');

/** Lower case, accents removed, letters (any script) and digits only. */
export const normalize = (text) =>
    String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f\u064B-\u0652]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = tmp;
        }
    }
    return row[b.length];
};

/** Typed title close enough to the real one (small typos allowed). */
export const titleMatches = (typed, title) => {
    const a = normalize(typed);
    const b = normalize(baseTitle(title));
    if (!a || !b) return false;
    if (a === b) return true;
    if (b.length < 4) return false;
    return 1 - distance(a, b) / Math.max(a.length, b.length) >= 0.8;
};

/** Four options: the answer and three others with different titles. */
export const buildOptions = (answer, pool, { artistMode = false, random = Math.random } = {}) => {
    const key = (t) => normalize(baseTitle(t.title));
    const taken = new Set([key(answer)]);
    const others = [];
    const candidates = shuffle(pool, random);
    // Prefer other artists so options are not guessable from one name, unless the pool is one artist.
    const ordered = artistMode ? candidates : [...candidates.filter((t) => t.artist !== answer.artist), ...candidates.filter((t) => t.artist === answer.artist)];
    for (const t of ordered) {
        if (others.length === 3) break;
        if (t.id === answer.id || taken.has(key(t))) continue;
        taken.add(key(t));
        others.push(t);
    }
    if (others.length < 3) throw new UserError('Not enough different songs in this pack. Try another one.');
    const options = shuffle([answer, ...others], random);
    return { options, correct: options.indexOf(answer) };
};

export const optionLabel = (t, artistMode) => (artistMode ? baseTitle(t.title) : `${baseTitle(t.title)} — ${t.artist}`);

/**
 * Points for a correct answer: 100 base + up to 100 for speed, + streak bonus
 * (20 per correct answer in a row, max 80) + 25 for the first correct answer,
 * all scaled by difficulty.
 */
export const scoreAnswer = ({ elapsedMs, windowMs, streak = 1, first = false, multiplier = 1 }) => {
    const speed = Math.max(0, Math.round(100 * (1 - elapsedMs / windowMs)));
    const bonus = Math.min(80, 20 * Math.max(0, streak - 1));
    return Math.round((100 + speed + bonus + (first ? 25 : 0)) * multiplier);
};

/** Fresh preview url (Deezer preview links expire). */
const freshPreview = async (track) => {
    const row = await api(`/track/${track.id}`);
    if (!row?.preview) throw new Error('no preview');
    return row.preview;
};

/** Downloads the 30 s preview and cuts a clip as a voice note (Opus ogg). */
export const makeClip = async (track, { seconds = 10, random = Math.random } = {}) => {
    let file;
    try {
        file = await downloadFile(track.preview, { allowHosts: MEDIA_HOSTS, maxBytes: 4 * 1024 * 1024, expect: ['audio'] });
    } catch {
        file = await downloadFile(await freshPreview(track), { allowHosts: MEDIA_HOSTS, maxBytes: 4 * 1024 * 1024, expect: ['audio'] });
    }
    const latest = Math.max(1, 28 - seconds);
    const start = 1 + random() * (latest - 1);
    const fadeOut = Math.max(0, seconds - 0.6).toFixed(2);
    const ogg = await convert(file.buffer, {
        inExt: 'mp3',
        outExt: 'ogg',
        timeoutMs: 30_000,
        args: (i, o) => ['-ss', start.toFixed(2), '-t', String(seconds), '-i', i, '-vn', '-af', `afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=0.6`, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', o]
    });
    return { ogg, seconds };
};

/** Album cover as a buffer (null when it fails; the reveal then goes as text). */
export const fetchCover = async (track) => {
    if (!track.cover) return null;
    try {
        return (await downloadFile(track.cover, { allowHosts: MEDIA_HOSTS, maxBytes: 3 * 1024 * 1024, expect: ['image'] })).buffer;
    } catch {
        return null;
    }
};
