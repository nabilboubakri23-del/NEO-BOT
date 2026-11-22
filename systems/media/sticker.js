import config from '../../config/config.js';
import { UserError } from '../../utils/errors.js';
import { convert } from './ffmpeg.js';
import { isWebp, setStickerMetadata } from './webpExif.js';

/**
 * Builds WhatsApp stickers (512×512 WebP, transparent padding) with pack / author metadata.
 *   image / static sticker → static WebP
 *   video / GIF            → animated WebP (first seconds, re-encoded smaller until it fits)
 * An existing WebP sticker only gets its metadata rewritten (no ffmpeg needed).
 */

const SIZE = 512;
const MAX_VIDEO_SECONDS = 8;
const MAX_ANIMATED_BYTES = 1000 * 1024; // WhatsApp refuses larger animated stickers
const FILTER = `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;

const EXT = { image: 'jpg', video: 'mp4', sticker: 'webp', document: 'bin' };

export const defaultMeta = () => ({ pack: config.media.stickerPack, author: config.media.stickerAuthor });

const staticWebp = (buffer, ext) =>
    convert(buffer, {
        inExt: ext,
        outExt: 'webp',
        args: (i, o) => ['-i', i, '-vf', FILTER, '-frames:v', '1', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '80', '-an', o]
    });

const animatedWebp = (buffer, ext, { fps, quality, seconds }) =>
    convert(buffer, {
        inExt: ext,
        outExt: 'webp',
        args: (i, o) => ['-t', String(seconds), '-i', i, '-vf', `fps=${fps},${FILTER}`, '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality), '-loop', '0', '-an', o]
    });

/** Animated sticker that fits WhatsApp's size limit (tries lower quality / fps before giving up). */
const fitAnimated = async (buffer, ext) => {
    const attempts = [
        { fps: 15, quality: 60, seconds: MAX_VIDEO_SECONDS },
        { fps: 12, quality: 40, seconds: 6 },
        { fps: 10, quality: 25, seconds: 4 }
    ];
    for (const attempt of attempts) {
        const out = await animatedWebp(buffer, ext, attempt);
        if (out.length <= MAX_ANIMATED_BYTES) return out;
    }
    throw new UserError('That video is too heavy for a sticker. Try a shorter clip.');
};

/**
 * @param {Buffer} buffer
 * @param {{ kind: 'image'|'video'|'sticker'|'document', animated?: boolean }} source
 * @param {{ pack?: string, author?: string }} [meta]
 */
export const makeSticker = async (buffer, source, meta = defaultMeta()) => {
    let webp;
    if (source.kind === 'sticker' && isWebp(buffer)) webp = buffer;
    else if (source.kind === 'video' || source.animated) webp = await fitAnimated(buffer, EXT[source.kind] || 'mp4');
    else webp = await staticWebp(buffer, EXT[source.kind] || 'jpg');
    return setStickerMetadata(webp, meta);
};

/** Parses "pack | author" (either part may be empty). */
export const parseMetaArgs = (text, fallback = defaultMeta()) => {
    const raw = String(text || '').trim();
    if (!raw) return fallback;
    const [pack, author = ''] = raw.split('|').map((s) => s.trim());
    return { pack: (pack || fallback.pack).slice(0, 60), author: author.slice(0, 60) };
};
