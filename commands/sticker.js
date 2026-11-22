import { makeSticker, parseMetaArgs } from '../systems/media/sticker.js';
import { downloadMedia, findMedia } from '../utils/media.js';
import { UsageError } from '../utils/errors.js';

/**
 * Stickers.
 *   .sticker [pack | author]   image, GIF or short video (sent with the command or replied to) → sticker
 *   .take <pack> | [author]    re-label an existing sticker with your own pack / author
 * Images and videos need ffmpeg on the server; re-labelling a sticker does not.
 */

const MAX_VIDEO_SECONDS = 15;

export const sticker = {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    category: 'media',
    description: 'Turn an image, GIF or short video into a sticker.',
    usage: '[pack | author]  (send with media or reply to it)',
    examples: ['', 'My Pack | Me'],
    permission: 'public',
    cooldown: 5,
    async execute(sock, message, args, ctx) {
        const media = findMedia(message, ['image', 'video', 'sticker']);
        if (!media) throw new UsageError('Send an image or a short video with the command, or reply to one.');
        if (media.kind === 'video' && media.seconds > MAX_VIDEO_SECONDS) throw new UsageError(`Videos up to ${MAX_VIDEO_SECONDS} seconds.`);
        await message.react?.('⏳').catch(() => {});
        const buffer = await downloadMedia(sock, media);
        const webp = await makeSticker(buffer, media, parseMetaArgs(ctx.argsText ?? args.join(' ')));
        await sock.sendMessage(message.chat, { sticker: webp }, { quoted: message.raw });
        await message.react?.('✅').catch(() => {});
    }
};

export const take = {
    name: 'take',
    aliases: ['wm', 'steal'],
    category: 'media',
    description: 'Re-label a sticker with your own pack name and author.',
    usage: '<pack> | [author]  (reply to a sticker)',
    examples: ['My Pack | Me'],
    permission: 'public',
    minArgs: 1,
    cooldown: 5,
    async execute(sock, message, args, ctx) {
        const media = findMedia(message, ['sticker']);
        if (!media) throw new UsageError('Reply to a sticker.');
        const buffer = await downloadMedia(sock, media);
        const webp = await makeSticker(buffer, media, parseMetaArgs(ctx.argsText ?? args.join(' ')));
        await sock.sendMessage(message.chat, { sticker: webp }, { quoted: message.raw });
    }
};

export default [sticker, take];
