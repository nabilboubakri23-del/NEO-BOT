import { UserError } from '../../utils/errors.js';
import { fetchText } from './.lib.js';

/**
 * Pinterest public web resources (the same JSON the website loads, no login, no key).
 * Every pin is normalised to one shape so ranking and delivery never touch raw data:
 *   { id, url, kind: 'image'|'video', title, description, alt, board, author, hashtags,
 *     reactions, saves, width, height, image: { preview, full }, video?: { hls, duration, width, height, thumbnail } }
 */

const BASE = 'https://www.pinterest.com';
const HOSTS = ['pinterest.com'];
/** pinterest.com, www/api/xx.pinterest.com and country domains (pinterest.fr, pinterest.co.uk...). */
export const isPinterestHost = (host) => /(^|\.)pinterest\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/i.test(String(host || ''));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SEARCH_TTL = 10 * 60_000;
const cache = new Map();

export const SCOPES = { image: 'pins', edit: 'videos', video: 'videos' };

const headers = (sourceUrl, handler) => ({
    'User-Agent': UA,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Pinterest-AppState': 'active',
    'X-Pinterest-Source-Url': sourceUrl,
    'X-Pinterest-PWS-Handler': handler
});

const resource = async (name, options, sourceUrl, handler) => {
    const data = JSON.stringify({ options: { ...options, source_url: sourceUrl }, context: {} });
    const url = `${BASE}/resource/${name}/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(data)}&_=${Date.now()}`;
    const text = await fetchText(url, { headers: headers(sourceUrl, handler), allowHosts: HOSTS, timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 });
    let json;
    try { json = JSON.parse(text); } catch { throw new UserError('Pinterest answered with something unexpected. Try again.'); }
    const response = json?.resource_response;
    if (!response || response.status === 'failure') {
        if (response?.http_status === 404) throw new UserError('That pin was not found or is private.');
        throw new UserError('Pinterest is not answering right now. Try again in a minute.');
    }
    return response;
};

const str = (v, max = 300) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const pinimg = (u) => (typeof u === 'string' && /^https:\/\/i\.pinimg\.com\//.test(u) ? u : '');
const vimg = (u) => (typeof u === 'string' && /^https:\/\/v\d*\.pinimg\.com\/.+\.m3u8$/.test(u) ? u : '');

const sumReactions = (counts) => Object.values(counts || {}).reduce((n, v) => n + (Number(v) || 0), 0);

/** Video list of a pin: classic video pins or story ("idea") pins. */
const findVideoList = (pin) => {
    if (pin?.videos?.video_list) return pin.videos.video_list;
    for (const page of pin?.story_pin_data?.pages || []) {
        for (const block of page?.blocks || []) if (block?.video?.video_list) return block.video.video_list;
    }
    return null;
};

const pickHls = (list) => {
    if (!list) return null;
    const entry = list.V_HLSV4 || list.V_HLSV3_MOBILE || Object.values(list).find((v) => vimg(v?.url));
    const hls = vimg(entry?.url);
    if (!hls) return null;
    return {
        hls,
        duration: Math.round((Number(entry.duration) || 0) / 1000),
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
        thumbnail: pinimg(entry.thumbnail)
    };
};

export const hashtagsOf = (text) => [...new Set((String(text).match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1).toLowerCase()))].slice(0, 30);

/** Raw Pinterest pin object → normalised pin, or null when unusable. */
export const normalizePin = (pin) => {
    if (!pin || pin.type !== 'pin' || pin.is_promoted || !pin.id) return null;
    const id = String(pin.id);
    if (!/^[\w-]{5,120}$/.test(id)) return null;
    const images = pin.images || {};
    const full = pinimg(images.orig?.url) || pinimg(images['736x']?.url);
    const preview = pinimg(images['736x']?.url) || pinimg(images['474x']?.url) || full;
    const video = pickHls(findVideoList(pin));
    if (!full && !video) return null;
    const title = str(pin.title || pin.grid_title, 200);
    const description = str(pin.description, 500);
    return {
        id,
        url: `${BASE}/pin/${id}/`,
        kind: video ? 'video' : 'image',
        title,
        description,
        alt: str(pin.auto_alt_text || pin.seo_alt_text, 200),
        board: str(pin.board?.name, 100),
        author: str(pin.pinner?.full_name || pin.pinner?.username, 80),
        hashtags: hashtagsOf(`${title} ${description}`),
        reactions: sumReactions(pin.reaction_counts),
        saves: Number(pin.aggregated_pin_data?.aggregated_stats?.saves || pin.repin_count || 0),
        width: Number(images.orig?.width) || 0,
        height: Number(images.orig?.height) || 0,
        signature: str(pin.image_signature, 64),
        image: { preview: preview || video?.thumbnail || '', full: full || video?.thumbnail || '' },
        ...(video ? { video } : {})
    };
};

