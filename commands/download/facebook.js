import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, deliverMedia, isCobaltConfigured, NOT_CONFIGURED } from './.lib.js';

/**
 * Facebook downloads through the owner-configured cobalt-compatible backend:
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
        if (!isCobaltConfigured()) throw new UserError(NOT_CONFIGURED);
        const url = assertUrl(args[0], FB_HOSTS, 'Facebook link');
        await message.react?.('⏳');
        const result = await cobaltDownload(url, { audio: false });
        await deliverMedia(sock, message, result, { caption: box('FACEBOOK', ['✅ Done.']) });
    }
};
