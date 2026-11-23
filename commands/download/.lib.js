import crypto from 'node:crypto';
import { UsageError, UserError } from '../../utils/errors.js';

/**
 * Shared helpers for the download commands (commands/download).
 * The command loader skips dotfiles, so this library is never registered as a command.
 *
 * Security model:
 * - Every user-supplied URL is parsed and checked against a strict per-platform
 *   host allowlist: HTTPS only, no credentials, no IP literals, no odd ports.
 * - Every request the bot makes itself has a timeout and a response size cap.
 * - No new npm dependencies, no shelling out, no eval.
 * - Platforms with no verified free provider route through a cobalt-compatible
 *   backend (https://github.com/imputnet/cobalt) configured by the owner with
 *   DOWNLOAD_API_BASE (and DOWNLOAD_API_KEY when the instance requires one).
 *   When it is not configured, commands say so honestly instead of failing
 *   silently or pretending to work.
 *
 * Watermark preference: providers that offer a clean (no-watermark) version
 * are preferred (e.g. TikTok), but availability is never guaranteed.
 */

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Largest remote file the bot will hand to WhatsApp (document uploads). */
export const MAX_FILE_BYTES = 300 * 1024 * 1024;

// ── Configuration ────────────────────────────────────────────────────────

export const cobaltBase = () => (process.env.DOWNLOAD_API_BASE || '').trim().replace(/\/+$/, '');
export const cobaltKey = () => (process.env.DOWNLOAD_API_KEY || '').trim();
export const isCobaltConfigured = () => Boolean(cobaltBase());

export const NOT_CONFIGURED =
    '⚠️ Downloading from this platform is not enabled yet.\nThe owner must set DOWNLOAD_API_BASE on the server (a cobalt-compatible download backend).';

// ── URL validation ───────────────────────────────────────────────────────

/**
 * Parses and validates a user-supplied URL against a host allowlist.
 * Returns the normalized URL string. Throws UsageError when empty,
 * UserError (safe message) when it is not an allowed https URL.
 */
export const assertUrl = (text, hosts, label = 'link') => {
    const raw = String(text || '').trim();
    if (!raw) throw new UsageError();
    if (raw.length > 2000) throw new UserError(`⚠️ That ${label} is too long.`);
    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new UserError(`⚠️ That ${label} is not a valid URL.`);
    }
    if (url.protocol !== 'https:') throw new UserError(`⚠️ Only https ${label}s are accepted.`);
    if (url.username || url.password) throw new UserError(`⚠️ That ${label} is not allowed.`);
    if (url.port && url.port !== '443') throw new UserError(`⚠️ That ${label} is not allowed.`);
    const host = url.hostname.toLowerCase();
    if (IPV4_RE.test(host) || host.includes(':') || host === 'localhost') {
        throw new UserError(`⚠️ That ${label} is not allowed.`);
    }
    const allowed = hosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) throw new UserError(`⚠️ That is not a ${hosts[0]} ${label}.`);
    return url.toString();
};

