/**
 * Short duration strings used by temporary ranks: "30m", "12h", "7d", "2w", "1y".
 * Several parts may be joined: "1d12h".
 */

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
const PART = /(\d+)\s*([smhdwy])/g;
const FULL = /^(\d+\s*[smhdwy])+$/i;
const MAX_MS = 10 * UNITS.y;

/** True when the text looks like a duration ("7d", "1d12h"). */
export const isDuration = (text) => FULL.test(String(text || '').trim());

/** Milliseconds for a duration string, or null when it is not one (or out of range). */
export const parseDuration = (text) => {
    const value = String(text || '').trim().toLowerCase();
    if (!isDuration(value)) return null;
    let total = 0;
    for (const [, n, unit] of value.matchAll(PART)) total += Number(n) * UNITS[unit];
    return total > 0 && total <= MAX_MS ? total : null;
};

/** Compact remaining time: "6d 23h", "45m", "now". */
export const formatRemaining = (ms) => {
    if (ms <= 0) return 'now';
    ms = Math.ceil(ms / UNITS.m) * UNITS.m; // a fresh "7d" grant reads 7d, not 6d 23h
    const d = Math.floor(ms / UNITS.d);
    const h = Math.floor((ms % UNITS.d) / UNITS.h);
    const m = Math.floor((ms % UNITS.h) / UNITS.m);
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    return `${Math.max(m, 1)}m`;
};
