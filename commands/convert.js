import { stickerToImage, toGif, toMp3 } from '../systems/media/converters.js';
import { downloadMedia, findMedia } from '../utils/media.js';
import { UsageError } from '../utils/errors.js';

/**
 * Media conversions (send with the media or reply to it):
 *   .toimage   static sticker → image
 *   .tomp3     video / voice note → MP3
 *   .togif     video → GIF (looping, muted)
 * Animated sticker → video is not supported (ffmpeg cannot decode animated WebP).
 */

const make = ({ name, aliases, description, kinds, need, run }) => ({
    name,
    aliases,
    category: 'media',
    description,
    usage: '(send with the media or reply to it)',
    permission: 'public',
    cooldown: 5,
    async execute(sock, message) {
        const media = findMedia(message, kinds);
        if (!media) throw new UsageError(`Reply to ${need}.`);
        const buffer = await downloadMedia(sock, media);
        await sock.sendMessage(message.chat, await run(buffer, media), { quoted: message.raw });
    }
});

export const toimage = make({
    name: 'toimage',
    aliases: ['toimg', 'topng'],
    description: 'Turn a sticker into an image.',
    kinds: ['sticker'],
    need: 'a sticker',
    run: (buffer) => stickerToImage(buffer)
});

export const tomp3 = make({
    name: 'tomp3',
    aliases: ['toaudio', 'mp3'],
    description: 'Extract the audio of a video or voice note as MP3.',
    kinds: ['video', 'audio'],
    need: 'a video or a voice note',
    run: (buffer, media) => toMp3(buffer, media)
});

export const togif = make({
    name: 'togif',
    aliases: ['gif'],
    description: 'Turn a short video into a GIF.',
    kinds: ['video'],
    need: 'a video',
    run: (buffer) => toGif(buffer)
});

export default [toimage, tomp3, togif];
