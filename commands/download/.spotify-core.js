import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { UserError } from '../../utils/errors.js';
import { withTimeout } from '../../utils/async.js';
import {
    downloadFile, fetchText, isCobaltConfigured, cobaltDownload, MAX_MEDIA_BYTES,
    sanitizeFilename, spotifyDownload, spotifySearch, spotifyInfo, youtubeSearch, sniffKind
} from './.lib.js';
import { extractMedia, EXTRACTOR_HOSTS, binaryPath } from './.extractor.js';

/**
 * Spotify acquisition core: input parsing, metadata, and audio retrieval with a
 * fallback chain so one dead converter never leaves the user hanging:
 *   1. spotimate.app converter (2 attempts)
 *   2. YouTube match through the verified yt-dlp binary (if installed)
 *   3. cobalt-compatible backend (if DOWNLOAD_API_BASE is set)
 * Every step has its own deadline and the whole job has a hard cap.
 */

export const TRACK_ID = /^[A-Za-z0-9]{22}$/;
export const JOB_DEADLINE_MS = 120_000;

export { withTimeout };

/**
 * Classifies user text: a track link/URI, a short spotify.link, an unsupported
 * Spotify link (album, playlist...), or a plain song name.
 */
export const classifyInput = (text) => {
    const input = String(text || '').trim();
    if (!input) return { kind: 'empty' };
    const uri = input.match(/^spotify:track:([A-Za-z0-9]{22})$/i);
    if (uri) return { kind: 'track', id: uri[1], url: `https://open.spotify.com/track/${uri[1]}` };
    const link = input.match(/https?:\/\/\S+/i)?.[0] || (/^(www\.|open\.spotify\.com|spotify\.link)/i.test(input) ? `https://${input.split(/\s/)[0]}` : '');
    if (!link) return { kind: 'name', query: input };
    let url;
    try { url = new URL(link.replace(/[)\]>.,]+$/, '')); } catch { return { kind: 'invalid' }; }
    const host = url.hostname.toLowerCase();
    if (host === 'spotify.link' || host.endsWith('.spotify.link') || host === 'spotify.app.link') return { kind: 'short', url: url.href };
    if (host !== 'open.spotify.com') return { kind: 'invalid' };
    const parts = url.pathname.split('/').filter(Boolean).filter((p) => !/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(p));
    const [type, id] = parts;
    if (type === 'track' && TRACK_ID.test(id || '')) return { kind: 'track', id, url: `https://open.spotify.com/track/${id}` };
    if (['album', 'playlist', 'artist', 'show', 'episode'].includes(type)) return { kind: 'unsupported', type };
    return { kind: 'invalid' };
};

/** Follows a spotify.link short link to its open.spotify.com track (no redirects outside Spotify). */
export const resolveShortLink = async (url) => {
    const html = await withTimeout(fetchText(url, { allowHosts: ['spotify.link', 'spotify.app.link', 'open.spotify.com'] }), 15_000, 'short link timeout').catch(() => '');
    const found = String(html).match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/i);
    if (!found) throw new UserError('Could not open that short Spotify link. Copy the full track link instead.');
    return { kind: 'track', id: found[1], url: `https://open.spotify.com/track/${found[1]}` };
};

/** Turns any accepted text into a track URL, or throws a clear error. */
export const toTrackUrl = async (text) => {
    let c = classifyInput(text);
    if (c.kind === 'short') c = await resolveShortLink(c.url);
    if (c.kind === 'track') return c.url;
    if (c.kind === 'unsupported') throw new UserError(`That is a Spotify ${c.type} link. Send a single track link (open.spotify.com/track/...).`);
    throw new UserError('That is not a valid Spotify track link.');
};

/** Search by name: up to 5 tracks with title, artist, album, duration, cover. */
export const searchTracks = async (query) => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const tracks = await withTimeout(spotifySearch(query), 25_000, 'search timeout');
            if (tracks.length) return tracks;
            return [];
        } catch (error) {
            if (error?.expose && !/Could not download/.test(error.message)) throw error; // validation errors
            lastError = error;
        }
    }
    throw lastError?.timeout || !lastError?.expose
        ? new UserError('Spotify search is slow right now. Try again in a minute.')
        : new UserError('Spotify search is unavailable right now. Try again in a minute.');
};

