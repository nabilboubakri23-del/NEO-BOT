import { downloadMediaMessage, getContentType, normalizeMessageContent } from 'baileys';
import { child } from '../core/logger.js';
import { UserError } from './errors.js';

/**
 * Media helpers: find the media a command should work on (the command message
 * itself, e.g. an image with ".sticker" as caption, or the message it replies to)
 * and download it as a Buffer.
 */

const log = child('media');

const KINDS = Object.freeze({
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    stickerMessage: 'sticker',
    documentMessage: 'document'
});

/** Largest file the bot downloads (protects small hosts such as Render free, 512 MB). */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const describe = (key, rawContent) => {
    const content = normalizeMessageContent(rawContent);
    const type = content && getContentType(content);
    const kind = KINDS[type];
    if (!kind) return null;
    const info = content[type] || {};
    return {
        kind,
        key,
        message: content,
        mimetype: info.mimetype || '',
        size: Number(info.fileLength || 0),
        seconds: Number(info.seconds || 0),
        animated: Boolean(info.isAnimated),
        ptt: Boolean(info.ptt)
    };
};

/**
 * The media to work on: the message itself first, then the replied message.
 * @param {object} message  serialized NEO message
 * @param {string[]} [kinds] accepted kinds (image, video, audio, sticker, document)
 * @returns {{ kind, key, message, mimetype, size, seconds, animated, ptt } | null}
 */
export const findMedia = (message, kinds = Object.values(KINDS)) => {
    const candidates = [
        describe(message.raw?.key, message.raw?.message),
        message.quoted ? describe(message.quoted.key, message.quoted.message) : null
    ];
    return candidates.find((m) => m && kinds.includes(m.kind)) || null;
};

/** Downloads a found media as a Buffer (refuses files above MAX_MEDIA_BYTES). */
export const downloadMedia = async (sock, media, { maxBytes = MAX_MEDIA_BYTES } = {}) => {
    if (media.size && media.size > maxBytes) throw new UserError(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    try {
        const buffer = await downloadMediaMessage({ key: media.key, message: media.message }, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
        if (buffer.length > maxBytes) throw new UserError(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
        return buffer;
    } catch (error) {
        if (error?.expose) throw error;
        log.warn(`Media download failed: ${error?.message}`);
        throw new UserError('Could not download that media. Ask for it to be sent again.');
    }
};
