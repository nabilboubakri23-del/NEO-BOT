import * as arabic from './wordlists/arabic.js';
import * as english from './wordlists/english.js';
import { normalizeEntry, squeeze, squeezeKeepDouble, words } from './normalize.js';

/**
 * Profanity matcher. Pure: text in, verdict out.
 * Built-in lists are compiled once into Sets of normalized entries. Group custom
 * words and allow-listed words are passed per call (already normalized).
 */

const AR_PREFIXES = ['وبال', 'وال', 'فال', 'بال', 'كال', 'لل', 'ال', 'يا', 'و', 'ف', 'ب', 'ل'];
const AR_SUFFIXES = ['كما', 'كم', 'كن', 'هم', 'هن', 'ها', 'نا', 'ات', 'ين', 'ون', 'ك', 'ه', 'ي'];
const EN_SUFFIXES = ['ings', 'ing', 'ers', 'er', 'ed', 'es', 's', 'y', 'in'];

const LEVELS = { severe: 2, mild: 1 };

const compile = () => {
    const sets = { word: new Map(), stem: [], sub: [], phrase: [] };
    const addWord = (w, sev, leet) => {
        const n = normalizeEntry(w, { leet });
        if (!n) return;
        if (n.includes(' ')) sets.phrase.push({ n, nospace: n.replace(/ /g, ''), sev });
        else if (!sets.word.has(n) || LEVELS[sev] > LEVELS[sets.word.get(n)]) sets.word.set(n, sev);
    };
    for (const sev of ['severe', 'mild']) {
        const ar = arabic[sev];
        ar.word.forEach((w) => addWord(w, sev, false));
        ar.phrase.forEach((w) => addWord(w, sev, false));
        ar.stem.forEach((w) => sets.stem.push({ n: normalizeEntry(w), sev }));
        const az = arabic.arabizi[sev];
        az.word.forEach((w) => addWord(w, sev, false));
        az.phrase.forEach((w) => addWord(w, sev, false));
        const en = english[sev];
        en.word.forEach((w) => addWord(w, sev, true));
        en.phrase.forEach((w) => addWord(w, sev, true));
        en.sub.forEach((w) => sets.sub.push({ n: normalizeEntry(w, { leet: true }), sev }));
    }
    return sets;
};

const BUILTIN = compile();

/** Number of built-in entries (for status displays). */
export const builtinSize = () => BUILTIN.word.size + BUILTIN.stem.length + BUILTIN.sub.length + BUILTIN.phrase.length;

const isArabic = (w) => /[\u0600-\u06FF]/.test(w);

/** Every form a word may hide behind: squeezed letters, stripped prefixes and suffixes. */
const forms = (word) => {
    const out = new Set();
    for (const base of new Set([word, squeeze(word), squeezeKeepDouble(word)])) {
        out.add(base);
        if (isArabic(base)) {
            const stripped = [base];
            for (const p of AR_PREFIXES) if (base.startsWith(p) && base.length - p.length >= 3) stripped.push(base.slice(p.length));
            for (const s of stripped) {
                out.add(s);
                for (const suf of AR_SUFFIXES) if (s.endsWith(suf) && s.length - suf.length >= 2) out.add(s.slice(0, -suf.length));
            }
        } else {
            for (const suf of EN_SUFFIXES) if (base.endsWith(suf) && base.length - suf.length >= 3) out.add(base.slice(0, -suf.length));
        }
    }
    return out;
};

const accepts = (sev, level) => LEVELS[sev] >= (level === 'strict' ? 1 : 2);

/**
 * Checks a text.
 * @param {string} text
 * @param {{ level?: 'normal'|'strict', custom?: string[], allow?: string[] }} options
 *   custom/allow: normalized words from the group's own lists (see customWords.js)
 * @returns {{ hit: boolean, severity?: string, source?: string }}
 */
export const checkText = (text, { level = 'normal', custom = [], allow = [] } = {}) => {
    if (!text) return { hit: false };
    const allowed = new Set(allow);
    const variants = [words(text, { leet: false }), words(text, { leet: true })];
    const customWords = custom.filter((c) => !c.includes(' '));
    const customPhrases = custom.filter((c) => c.includes(' '));

    for (const list of variants) {
        // Single words.
        for (const word of list) {
            if (allowed.has(word) || allowed.has(squeeze(word))) continue;
            const fs = forms(word);
            for (const f of fs) {
                if (allowed.has(f)) continue;
                const sev = BUILTIN.word.get(f);
                if (sev && accepts(sev, level)) return { hit: true, severity: sev, source: 'list' };
                if (customWords.includes(f)) return { hit: true, severity: 'custom', source: 'custom' };
            }
            const sq = squeeze(word);
            for (const { n, sev } of BUILTIN.stem) {
                if (accepts(sev, level) && !allowed.has(n) && [...fs].some((f) => f.startsWith(n))) return { hit: true, severity: sev, source: 'list' };
            }
            for (const { n, sev } of BUILTIN.sub) {
                if (accepts(sev, level) && !allowed.has(n) && (word.includes(n) || sq.includes(squeeze(n)))) return { hit: true, severity: sev, source: 'list' };
            }
            for (const c of customWords) if (c.length >= 4 && sq.includes(squeeze(c))) return { hit: true, severity: 'custom', source: 'custom' };
        }
        // Phrases, with and without spaces ("كس امك" = "كسامك" = "ك س ا م ك").
        const spaced = ` ${list.map(squeezeKeepDouble).join(' ')} `;
        const squeezedSpaced = ` ${list.map(squeeze).join(' ')} `;
        const nospace = list.join('');
        for (const { n, nospace: ns, sev } of BUILTIN.phrase) {
            if (!accepts(sev, level) || allowed.has(n)) continue;
            if (spaced.includes(` ${n} `) || squeezedSpaced.includes(` ${squeeze(n)} `) || (ns.length >= 6 && squeeze(nospace).includes(squeeze(ns)))) {
                return { hit: true, severity: sev, source: 'list' };
            }
        }
        for (const c of customPhrases) {
            if (spaced.includes(` ${c} `) || squeeze(nospace).includes(squeeze(c.replace(/ /g, '')))) return { hit: true, severity: 'custom', source: 'custom' };
        }
    }
    return { hit: false };
};

/** Normalizes a word or phrase typed by an admin for the custom lists. */
export const normalizeCustom = (input) => normalizeEntry(input, { leet: /[a-z]/i.test(input) && !/[\u0600-\u06FF]/.test(input) });
