import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from './ffmpeg.js';
import { FONTS, fontById, fontPath } from './fonts.js';

/**
 * Colour text cards: a square picture like a WhatsApp text status
 * (solid background, centred text, one of six fonts), drawn with ffmpeg drawtext.
 * Each line is drawn on its own so every line is centred, also for Arabic.
 */

export const SIZE = 1080;
const MARGIN = 90;
export const MAX_CHARS = 300;

export const COLORS = Object.freeze({
    red: 'E53935', orange: 'FB8C00', yellow: 'FDD835', green: '43A047', teal: '00897B',
    blue: '1E88E5', navy: '1A237E', purple: '8E24AA', pink: 'EC407A', brown: '6D4C41',
    black: '111111', white: 'FFFFFF', gray: '607D8B', gold: 'C9A227', mint: '9FE2BF', sky: '81D4FA'
});
const ARABIC_COLORS = {
    'احمر': 'red', 'أحمر': 'red', 'برتقالي': 'orange', 'اصفر': 'yellow', 'أصفر': 'yellow', 'اخضر': 'green', 'أخضر': 'green',
    'ازرق': 'blue', 'أزرق': 'blue', 'كحلي': 'navy', 'بنفسجي': 'purple', 'وردي': 'pink', 'بني': 'brown',
    'اسود': 'black', 'أسود': 'black', 'ابيض': 'white', 'أبيض': 'white', 'رمادي': 'gray', 'ذهبي': 'gold'
};
/** Order the "next colour" button walks through. */
export const CYCLE = ['blue', 'purple', 'pink', 'red', 'orange', 'gold', 'green', 'teal', 'navy', 'black', 'sky', 'mint'];

/** "red", "أحمر", "#ff0", "ff8800" → "FF8800"; anything else → null. */
export const parseColor = (token) => {
    const t = String(token || '').trim().toLowerCase();
    const name = ARABIC_COLORS[t] || t;
    if (COLORS[name]) return COLORS[name];
    const hex = name.replace(/^#/, '');
    if (/^[0-9a-f]{6}$/.test(hex)) return hex.toUpperCase();
    if (/^[0-9a-f]{3}$/.test(hex) && t.startsWith('#')) return hex.split('').map((c) => c + c).join('').toUpperCase();
    return null;
};

const luminance = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** White or near-black, whichever reads better on the background. */
export const contrastText = (bg) => (luminance(bg) > 0.45 ? '111111' : 'FFFFFF');

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const hasArabic = (text) => ARABIC.test(text);

/** Removes emoji (the fonts have none, they would print as boxes). */
export const cleanText = (text) => {
    const cleaned = String(text || '').replace(EMOJI, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return { text: cleaned.slice(0, MAX_CHARS), droppedEmoji: cleaned !== String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() };
};

/** Arabic text cannot use the Latin-only fonts: fall back to IBM Plex Arabic. */
export const pickFont = (id, text) => {
    const font = fontById(id) || FONTS[0];
    return !font.arabic && hasArabic(text) ? { font: FONTS[0], swapped: true } : { font, swapped: false };
};

const charWidth = (text) => (hasArabic(text) ? 0.5 : 0.58);

/** Word-wraps into lines that fit at `size`; a word longer than a line is cut. */
export const wrap = (text, size) => {
    const maxChars = Math.max(4, Math.floor((SIZE - 2 * MARGIN) / (size * charWidth(text))));
    const lines = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (let word of paragraph.split(' ').filter(Boolean)) {
            while (word.length > maxChars) {
                if (line) { lines.push(line); line = ''; }
                lines.push(word.slice(0, maxChars));
                word = word.slice(maxChars);
            }
            if (!line) line = word;
            else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
            else { lines.push(line); line = word; }
        }
        lines.push(line);
    }
    return lines;
};

/** Biggest font size whose wrapped lines fit the square. */
export const layout = (text) => {
    for (let size = 130; size >= 34; size -= 4) {
        const lines = wrap(text, size);
        if (lines.length * size * 1.4 <= SIZE - 2 * MARGIN) return { size, lines };
    }
    return { size: 34, lines: wrap(text, 34).slice(0, 20) };
};

/**
 * Renders the card. Returns a PNG buffer.
 * @param {{ text: string, bg: string, fg?: string, font: object }} spec
 */
export const renderColorText = async ({ text, bg, fg, font }) => {
    const file = await fontPath(font);
    const { size, lines } = layout(text);
    const color = fg || contrastText(bg);
    const lineHeight = Math.round(size * 1.4);
    const top = Math.round((SIZE - lines.length * lineHeight) / 2);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-ct-'));
    try {
        const filters = [];
        for (const [i, line] of lines.entries()) {
            if (!line.trim()) continue;
            const lineFile = path.join(dir, `l${i}.txt`);
            await writeFile(lineFile, line);
            const y = top + i * lineHeight + Math.round((lineHeight - size) / 2);
            filters.push(`drawtext=fontfile='${file.replace(/'/g, "\\'")}':textfile='${lineFile}':fontsize=${size}:fontcolor=0x${color}:x=(w-text_w)/2:y=${y}`);
        }
        const out = path.join(dir, 'card.png');
        await runFfmpeg(['-f', 'lavfi', '-i', `color=c=0x${bg}:s=${SIZE}x${SIZE}`, '-frames:v', '1', ...(filters.length ? ['-vf', filters.join(',')] : []), out], { timeoutMs: 20_000 });
        return await readFile(out);
    } finally {
        rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};
