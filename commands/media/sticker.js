import { makeSticker, parseMetaArgs } from '../../systems/media/sticker.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { UsageError } from '../../utils/errors.js';
import { start as soundSticker } from '../sticker/soundsticker.js';
import { clipOf, sendSoundSticker, soundOf } from '../../systems/media/soundSticker.js';
import { child } from '../../core/logger.js';

/**
 * Stickers.
 *   .sticker [pack | author]   image, GIF or short video (sent with the command or replied to) → sticker
 *   .sticker song <name>       sticker that plays music (same as .soundsticker <name>)
 *   .sticker sound             sound sticker from a replied voice note / audio
 *   .take <pack> | [author]    re-label an existing sticker with your own pack / author
 * Images and videos need ffmpeg on the server; re-labelling a sticker does not.
 * A sound sticker keeps its sound through both commands (re-sent as a sound sticker).
 */

const log = child('sticker');

/** Sends the new sticker; when the source was a sound sticker, its sound goes with it. */
const deliver = async (sock, message, media, webp) => {
    const sound = soundOf(media);
    if (sound) {
        try {
            const clip = await clipOf(sock, sound);
            await sendSoundSticker(sock, message.chat, { webp, clip, quoted: message.raw });
            return '🔊';
        } catch (error) {
            log.warn(`Sound not kept: ${error?.message}`);
            await sock.sendMessage(message.chat, { sticker: webp }, { quoted: message.raw });
            await message.reply('⚠️ The sticker was re-labelled, but its sound could not be kept (the original audio expired or failed to download). Make it again with .ss').catch(() => {});
            return '⚠️';
        }
    }
    await sock.sendMessage(message.chat, { sticker: webp }, { quoted: message.raw });
    return '✅';
};

const MAX_VIDEO_SECONDS = 15;

export const sticker = {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    category: 'media',
    description: 'Turn an image, GIF or short video into a sticker.',
    usage: '[pack | author]  |  song <name>  |  sound  (send with media or reply to it)',
    examples: ['', 'My Pack | Me', 'song Blinding Lights'],
    permission: 'public',
    cooldown: 5,
    async execute(sock, message, args, ctx) {
        const text = (ctx.argsText ?? args.join(' ')).trim();
        const music = text.match(/^(?:song|music|sound|🎵|اغنية|أغنية|صوت)(?:\s+([\s\S]*))?$/i);
        if (music) return soundSticker(sock, message, music[1] || '');
        if (!text && findMedia(message, ['audio']) && !findMedia(message, ['image', 'video', 'sticker'])) return soundSticker(sock, message, '');
        const media = findMedia(message, ['image', 'video', 'sticker']);
        if (!media) throw new UsageError('Send an image or a short video with the command, or reply to one. For a sticker with music: .sticker song <name>');
        if (media.kind === 'video' && media.seconds > MAX_VIDEO_SECONDS) throw new UsageError(`Videos up to ${MAX_VIDEO_SECONDS} seconds.`);
        await message.react?.('⏳').catch(() => {});
        const buffer = await downloadMedia(sock, media);
        const webp = await makeSticker(buffer, media, parseMetaArgs(ctx.argsText ?? args.join(' ')));
        const done = await deliver(sock, message, media, webp);
        await message.react?.(done).catch(() => {});
    }
};

export const take = {
    name: 'take',
    aliases: ['wm', 'steal'],
    category: 'media',
    description: 'Re-label a sticker (plain or sound sticker) with your own pack name and author.',
    usage: '<pack> | [author]  (reply to a sticker)',
    examples: ['My Pack | Me'],
    permission: 'public',
    minArgs: 1,
    cooldown: 5,
    async execute(sock, message, args, ctx) {
        const media = findMedia(message, ['sticker']);
        if (!media) throw new UsageError('Reply to a sticker.');
        const buffer = await downloadMedia(sock, media);
        if (soundOf(media)) await message.react?.('⏳').catch(() => {});
        const webp = await makeSticker(buffer, media, parseMetaArgs(ctx.argsText ?? args.join(' ')));
        const done = await deliver(sock, message, media, webp);
        if (done !== '✅') await message.react?.(done).catch(() => {});
    }
};

export default [sticker, take];
