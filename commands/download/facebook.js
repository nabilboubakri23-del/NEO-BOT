import { extractMedia, deliverExtracted } from './.extractor.js';
import { requireVerifiedExtractor } from './.verification.js';
import { box } from '../../utils/formatter.js';
import { assertUrl } from './.lib.js';

/**
 * Facebook public-video downloads through the pinned local extractor:
 *   .facebook <link>   public video / reel
 * Only public videos can be downloaded.
 */

const FB_HOSTS = ['facebook.com', 'fb.watch', 'fb.com'];

export default {
    name: 'facebook',
    aliases: ['fb', 'fbdl', 'فيسبوك', 'فيس'],
    category: 'download',
    description: 'Download a public Facebook video or reel.',
    usage: '<facebook link>',
    examples: ['facebook https://www.facebook.com/reel/1234567890'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        await requireVerifiedExtractor('facebook');
        const url = assertUrl(args[0], FB_HOSTS, 'Facebook link');
        await message.react?.('⏳');
        const result = await extractMedia(url, 'facebook');
        await deliverExtracted(sock, message, result, 'facebook', box('FACEBOOK', ['✅ Done.']));
    }
};
