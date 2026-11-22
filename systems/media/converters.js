import { UserError } from '../../utils/errors.js';
import { convert, hasFfmpeg } from './ffmpeg.js';
import { isAnimatedWebp } from './webpExif.js';

/**
 * Media conversions used by .toimage / .tomp3 / .togif.
 * Each returns the WhatsApp message content to send. Where no conversion is
 * strictly required, the original file is reused so the command still works without ffmpeg.
 */

const AUDIO_EXT = { audio: 'ogg', video: 'mp4' };

/** Static sticker → PNG image. */
export const stickerToImage = async (webp) => {
    if (isAnimatedWebp(webp)) throw new UserError('Animated stickers cannot be turned into an image.');
    if (!(await hasFfmpeg())) return { image: webp, mimetype: 'image/webp' }; // WhatsApp may still show it
    const png = await convert(webp, { inExt: 'webp', outExt: 'png', args: (i, o) => ['-i', i, '-frames:v', '1', o] });
    return { image: png, mimetype: 'image/png' };
};

/** Video or voice note → MP3 audio. */
export const toMp3 = async (buffer, media) => {
    if (!(await hasFfmpeg())) {
        if (media.kind === 'audio') return { audio: buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: false };
        throw new UserError('Extracting audio from a video needs ffmpeg on the server.');
    }
    const mp3 = await convert(buffer, {
        inExt: AUDIO_EXT[media.kind] || 'bin',
        outExt: 'mp3',
        args: (i, o) => ['-i', i, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', o]
    });
    return { audio: mp3, mimetype: 'audio/mpeg', ptt: false };
};

/** Video → looping, muted "GIF" (WhatsApp GIFs are MP4 with gifPlayback). */
export const toGif = async (buffer) => {
    if (!(await hasFfmpeg())) return { video: buffer, gifPlayback: true, mimetype: 'video/mp4' };
    // Re-encoding only trims and mutes; if this ffmpeg build lacks libx264 the original still plays as a GIF.
    const mp4 = await convert(buffer, {
        inExt: 'mp4',
        outExt: 'mp4',
        args: (i, o) => ['-i', i, '-t', '20', '-an', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', o]
    }).catch(() => buffer);
    return { video: mp4, gifPlayback: true, mimetype: 'video/mp4' };
};
