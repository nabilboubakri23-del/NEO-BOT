/**
 * WhatsApp username candidates: rules, generators and a local quality score.
 *
 * Rules (WhatsApp Help Center / Meta docs, checked 2026-11-25): 3–35 chars, a–z 0–9 . _,
 * at least one letter, no leading/trailing ".", no "..", no "www" start, no domain-like ending.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const VOWELS = new Set('aeiouy');
const RARE = new Set('qxzjvk');
const DOMAIN_END = /\.(com|net|org|io|co|me|app|ai|dev|info|biz|xyz|gg|tv|ly|us|uk|ma|fr|de)$/;

export const MODES = {
    3: 'Triple: 3 characters',
    4: 'Quad: 4 characters',
    semi: 'Triple-like: 3 letters with . or _ (a.bc, ab_c, abc_)',
    ai: 'AI ideas: short brandable names around a theme'
};

/** True when WhatsApp would accept the name. */
export const isValidUsername = (u) => {
    const s = String(u || '');
    if (s.length < 3 || s.length > 35) return false;
    if (!/^[a-z0-9._]+$/.test(s)) return false;
    if (!/[a-z]/.test(s)) return false;
    if (s.startsWith('.') || s.endsWith('.') || s.includes('..')) return false;
    if (s.startsWith('www') || DOMAIN_END.test(s)) return false;
    return true;
};

export const normalize = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();

/** Letter shape like "aab" or "abab" (digits and separators kept as-is). */
export const shapeOf = (u) => {
    const map = new Map();
    let out = '';
    for (const ch of u) {
        if (!/[a-z0-9]/.test(ch)) { out += ch; continue; }
        if (!map.has(ch)) map.set(ch, String.fromCharCode(97 + map.size));
        out += map.get(ch);
    }
    return out;
};

const core = (u) => u.replace(/[._]/g, '');

/** Local 0–100 score: shorter, all letters, patterns, pronounceable = better. */
export const scoreUsername = (u) => {
    const c = core(u);
    const letters = c.replace(/[0-9]/g, '');
    const digits = c.length - letters.length;
    const seps = u.length - c.length;
    let s = 50;
    s -= (c.length - 3) * 12;
    s -= seps * 10;
    if (u.endsWith('_') || u.startsWith('_')) s -= 4;
    if (digits === 0) s += 12;
    else if (letters.length >= 2 && /^[a-z]+[0-9]$/.test(c)) s -= 4;
    else s -= digits * 7;
    const shape = shapeOf(c);
    if (/^(a)\1+$/.test(shape)) s += 25; // aaa, aaaa
    else if (['aba', 'abab', 'abba', 'aabb'].includes(shape)) s += 14;
    else if (['aab', 'abb', 'aaab', 'abbb', 'aaba', 'abaa'].includes(shape)) s += 7;
    if (letters.length === c.length && c.length >= 3) {
        let alt = 0;
        for (let i = 1; i < c.length; i += 1) if (VOWELS.has(c[i]) !== VOWELS.has(c[i - 1])) alt += 1;
        s += (alt / (c.length - 1)) * 10; // pronounceable
        if (![...c].some((ch) => VOWELS.has(ch))) s -= 4;
    }
    if ([...c].some((ch) => RARE.has(ch))) s += 3;
    return Math.max(0, Math.min(100, Math.round(s)));
};

const pick = (str, rnd) => str[Math.floor(rnd() * str.length)];

/** Filters: { start, end, has, shape, letters } (letters = no digits). */
export const matchesFilters = (u, f = {}) => {
    if (f.start && !u.startsWith(f.start)) return false;
    if (f.end && !u.endsWith(f.end)) return false;
    if (f.has && !u.includes(f.has)) return false;
    if (f.shape && shapeOf(core(u)) !== f.shape) return false;
    if (f.letters && /[0-9]/.test(u)) return false;
    return true;
};

const randomCore = (len, f, rnd) => {
    const pool = f.letters ? LETTERS : LETTERS + LETTERS + DIGITS; // letters twice as likely
    if (f.shape && f.shape.length === len) {
        const map = new Map();
        return [...f.shape].map((k) => {
            if (!map.has(k)) {
                let ch;
                do { ch = pick(pool, rnd); } while ([...map.values()].includes(ch));
                map.set(k, ch);
            }
            return map.get(k);
        }).join('');
    }
    const chars = Array.from({ length: len }, () => pick(pool, rnd));
    // Honour start/end while generating, so narrow filters still fill the pool.
    if (f.start && f.start.length < len) chars.splice(0, f.start.length, ...f.start);
    if (f.end && f.end.length < len) chars.splice(len - f.end.length, f.end.length, ...f.end);
    return chars.join('').slice(0, len);
};

const semiForms = (abc) => [
    `${abc[0]}.${abc.slice(1)}`, `${abc.slice(0, 2)}.${abc[2]}`,
    `${abc[0]}_${abc.slice(1)}`, `${abc.slice(0, 2)}_${abc[2]}`,
    `${abc}_`, `_${abc}`
];

/**
 * Builds up to `size` distinct valid candidates for a mode, best local score first.
 * Patterns (aaa, aba…) are seeded on purpose so the rare ones are always looked at.
 */
export const generateCandidates = (mode, filters = {}, { size = 400, rnd = Math.random } = {}) => {
    const out = new Set();
    const add = (u) => { if (isValidUsername(u) && matchesFilters(u, filters)) out.add(u); };
    const len = mode === '4' ? 4 : 3;
    if (mode === '3' || mode === '4') {
        // Seed premium shapes first.
        const shapes = len === 3 ? ['aaa', 'aba', 'aab', 'abb'] : ['aaaa', 'abab', 'abba', 'aabb', 'aaab', 'abbb'];
        for (const shape of filters.shape ? [] : shapes) {
            for (let i = 0; i < 25; i += 1) add(randomCore(len, { ...filters, shape }, rnd));
        }
        for (let i = 0; i < size * 6 && out.size < size; i += 1) add(randomCore(len, filters, rnd));
    } else if (mode === 'semi') {
        for (let i = 0; i < size * 6 && out.size < size; i += 1) {
            const abc = randomCore(3, { ...filters, letters: true, start: '', end: '', has: '' }, rnd);
            for (const u of semiForms(abc)) add(u);
        }
    }
    return [...out]
        .map((u) => ({ u, score: scoreUsername(u) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, size);
};

/**
 * Picks which candidates to spend lookups on: mostly the best scores, plus a share of
 * lower-ranked ones, because the very best short names are usually taken.
 */
export const choose = (ranked, count, skip = new Set(), rnd = Math.random) => {
    const fresh = ranked.filter((c) => !skip.has(c.u));
    const top = Math.ceil(count * 0.6);
    const head = fresh.slice(0, top);
    const rest = fresh.slice(top);
    const tail = [];
    while (tail.length < count - head.length && rest.length) tail.push(rest.splice(Math.floor(rnd() * rest.length), 1)[0]);
    return [...head, ...tail];
};
