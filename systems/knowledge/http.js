import config from '../../config/config.js';
import { UserError } from '../../utils/errors.js';

/**
 * JSON fetcher for the knowledge commands: timeout, a polite User-Agent,
 * and a small in-memory cache so repeated lookups do not hit the APIs again.
 */

const cache = new Map(); // url → { at, data }
const MAX_ENTRIES = 300;

export const getJson = async (url, { ttl = 10 * 60 * 1000, timeout = 12000, notFound = null } = {}) => {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    let res;
    try {
        res = await fetch(url, {
            headers: { 'User-Agent': `${config.bot.name || 'NEO-BOT'}/${config.bot.version || '1'} (WhatsApp bot)`, Accept: 'application/json' },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeout)
        });
    } catch {
        throw new UserError('The source did not answer. Try again in a moment.');
    }
    if (res.status === 404 && notFound) throw new UserError(notFound);
    if (!res.ok) throw new UserError(`The source answered with an error (HTTP ${res.status}).`);
    const data = await res.json().catch(() => {
        throw new UserError('The source sent an unreadable answer.');
    });
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(url, { at: Date.now(), data });
    return data;
};

/** True when the text is mostly Arabic script. */
export const isArabic = (text) => /[\u0600-\u06FF]/.test(String(text || ''));

/** Trims text to a maximum length at a sentence or word boundary. */
export const clip = (text, max = 900) => {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('؟'));
    return `${end > max * 0.6 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' '))}…`;
};
