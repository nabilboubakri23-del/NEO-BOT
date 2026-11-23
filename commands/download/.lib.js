import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
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
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Largest video/audio the bot buffers for delivery (Render free has 512 MB RAM). */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

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

// ── DNS and transport guards ─────────────────────────────────────────────

const PRIVATE_V4 = [
    /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^127\./,
    /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.0\.0\./, /^192\.0\.2\./,
    /^192\.168\./, /^198\.(18|19)\./, /^198\.51\.100\./, /^203\.0\.113\./, /^2(2[4-9]|[3-9]\d)\./
];

/** True for loopback, private, link-local, CGNAT, documentation and multicast addresses. */
export const isPrivateIp = (ip) => {
    let v = String(ip || '').toLowerCase();
    if (v.startsWith('::ffff:')) v = v.slice(7);
    if (v.includes('.')) return PRIVATE_V4.some((re) => re.test(v));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
};

/**
 * dns lookup callback for https.request that refuses any hostname resolving to
 * a private address: the SSRF guard that allowlists alone cannot give (DNS).
 */
const safeLookup = async (hostname, options, callback) => {
    try {
        const all = await dns.lookup(hostname, { all: true, verbatim: true });
        if (!all.length || all.some((a) => isPrivateIp(a.address))) return callback(new Error(`Blocked address for ${hostname}`));
        // Node passes { all: true } to custom lookups and then expects an array.
        callback(null, options?.all ? [all[0]] : all[0].address, options?.all ? undefined : all[0].family);
    } catch (error) {
        callback(error);
    }
};

const httpsRequest = (url, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'User-Agent': UA, ...headers }, lookup: safeLookup, timeout: 30_000 }, resolve);
        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });

/** File-type detection from magic bytes; 'htmlpage' means the service sent a web page. */
export const sniffKind = (buffer) => {
    const b = buffer;
    if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video';
    if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'audio';
    if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio';
    if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio';
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image';
    if (b.length >= 4 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image';
    if (b.length >= 3 && b.toString('ascii', 0, 3) === 'GIF') return 'image';
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image';
    if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b) return 'archive';
    const head = b.toString('latin1', 0, 200).trimStart().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'htmlpage';
    return 'unknown';
};

/**
 * Download a provider file with every guard applied at acquisition time:
 * https only, optional host allowlist on every redirect hop, DNS resolution
 * through safeLookup (private addresses refused), a streamed size cap, and a
 * magic-byte type check. Returns { buffer, size, contentType, kind }.
 */
export const downloadFile = async (url, { allowHosts, maxBytes = MAX_MEDIA_BYTES, expect = [], maxRedirects = 5 } = {}) => {
    let current = String(url || '');
    for (let redirects = 0; ; redirects++) {
        let parsed;
        try {
            parsed = new URL(current);
        } catch {
            throw new UserError('⚠️ Unsafe download address.');
        }
        if (parsed.protocol !== 'https:') throw new UserError('⚠️ Unsafe download address.');
        if (allowHosts && !hostAllowed(parsed.hostname, allowHosts)) throw new UserError('⚠️ Unexpected download address.');

        let res;
        try {
            res = await httpsRequest(current);
        } catch (error) {
            if (/Blocked address/.test(error?.message || '')) throw new UserError('⚠️ That download address is not allowed.');
            throw new UserError('⚠️ Could not reach the download server. Try again later.');
        }
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
            res.resume();
            if (redirects >= maxRedirects) throw new UserError('⚠️ The service redirected too many times.');
            current = new URL(location, current).toString();
            continue;
        }
        if (res.statusCode !== 200) {
            res.resume();
            throw new UserError(`⚠️ The service refused the download (${res.statusCode}). Try again later.`);
        }
        const declared = Number(res.headers['content-length'] || 0);
        if (declared > maxBytes) {
            res.resume();
            throw new UserError(`⚠️ File too large (${formatSize(declared)}). Maximum is ${formatSize(maxBytes)}.`);
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of res) {
            total += chunk.length;
            if (total > maxBytes) {
                res.destroy();
                throw new UserError(`⚠️ File too large. Maximum is ${formatSize(maxBytes)}.`);
            }
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const kind = sniffKind(buffer);
        if (kind === 'htmlpage') throw new UserError('⚠️ The service answered with a web page instead of the file. Try again later.');
        if (expect.length && !expect.includes(kind)) throw new UserError('⚠️ The downloaded file was not the expected type.');
        return { buffer, size: total, contentType: String(res.headers['content-type'] || ''), kind };
    }
};

// ── HTTP helpers ─────────────────────────────────────────────────────────

const hostAllowed = (host, allowHosts) => {
    const h = String(host || '').toLowerCase();
    return allowHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
};

/**
 * Fetch with manual redirect handling: https is never downgraded, and when
 * allowHosts is set every redirect target is re-checked against it, so a
 * validated URL can never bounce the bot to an arbitrary host (SSRF guard).
 */