/** File name safe for WhatsApp captions and headers. */
export const sanitizeFilename = (name, fallback = 'download') => {
    const clean = String(name || '')
        .replace(/[\\/:*?"<>\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
    return clean || fallback;
};

// ── HTTP helpers ─────────────────────────────────────────────────────────

/** GET/POST text with timeout and a hard size cap. Errors become safe UserErrors. */
export const fetchText = async (url, { method = 'GET', headers = {}, body, form, maxBytes = MAX_PAGE_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const finalHeaders = { 'User-Agent': UA, ...headers };
        let finalBody = body;
        if (form) {
            finalBody = new URLSearchParams(form).toString();
            finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        const res = await fetch(url, { method, headers: finalHeaders, body: finalBody, signal: controller.signal, redirect: 'follow' });
        if (!res.ok) throw new UserError(`⚠️ The service refused the request (${res.status}). Try again later.`);
        const reader = res.body?.getReader?.();
        if (!reader) return await res.text();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new UserError('⚠️ The service answer was too large.');
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
        if (error?.expose) throw error;
        if (error?.name === 'AbortError') throw new UserError('⚠️ The service is slow right now. Try again later.');
        throw new UserError('⚠️ Could not reach the service. Try again later.');
    } finally {
        clearTimeout(timer);
    }
};

export const fetchJson = async (url, options = {}) => {
    const text = await fetchText(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    try {
        return JSON.parse(text);
    } catch {
        throw new UserError('⚠️ The service answered in an unexpected way.');
    }
};

/** HEAD request to learn a remote file's size before handing it to WhatsApp. */
export const remoteSize = async (url, timeoutMs = 10_000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: controller.signal, redirect: 'follow' });
        const size = Number(res.headers.get('content-length') || 0);
        return Number.isFinite(size) ? size : 0;
    } catch {
        return 0; // unknown size: the provider link decides
    } finally {
        clearTimeout(timer);
    }
};

// ── cobalt-compatible backend ────────────────────────────────────────────

const COBALT_ERRORS = {
    'error.api.link.invalid': '⚠️ That link is not valid.',
    'error.api.link.unsupported': '⚠️ That link type is not supported.',
    'error.api.fetch.empty': '⚠️ Nothing downloadable was found at that link.',
    'error.api.content.post.empty': '⚠️ Nothing downloadable was found at that link.',
    'error.api.content.video.unavailable': '⚠️ That video is unavailable or private.',
    'error.api.auth.jwt.missing': '⚠️ The download backend needs an access key (DOWNLOAD_API_KEY).',
    'error.api.auth.key.missing': '⚠️ The download backend needs an access key (DOWNLOAD_API_KEY).',
    'error.api.rate_exceeded': '⚠️ Download limit reached. Try again in a minute.',
    'error.api.fetch.rate_exceeded': '⚠️ The platform is rate limiting. Try again later.',
    'error.api.fetch.critical': '⚠️ The platform blocked the download. Try again later.'
};

export const cobaltErrorMessage = (code) => COBALT_ERRORS[code] || '⚠️ Could not download from that link right now.';

/**
 * Pure mapping of a cobalt API JSON answer to an internal result.
 * { kind: 'file', url, fileName } | { kind: 'picker', items: [{type,url}], audio }
 */
export const interpretCobalt = (data) => {
    if (!data || typeof data !== 'object') throw new UserError('⚠️ The download backend answered in an unexpected way.');
    if (data.status === 'error') throw new UserError(cobaltErrorMessage(data.error?.code));
    if (data.status === 'picker') {
        const items = (Array.isArray(data.picker) ? data.picker : [])
            .filter((item) => typeof item?.url === 'string' && item.url.startsWith('https://'))
            .map((item) => ({ type: item.type === 'video' ? 'video' : 'photo', url: item.url }));
        if (!items.length) throw new UserError('⚠️ Nothing downloadable was found at that link.');
        return { kind: 'picker', items, audio: typeof data.audio === 'string' && data.audio.startsWith('https://') ? data.audio : '' };
    }
    if ((data.status === 'tunnel' || data.status === 'redirect' || data.status === 'stream') && typeof data.url === 'string' && data.url.startsWith('https://')) {
        return { kind: 'file', url: data.url, fileName: sanitizeFilename(data.filename || '') };
    }
    throw new UserError('⚠️ The download backend answered in an unexpected way.');
};

/** Ask the cobalt-compatible backend to resolve a media URL. */
export const cobaltDownload = async (inputUrl, { audio = false, quality = '720' } = {}) => {
    if (!isCobaltConfigured()) throw new UserError(NOT_CONFIGURED);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (cobaltKey()) headers.Authorization = `Api-Key ${cobaltKey()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let data;
    try {
        const res = await fetch(`${cobaltBase()}/`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                url: inputUrl,
                downloadMode: audio ? 'audio' : 'auto',
                audioFormat: 'mp3',
                videoQuality: quality,
                disableMetadata: true
            }),
            signal: controller.signal
        });
        data = await res.json().catch(() => null);
    } catch (error) {
        if (error?.name === 'AbortError') throw new UserError('⚠️ The download backend is slow right now. Try again later.');
        throw new UserError('⚠️ Could not reach the download backend. Try again later.');
    } finally {
        clearTimeout(timer);
    }
    return interpretCobalt(data);
};

// ── Providers (pure parsers are exported for tests) ─────────────────────

/** ssstik.io answer → { author, description, videoUrl (no watermark), audioUrl }. */
export const parseSsstik = (html) => {
    const out = { author: '', description: '', videoUrl: '', audioUrl: '' };
    const text = String(html || '');
    for (const match of text.matchAll(/<a\b[^>]*>/gi)) {
        const tag = match[0];
        const href = tag.match(/href="([^"]+)"/i)?.[1] || '';
        const cls = tag.match(/class="([^"]*)"/i)?.[1] || '';
        if (!href.startsWith('https://')) continue;
        if (/\bwithout_watermark\b/.test(cls) && !out.videoUrl) out.videoUrl = href;
        else if (/\bmusic\b/.test(cls) && !out.audioUrl) out.audioUrl = href;
    }
    out.author = text.match(/<h2[^>]*>([^<]*)<\/h2>/i)?.[1]?.trim() || '';
    out.description = text.match(/class="maintext"[^>]*>([^<]*)</i)?.[1]?.trim() || '';
    return out;
};

/** Download a TikTok video without watermark through ssstik.io (no key needed). */
export const tiktokDownload = async (url) => {
    const html = await fetchText('https://ssstik.io/abc?url=dl', {
        method: 'POST',
        headers: { 'HX-Request': 'true', 'HX-Current-URL': 'https://ssstik.io/en' },
        form: { id: url, locale: 'en', tt: crypto.randomBytes(8).toString('hex') }
    });
    const parsed = parseSsstik(html);
    if (!parsed.videoUrl && !parsed.audioUrl) {
        throw new UserError('⚠️ Could not download that TikTok. Check the link and that the video is public.');
    }
    return parsed;
};

/** MediaFire file page → { url, name } or null when the page has no download button. */
export const parseMediafire = (html) => {
    const text = String(html || '');
    const tag = text.match(/<a[^>]*id="downloadButton"[^>]*>/i)?.[0] || '';
    const url = tag.match(/href="([^"]+)"/i)?.[1] || '';
    if (!url.startsWith('https://')) return null;
    const name = text.match(/class="filename"[^>]*>\s*([^<]+?)\s*</i)?.[1] || '';
    return { url, name: sanitizeFilename(name, 'mediafire-file') };
};

/** YouTube search page → ordered unique video ids. */
export const parseYtSearch = (html) => {
    const ids = [];
    for (const match of String(html || '').matchAll(/"videoId":"([\w-]{11})"/g)) {
        if (!ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
};

/** First YouTube video id matching a text search (no API key). */
export const youtubeSearch = async (query) => {
    const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
    return parseYtSearch(html);
};

/** open.spotify.com track URL → track id, or null. */
export const parseSpotifyTrack = (text) => {
    const match = String(text || '').match(/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]+)/i);
    return match?.[1] || null;
};

/** Spotify oEmbed (official, no key) → { title, thumbnail }. */
export const spotifyInfo = async (trackUrl) => {
    const data = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`);
    return { title: String(data?.title || '').trim(), thumbnail: typeof data?.thumbnail_url === 'string' ? data.thumbnail_url : '' };
};