/**
 * One search page. scope: 'pins' | 'videos'. Returns { pins, bookmark }.
 * Results are cached for 10 minutes per (scope, query, bookmark).
 */
export const searchPage = async (query, scope = 'pins', bookmark = null) => {
    const q = String(query || '').trim();
    const key = `${scope}|${q.toLowerCase()}|${bookmark || ''}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const sourceUrl = `/search/${scope}/?q=${encodeURIComponent(q)}&rs=typed`;
    const response = await resource('BaseSearchResource', {
        query: q, scope, page_size: 25, rs: 'typed', redux_normalize_feed: true, ...(bookmark ? { bookmarks: [bookmark] } : {})
    }, sourceUrl, 'www/search/[scope].js');
    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    const value = { pins: results.map(normalizePin).filter(Boolean), bookmark: typeof response.bookmark === 'string' && response.bookmark !== '-end-' ? response.bookmark : null };
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + SEARCH_TTL });
    return value;
};

/** Up to `pages` search pages merged (deduplicated by id). */
export const searchPins = async (query, scope, { pages = 2, bookmark = null } = {}) => {
    const all = new Map();
    let next = bookmark;
    for (let i = 0; i < pages; i++) {
        const page = await searchPage(query, scope, next);
        for (const pin of page.pins) if (!all.has(pin.id)) all.set(pin.id, pin);
        next = page.bookmark;
        if (!next) break;
    }
    return { pins: [...all.values()], bookmark: next };
};

/** Full details of one pin by id. */
export const getPin = async (id) => {
    const sourceUrl = `/pin/${encodeURIComponent(id)}/`;
    const response = await resource('PinResource', { id, field_set_key: 'detailed' }, sourceUrl, 'www/pin/[id].js');
    const pin = normalizePin({ ...response.data, type: 'pin' });
    if (!pin) throw new UserError('That pin has no downloadable image or video.');
    return pin;
};

/** pin.it short link → pin id (follows Pinterest's own redirects only). */
const resolveShort = async (url) => {
    let current = url;
    for (let i = 0; i < 4; i++) {
        const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
        const location = res.headers.get('location');
        if (!location) break;
        const next = new URL(location, current);
        if (!isPinterestHost(next.hostname) && next.hostname !== 'pin.it') throw new UserError('That short link does not lead to Pinterest.');
        const id = next.pathname.match(/\/pin\/([\w-]+)/)?.[1];
        if (id) return id;
        current = next.href;
    }
    throw new UserError('Could not open that Pinterest short link. Copy the full pin link instead.');
};

/** Extracts a pin id from a pin link (pinterest.*\/pin/<id>, pin.it/<code>), or null. */
export const parsePinLink = (text) => {
    const raw = String(text || '').match(/https?:\/\/\S+/i)?.[0];
    if (!raw) return null;
    let url;
    try { url = new URL(raw); } catch { return null; }
    const host = url.hostname.toLowerCase();
    if (host === 'pin.it') return { short: url.href };
    if (!isPinterestHost(host)) return null;
    const id = url.pathname.match(/\/pin\/(?:[\w-]*--)?([\w-]{5,120})\/?/)?.[1];
    return id ? { id } : null;
};

export const pinFromLink = async (text) => {
    const parsed = parsePinLink(text);
    if (!parsed) throw new UserError('That is not a Pinterest pin link.');
    return getPin(parsed.id || (await resolveShort(parsed.short)));
};
