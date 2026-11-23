import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, deliverMedia, isCobaltConfigured, NOT_CONFIGURED } from './.lib.js';

/**
 * Instagram downloads through the owner-configured cobalt-compatible backend:
 *   .instagram <link>   reel / post / video (first item of a carousel)
 * Only public posts can be downloaded.
 */

const IG_HOSTS = ['instagram.com'];

export default {
    name: 'instagram',
    aliases: ['insta', 'انستا', 'انستقرام'],
    category: 'download',
    description: 'Download an Instagram reel, video or photo (public posts).',
    usage: '<instagram link>',
    examples: ['instagram https://www.instagram.com/reel/abc123/'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        if (!isCobaltConfigured()) throw new UserError(NOT_CONFIGURED);
        const url = assertUrl(args[0], IG_HOSTS, 'Instagram link');
        await message.react?.('⏳');
        const result = await cobaltDownload(url, { audio: false });
        const caption = box('INSTAGRAM', [
            '✅ Done.',
            result.kind === 'picker' && result.items.length > 1 && `Post has ${result.items.length} items; sent the first.`
        ].filter(Boolean));
        await deliverMedia(sock, message, result, { caption });
    }
};
