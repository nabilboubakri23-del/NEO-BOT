/**
 * Text normalization for the profanity filter. Pure, no I/O.
 *
 * Defeats the usual tricks: diacritics (tashkeel), tatweel, invisible and
 * direction characters, Arabic letter variants, Cyrillic/Greek look-alikes,
 * full-width letters, leetspeak (f4ck, sh1t), repeated letters (fuuuck, كسسس),
 * symbols inside a word (f.u.c.k, ك-س) and letters spaced out (ك س م ك, f u c k).
 */

// Tashkeel, Quranic marks, tatweel, soft hyphen, zero-width, bidi controls, BOM, Mongolian separator.
const INVISIBLE = /[\u00AD\u034F\u0610-\u061A\u061C\u064B-\u065F\u0670\u06D6-\u06ED\u0640\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

const ARABIC_MAP = {
    'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ٲ': 'ا', 'ٳ': 'ا',
    'ى': 'ي', 'ئ': 'ي', 'ی': 'ي', 'ې': 'ي', 'ۍ': 'ي',
    'ؤ': 'و', 'ۆ': 'و', 'ۇ': 'و',
    'ة': 'ه', 'ۀ': 'ه', 'ہ': 'ه', 'ھ': 'ه', 'ە': 'ه',
    'ک': 'ك', 'ڪ': 'ك', 'گ': 'ك', 'ڭ': 'ك',
    'ڤ': 'ف', 'ڥ': 'ف', 'پ': 'ب', 'چ': 'ج', 'ژ': 'ز', 'ڨ': 'ق',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

// Cyrillic / Greek / other look-alikes → Latin.
const HOMOGLYPHS = {
    'а': 'a', 'е': 'e', 'ё': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't',
    'н': 'h', 'в': 'b', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l', 'ц': 'u', 'п': 'n', 'г': 'r',
    'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
    'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ı': 'i'
};

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l', '¥': 'y' };

const LETTER = /[\p{L}\p{N}]/u;
const NON_LETTER = /[^\p{L}\p{N}]/gu;

/** Unicode-level cleanup shared by every variant. */
export const baseNormalize = (text) => {
    let s = String(text || '').normalize('NFKC').replace(INVISIBLE, '');
    s = s.normalize('NFKD').replace(/\p{M}/gu, ''); // Latin accents (é → e); Arabic marks were removed above
    s = s.toLowerCase();
    let out = '';
    for (const ch of s) out += ARABIC_MAP[ch] ?? HOMOGLYPHS[ch] ?? ch;
    return out;
};

const isLatinish = (token) => /[a-z]/.test(token);

/**
 * Splits text into cleaned words.
 * @param {string} text
 * @param {{ leet: boolean }} options leet = map digits/symbols to letters in Latin words (otherwise kept, for Arabizi like "9a7ba")
 */
export const words = (text, { leet = false } = {}) => {
    const raw = baseNormalize(text).split(/\s+/).filter(Boolean);
    const cleaned = raw
        .map((token) => {
            let t = token;
            if (leet && isLatinish(t)) t = [...t].map((ch) => LEET[ch] ?? ch).join('');
            return t.replace(NON_LETTER, '');
        })
        .filter(Boolean);
    // Re-join letters spaced out on purpose: "ك س م ك" → "كسمك", "f u c k" → "fuck".
    const joined = [];
    let run = '';
    for (const t of cleaned) {
        if ([...t].length === 1 && LETTER.test(t)) {
            run += t;
            continue;
        }
        if (run) joined.push(run);
        run = '';
        joined.push(t);
    }
    if (run) joined.push(run);
    return joined;
};

/** Collapses repeated letters: runs of 2+ → 1 ("fuuuck" → "fuck"). */
export const squeeze = (word) => word.replace(/(.)\1+/gu, '$1');

/** Collapses runs of 3+ to 2 ("asssss" → "ass"), keeping real double letters. */
export const squeezeKeepDouble = (word) => word.replace(/(.)\1{2,}/gu, '$1$1');

/** Normalizes one dictionary entry the same way message text is (without spacing tricks). */
export const normalizeEntry = (entry, { leet = false } = {}) => words(entry, { leet }).join(' ');
