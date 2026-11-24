import { convert } from './ffmpeg.js';
import { isAnimatedWebp } from './webpExif.js';

/**
 * Removes a sticker's flat background (no AI model, so it runs on Render free / Termux):
 *   1. decode to 512×512 RGBA with ffmpeg,
 *   2. find the dominant colour on the border,
 *   3. flood-fill from the border through pixels close to that colour → transparent,
 *   4. soften the cut edge, encode back to WebP.
 * Works on solid / near-solid backgrounds (most stickers, screenshots, logos).
 * Busy photo backgrounds are left as they are (`changed: false`). Animated stickers are skipped
 * because ffmpeg cannot decode animated WebP.
 */

const SIZE = 512;
const TOLERANCE = 42; // colour distance (0–441) still counted as background
const SOFT = TOLERANCE * 1.8;
const FILTER = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

const dist = (px, i, c) => Math.hypot(px[i] - c[0], px[i + 1] - c[1], px[i + 2] - c[2]);

/** Most common (quantized) opaque colour on the image border, or null. */
export const borderColour = (px, size = SIZE) => {
    const counts = new Map();
    let opaque = 0;
    const visit = (x, y) => {
        const i = (y * size + x) * 4;
        if (px[i + 3] < 200) return;
        opaque++;
        const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
        const entry = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        entry.n++; entry.r += px[i]; entry.g += px[i + 1]; entry.b += px[i + 2];
        counts.set(key, entry);
    };
    for (let k = 0; k < size; k++) { visit(k, 0); visit(k, size - 1); visit(0, k); visit(size - 1, k); }
    if (!opaque) return null;
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    if (best.n < opaque * 0.35) return null; // no dominant colour: busy background
    return [best.r / best.n, best.g / best.n, best.b / best.n];
};

/**
 * Clears the background in place. @returns {{ removed: number, opaque: number }}
 */
export const clearBackground = (px, size = SIZE, colour = borderColour(px, size)) => {
    if (!colour) return { removed: 0, opaque: 0 };
    const total = size * size;
    const seen = new Uint8Array(total);
    const stack = [];
    const push = (p) => { if (!seen[p]) { seen[p] = 1; stack.push(p); } };
    for (let k = 0; k < size; k++) { push(k); push((size - 1) * size + k); push(k * size); push(k * size + size - 1); }
    let removed = 0;
    while (stack.length) {
        const p = stack.pop();
        const i = p * 4;
        const transparent = px[i + 3] < 16;
        if (!transparent && dist(px, i, colour) > TOLERANCE) continue;
        if (!transparent) { px[i + 3] = 0; removed++; }
        const x = p % size;
        if (x > 0) push(p - 1);
        if (x < size - 1) push(p + 1);
        if (p >= size) push(p - size);
        if (p < total - size) push(p + size);
    }
    // Soften: kept pixels touching the cut fade by how close they are to the background colour.
    for (let p = 0; p < total; p++) {
        const i = p * 4;
        if (px[i + 3] === 0) continue;
        const x = p % size;
        const near = (x > 0 && px[i - 1] === 0) || (x < size - 1 && px[i + 7] === 0) || (p >= size && px[i - size * 4 + 3] === 0) || (p < total - size && px[i + size * 4 + 3] === 0);
        if (!near) continue;
        const d = dist(px, i, colour);
        if (d < SOFT) px[i + 3] = Math.round(px[i + 3] * Math.max(0.25, (d - TOLERANCE) / (SOFT - TOLERANCE)));
    }
    let opaque = 0;
    for (let p = 3; p < px.length; p += 4) if (px[p] > 0) opaque++;
    return { removed, opaque };
};

/**
 * @param {Buffer} webp sticker
 * @returns {Promise<{ webp: Buffer, changed: boolean, reason?: string }>}
 */
export const removeBackground = async (webp) => {
    if (isAnimatedWebp(webp)) return { webp, changed: false, reason: 'animated' };
    const raw = await convert(webp, { inExt: 'webp', outExt: 'rgba', args: (i, o) => ['-i', i, '-vf', FILTER, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', o] });
    if (raw.length !== SIZE * SIZE * 4) return { webp, changed: false, reason: 'decode' };
    const { removed, opaque } = clearBackground(raw);
    if (removed < SIZE * SIZE * 0.02) return { webp, changed: false, reason: 'no-background' };
    if (opaque < SIZE * SIZE * 0.03) return { webp, changed: false, reason: 'nothing-left' };
    const out = await convert(raw, {
        inExt: 'rgba',
        outExt: 'webp',
        args: (i, o) => ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${SIZE}x${SIZE}`, '-i', i, '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '85', '-an', o]
    });
    return { webp: out, changed: true };
};
