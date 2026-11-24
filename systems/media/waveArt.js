import { UserError } from '../../utils/errors.js';
import { convert } from './ffmpeg.js';

/**
 * Voice-note waveform art. WhatsApp draws a voice note's bars from the 64 values
 * (0–100) the SENDER puts in audioMessage.waveform, not from the sound itself,
 * so the bars can draw a shape. Generated sounds follow the same shape
 * (the volume rises and falls with the bars), and Morse text plays as beeps.
 */

export const BARS = 64;
const RATE = 48000;

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
const fill = (fn) => Buffer.from(Array.from({ length: BARS }, (_, i) => clamp(fn(i / (BARS - 1), i))));
const rand = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const SHAPES = {
    heart: { icon: '❤️', draw: () => fill((x) => {
        const t = Math.abs(x - 0.5) * 2; // 0 centre → 1 edge
        return t > 0.95 ? 4 : 18 + 82 * Math.sin(Math.PI * Math.min(1, t * 1.05)) ** 0.8 * (t < 0.08 ? 0.75 + t * 3 : 1);
    }) },
    wave: { icon: '🌊', draw: () => fill((x) => 50 + 45 * Math.sin(x * Math.PI * 6)) },
    pulse: { icon: '💓', draw: () => fill((x, i) => {
        const beat = i % 21;
        return [8, 8, 8, 14, 8, 4, 100, 2, 30, 8, 8, 8, 18, 22, 18, 8, 8, 8, 8, 8, 8][beat];
    }) },
    pyramid: { icon: '🔺', draw: () => fill((x) => 100 - Math.abs(x - 0.5) * 190) },
    valley: { icon: '🔻', draw: () => fill((x) => 8 + Math.abs(x - 0.5) * 184) },
    stairs: { icon: '📶', draw: () => fill((x) => 10 + Math.floor(x * 7.99) * 13) },
    zigzag: { icon: '⚡', draw: () => fill((x, i) => (i % 8 < 4 ? (i % 4) * 30 + 10 : (4 - (i % 4)) * 30 + 10)) },
    mountains: { icon: '🏔️', draw: () => fill((x) => 15 + 40 * Math.max(0, 1 - Math.abs(x - 0.25) * 5) + 80 * Math.max(0, 1 - Math.abs(x - 0.6) * 4) + 30 * Math.max(0, 1 - Math.abs(x - 0.9) * 6)) },
    city: { icon: '🏙️', draw: () => { const r = rand(7); let h = 40; return fill((x, i) => (i % 4 === 0 ? (h = 20 + r() * 80) : i % 4 === 3 ? 4 : h)); } },
    equalizer: { icon: '🎚️', draw: () => { const r = rand(Date.now() % 9973); return fill(() => 15 + r() * 85); } },
    rain: { icon: '🌧️', draw: () => { const r = rand(Date.now() % 7919); return fill(() => (r() < 0.25 ? 40 + r() * 60 : 3)); } },
    smile: { icon: '😊', draw: () => fill((x) => (Math.abs(x - 0.3) < 0.04 || Math.abs(x - 0.7) < 0.04 ? 100 : x > 0.15 && x < 0.85 ? 10 + 30 * Math.sin(((x - 0.15) / 0.7) * Math.PI) : 3)) },
    bars: { icon: '▮', draw: () => fill((x, i) => (i % 2 ? 0 : 100)) }
};

export const SHAPE_NAMES = Object.keys(SHAPES);
export const shapeIcon = (name) => SHAPES[name]?.icon || '〰️';

export const drawShape = (name) => {
    const shape = SHAPES[String(name).toLowerCase()];
    if (!shape) throw new UserError(`Unknown shape "${String(name).slice(0, 20)}".`);
    return shape.draw();
};

/** Custom bars from digits 0–9 (e.g. "1 5 9 5 1"), stretched to 64 bars. */
export const drawDigits = (text) => {
    const digits = String(text).replace(/[^0-9]/g, '').split('').map(Number);
    if (digits.length < 2) throw new UserError('Give at least 2 digits from 0 to 9, e.g. 1 3 6 9 6 3 1');
    if (digits.length > BARS) throw new UserError(`At most ${BARS} digits.`);
    return Buffer.from(Array.from({ length: BARS }, (_, i) => clamp(4 + digits[Math.floor((i * digits.length) / BARS)] * 10.6)));
};

const MORSE = {
    a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--',
    n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.'
};

/** Morse units: 1 = tone, 0 = silence (dot 1, dash 3, gaps 1 / 3 / 7). */
export const morseUnits = (text) => {
    const words = String(text).toLowerCase().split(/\s+/).map((w) => [...w].filter((c) => MORSE[c])).filter((w) => w.length);
    if (!words.length) throw new UserError('Morse works with English letters and numbers (A–Z, 0–9).');
    const units = [];
    words.forEach((word, wi) => {
        if (wi) units.push(0, 0, 0, 0, 0, 0, 0);
        word.forEach((c, ci) => {
            if (ci) units.push(0, 0, 0);
            [...MORSE[c]].forEach((sym, si) => {
                if (si) units.push(0);
                units.push(...(sym === '.' ? [1] : [1, 1, 1]));
            });
        });
    });
    if (units.length > BARS * 2) throw new UserError('Too long for Morse art: keep it to about 6 letters.');
    return units;
};

/** 64 bars drawing the Morse units (dots short, dashes long, gaps flat). */
export const drawUnits = (units) =>
    Buffer.from(Array.from({ length: BARS }, (_, i) => (units[Math.floor((i * units.length) / BARS)] ? 100 : 3)));

/** Mono 16-bit PCM: a soft tone whose volume follows `envelope` (0–100 values). */
export const synth = (envelope, seconds, { freq = 523.25, smooth = true } = {}) => {
    const n = Math.round(seconds * RATE);
    const pcm = Buffer.alloc(n * 2);
    let level = 0;
    for (let s = 0; s < n; s++) {
        const pos = (s / n) * envelope.length;
        const target = (envelope[Math.min(envelope.length - 1, Math.floor(pos))] || 0) / 100;
        level += (target - level) * (smooth ? 0.0015 : 0.02);
        const fade = Math.min(1, s / 2400, (n - s) / 2400);
        const tone = Math.sin((2 * Math.PI * freq * s) / RATE) * 0.7 + Math.sin((4 * Math.PI * freq * s) / RATE) * 0.15;
        pcm.writeInt16LE(Math.round(tone * level * fade * 26000), s * 2);
    }
    return pcm;
};

/** PCM → voice-note Opus ogg. */
export const pcmToOgg = (pcm) =>
    convert(pcm, { inExt: 'pcm', outExt: 'ogg', args: (i, o) => ['-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', i, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-ar', '48000', '-f', 'ogg', o] });

/** Text preview of the bars for the chat (8 levels). */
export const preview = (bars) => [...bars].filter((_, i) => i % 2 === 0).map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(v / 12.6))]).join('');