const fetchGuarded = async (url, { method = 'GET', headers = {}, body, signal, allowHosts, maxRedirects = 5 } = {}) => {
    let current = url;
    for (let redirects = 0; ; redirects++) {
        const res = await fetch(current, { method, headers, body, signal, redirect: 'manual' });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
            res.body?.cancel().catch(() => {});
            if (redirects >= maxRedirects) throw new UserError('⚠️ The service redirected too many times.');
            const next = new URL(location, current);
            if (next.protocol !== 'https:') throw new UserError('⚠️ The service redirected to an unsafe address.');
            if (allowHosts && !hostAllowed(next.hostname, allowHosts)) {
                throw new UserError('⚠️ The service redirected to an unexpected address.');
            }
            current = next.toString();
            continue;
        }
        return res;
    }
};

/** GET/POST text with timeout and a hard size cap. Errors become safe UserErrors. */
export const fetchText = async (url, { method = 'GET', headers = {}, body, form, maxBytes = MAX_PAGE_BYTES, timeoutMs = FETCH_TIMEOUT_MS, allowHosts } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const finalHeaders = { 'User-Agent': UA, ...headers };
        let finalBody = body;
        if (form) {
            finalBody = new URLSearchParams(form).toString();
            finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        const res = await fetchGuarded(url, { method, headers: finalHeaders, body: finalBody, signal: controller.signal, allowHosts });
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
export const remoteSize = async (url, { timeoutMs = 10_000, allowHosts } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchGuarded(url, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: controller.signal, allowHosts });
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
        form: { id: url, locale: 'en', tt: crypto.randomBytes(8).toString('hex') },
        allowHosts: ['ssstik.io']
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
    const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { allowHosts: ['youtube.com'] });
    return parseYtSearch(html);
};

/** open.spotify.com track URL → track id, or null. */
export const parseSpotifyTrack = (text) => {
    const match = String(text || '').match(/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]+)/i);
    return match?.[1] || null;
};

/** Spotify oEmbed (official, no key) → { title, thumbnail }. */
export const spotifyInfo = async (trackUrl) => {
    const data = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`, { allowHosts: ['spotify.com'] });
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
    const data = await fetchJson(`https://ws75.aptoide.com/api/7/apps/search?query=${encodeURIComponent(query)}&limit=5&mature=false`, { allowHosts: ['aptoide.com'] });
    return pickApps(data);
};

/** Pick app number n (1-based) from a search list; only store-screened apps may be downloaded. */
export const pickApp = (apps, n) => {
    const app = apps[n - 1];
    if (!app) throw new UserError('⚠️ No app with that number in the results.');
    if (!app.trusted) throw new UserError('⚠️ That app did not pass the store malware screening, so downloading it is blocked. Pick a ✅ screened result.');
    return app;
};

/** Re-resolve an app at download time: fresh store state, current APK link and screening rank. */
export const appVerify = async (packageName) => {
    const data = await fetchJson(`https://ws75.aptoide.com/api/7/app/get?package_name=${encodeURIComponent(packageName)}&mature=false`, { allowHosts: ['aptoide.com'] });
    const node = data?.nodes?.meta?.data || data?.datalist?.list?.[0] || {};
    const file = node?.file || {};
    return {
        name: String(node?.name || '').trim(),
        packageName: String(node?.package || packageName).trim(),
        version: String(file?.vername || '').trim(),
        size: Number(file?.filesize || node?.size || 0),
        url: typeof file?.path === 'string' ? file.path : '',
        // TRUSTED is Aptoide's malware screening badge - not publisher identity verification.
        trusted: file?.malware?.rank === 'TRUSTED'
    };
};

// ── Sending ──────────────────────────────────────────────────────────────

/**
 * Resolve a cobalt/picker result, download the media with full guards and send it.
 * kind is taken from the picker item (photo→image) or the requested mode.
 */
export const deliverMedia = async (sock, message, result, { audio = false, caption = '' } = {}) => {
    const item = result.kind === 'picker' ? result.items[0] : null;
    const url = item ? item.url : result.url;
    const kind = item?.type === 'photo' ? 'image' : audio ? 'audio' : 'video';
    const file = await downloadFile(url, {
        maxBytes: MAX_MEDIA_BYTES,
        expect: kind === 'image' ? ['image'] : kind === 'audio' ? ['audio'] : ['video']
    });
    await sendFile(sock, message, {
        kind,
        buffer: file.buffer,
        caption,
        fileName: kind === 'audio' ? `${result.fileName || 'audio'}.mp3` : ''
    });
};