/** Aptoide search JSON → clean app list with direct APK links. */
export const pickApps = (data, limit = 5) =>
    (Array.isArray(data?.datalist?.list) ? data.datalist.list : [])
        .map((item) => ({
            name: String(item?.name || '').trim(),
            packageName: String(item?.package || '').trim(),
            version: String(item?.file?.vername || '').trim(),
            size: Number(item?.file?.filesize || item?.size || 0),
            url: typeof item?.file?.path === 'string' ? item.file.path : '',
            trusted: item?.file?.malware?.rank === 'TRUSTED',
            downloads: Number(item?.stats?.downloads || item?.stats?.pdownloads || 0)
        }))
        .filter((app) => app.name && app.url.startsWith('https://'))
        .slice(0, limit);

/** Search apps by name on the Aptoide store (public API, no key). */
export const appSearch = async (query) => {
    const data = await fetchJson(`https://ws75.aptoide.com/api/7/apps/search?query=${encodeURIComponent(query)}&limit=5&mature=false`);
    return pickApps(data);
};

// ── Sending ──────────────────────────────────────────────────────────────

/** Send a remote file to the chat. kind: 'video' | 'audio' | 'image' | 'document'. */
export const sendFile = async (sock, message, { kind, url, caption = '', fileName = '', mimetype = '' }) => {
    let content;
    if (kind === 'audio') {
        content = { audio: { url }, mimetype: mimetype || 'audio/mpeg', fileName: fileName || 'audio.mp3' };
    } else if (kind === 'image') {
        content = { image: { url }, caption };
    } else if (kind === 'document') {
        content = { document: { url }, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'file', caption };
    } else {
        content = { video: { url }, caption };
    }
    return sock.sendMessage(message.chat, content, { quoted: message.raw });
};

export const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
