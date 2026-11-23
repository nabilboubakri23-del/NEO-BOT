import { extractMedia, deliverExtracted } from './.extractor.js';
import { requireVerifiedExtractor } from './.verification.js';
import { box } from '../../utils/formatter.js';
import { assertUrl } from './.lib.js';

/**
 * Instagram public-video downloads through the pinned local extractor:
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
        await requireVerifiedExtractor('instagram');
        const url = assertUrl(args[0], IG_HOSTS, 'Instagram link');
        await message.react?.('⏳');
        const result = await extractMedia(url, 'instagram');
        await deliverExtracted(sock, message, result, 'instagram', box('INSTAGRAM', ['✅ Done.']));
    }
};