/** Send a downloaded file buffer to the chat. kind: 'video' | 'audio' | 'image' | 'document'. */
export const sendFile = async (sock, message, { kind, buffer, caption = '', fileName = '', mimetype = '' }) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new UserError('⚠️ The download was empty. Try again later.');
    let content;
    if (kind === 'audio') {
        content = { audio: buffer, mimetype: mimetype || 'audio/mpeg', fileName: fileName || 'audio.mp3' };
    } else if (kind === 'image') {
        content = { image: buffer, caption };
    } else if (kind === 'document') {
        content = { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'file', caption };
    } else {
        content = { video: buffer, caption };
    }
    return sock.sendMessage(message.chat, content, { quoted: message.raw });
};

export const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

// ── Spotify via spotimate.app (free converter, keyless, server-side) ─────

const SPOTIMATE_HOSTS = ['spotimate.app'];

/** Raw request through the DNS guard that also exposes status and headers (for cookies). */
const requestRaw = (url, { method = 'GET', headers = {}, body, maxBytes = MAX_PAGE_BYTES } = {}) =>
    new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'User-Agent': UA, ...headers }, lookup: safeLookup, timeout: 30_000 }, (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    req.destroy(new Error('Response too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });

const cookieHeader = (headers) => (headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');

const multipart = (fields) => {
    const boundary = `----NeoBotForm${crypto.randomBytes(8).toString('hex')}`;
    const body = Object.entries(fields)
        .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
        .join('') + `--${boundary}--\r\n`;
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

/** Extract per-track form fields (data, token, base) from spotimate's /action HTML. */
export const parseSpotmateForms = (html) => {
    const tracks = [];
    for (const form of String(html || '').match(/<form[\s\S]*?<\/form>/gi) || []) {
        const value = (name) => {
            const re = new RegExp(`<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
            const re2 = new RegExp(`<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
            return form.match(re)?.[1] || form.match(re2)?.[1] || '';
        };
        const data = value('data');
        const token = value('token') || value('track_token');
        if (!data || !token) continue;
        let title = '';
        try {
            const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
            title = decoded.name || decoded.title || '';
        } catch { /* keep empty title */ }
        tracks.push({ data, token, base: value('base'), title });
    }
    return tracks;
};

/** Pick the real MP3 link out of spotimate's /action/track HTML (skip covers and ads). */
export const parseSpotmateDownload = (html) => {
    for (const match of String(html || '').matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
        const href = match[1];
        const lower = href.toLowerCase();
        if (lower.includes('tunecable') || lower.includes('premium')) continue;
        if (/scdn\.co|\.(jpg|jpeg|png|webp)(\?|$)/i.test(lower)) continue;
        if (!hostAllowed(new URL(href).hostname, SPOTIMATE_HOSTS)) continue;
        return href;
    }
    return '';
};

/**
 * Resolve a Spotify track to a downloadable MP3 URL through spotimate.app.
 * Free and keyless; it is a third-party converter, not an official Spotify download.
 */
export const spotifyDownload = async (url) => {
    const clean = String(url).trim().split('?')[0];
    const base = 'https://spotimate.app';
    let cookies = '';
    try {
        const landing = await requestRaw(`${base}/en1`);
        if (landing.status !== 200) throw new Error('landing');
        cookies = cookieHeader(landing.headers);

        let token = '';
        try {
            const verify = await requestRaw(`${base}/api/userverify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: `${base}/en1`, Origin: base, Cookie: cookies },
                body: `url=${encodeURIComponent(clean)}`
            });
            token = JSON.parse(verify.text)?.token || '';
            const more = cookieHeader(verify.headers);
            if (more) cookies = cookies ? `${cookies}; ${more}` : more;
        } catch { /* the converter works without the verify token */ }

        const step1 = multipart({ url: clean, cftoken: token });
        const action = await requestRaw(`${base}/action`, {
            method: 'POST',
            headers: { 'Content-Type': step1.contentType, Referer: `${base}/en1`, Origin: base, Cookie: cookies },
            body: step1.body
        });
        const actionJson = JSON.parse(action.text);
        if (actionJson?.success === false) throw new Error('refused');
        const tracks = parseSpotmateForms(actionJson?.html || '');
        if (!tracks.length) throw new Error('no tracks');
        const track = tracks[0];

        const step2 = multipart({ data: track.data, base: track.base || clean, token: track.token });
        const dl = await requestRaw(`${base}/action/track`, {
            method: 'POST',
            headers: { 'Content-Type': step2.contentType, Referer: `${base}/en1`, Origin: base, Cookie: cookies },
            body: step2.body
        });
        const dlJson = JSON.parse(dl.text);
        const mp3 = parseSpotmateDownload(dlJson?.data || dlJson?.html || '');
        if (!mp3) throw new Error('no mp3 link');
        return { title: track.title, url: mp3 };
    } catch (error) {
        if (error?.expose) throw error;
        throw new UserError('⚠️ Could not download that Spotify track right now. Try again later.');
    }
};