/** Metadata for a track link: provider row first, then official oEmbed (title only). */
export const trackInfo = async (url) => {
    const id = url.split('/').pop();
    try {
        const rows = await withTimeout(spotifyDownload(url, { search: true }), 20_000, 'info timeout');
        const hit = rows.find((r) => r.id === id) || rows[0];
        if (hit) return hit;
    } catch { /* fall through */ }
    const info = await withTimeout(spotifyInfo(url), 10_000, 'oembed timeout').catch(() => ({ title: '' }));
    return { id, title: info.title || 'Spotify track', artist: '', album: '', duration: '', cover: /^https:\/\/i\.scdn\.co\//.test(info.thumbnail || '') ? info.thumbnail : '', url };
};

const hasYtDlp = () => access(binaryPath, constants.X_OK).then(() => true, () => false);

const viaSpotimate = async (track) => {
    const resolved = await withTimeout(spotifyDownload(track.url), 40_000, 'converter timeout');
    const file = await withTimeout(downloadFile(resolved.url, { allowHosts: ['spotimate.app'], maxBytes: MAX_MEDIA_BYTES, expect: ['audio'] }), 60_000, 'file timeout');
    return { buffer: file.buffer, mimetype: 'audio/mpeg', ext: 'mp3', source: 'spotimate' };
};

const youtubeIdFor = async (track) => {
    const query = [track.title, track.artist, 'audio'].filter(Boolean).join(' ');
    const ids = await withTimeout(youtubeSearch(query), 15_000, 'youtube search timeout');
    if (!ids.length) throw new Error('no youtube match');
    return ids[0];
};

const viaYtDlp = async (track) => {
    if (!(await hasYtDlp())) throw new Error('yt-dlp not installed');
    const id = await youtubeIdFor(track);
    const result = await extractMedia(`https://www.youtube.com/watch?v=${id}`, 'youtube', { audio: true });
    const file = await withTimeout(downloadFile(result.url, { allowHosts: EXTRACTOR_HOSTS.youtube, maxBytes: MAX_MEDIA_BYTES, expect: ['audio', 'video'] }), 60_000, 'file timeout');
    const m4a = result.ext === 'm4a';
    return { buffer: file.buffer, mimetype: m4a ? 'audio/mp4' : 'audio/mpeg', ext: m4a ? 'm4a' : 'mp3', source: 'youtube' };
};

const viaCobalt = async (track) => {
    if (!isCobaltConfigured()) throw new Error('cobalt not configured');
    const id = await youtubeIdFor(track);
    const result = await withTimeout(cobaltDownload(`https://www.youtube.com/watch?v=${id}`, { audio: true }), 30_000, 'cobalt timeout');
    const url = result.url || result.audio || result.items?.[0]?.url;
    if (!url) throw new Error('cobalt gave no url');
    const file = await withTimeout(downloadFile(url, { maxBytes: MAX_MEDIA_BYTES, expect: ['audio', 'video'] }), 60_000, 'file timeout');
    return { buffer: file.buffer, mimetype: 'audio/mpeg', ext: 'mp3', source: 'cobalt' };
};

export const SOURCES = { spotimate: viaSpotimate, youtube: viaYtDlp, cobalt: viaCobalt };

/**
 * Gets the audio for a track, trying each source in turn until one works.
 * `isCancelled` is checked between steps so a cancelled request stops early.
 */
export const acquireAudio = async (track, { isCancelled = () => false, onStep = () => {}, sources = SOURCES } = {}) => {
    const plan = [['spotimate', 1], ['spotimate', 2], ['youtube', 1], ['cobalt', 1]];
    const started = Date.now();
    for (const [name, attempt] of plan) {
        if (isCancelled()) throw new UserError('Spotify request cancelled.');
        if (Date.now() - started > JOB_DEADLINE_MS) break;
        try {
            onStep(name, attempt);
            const audio = await sources[name](track);
            if (!audio?.buffer?.length) throw new Error('empty');
            if (sniffKind(audio.buffer) === 'htmlpage') throw new Error('got a web page');
            return { ...audio, fileName: `${sanitizeFilename([track.title, track.artist].filter(Boolean).join(' - '), 'spotify')}.${audio.ext}` };
        } catch (error) {
            if (error?.expose && /too large|cancelled/i.test(error.message)) throw error;
        }
    }
    if (isCancelled()) throw new UserError('Spotify request cancelled.');
    throw new UserError('Could not get this song from any source right now. Try again in a few minutes, or try another result.');
};
