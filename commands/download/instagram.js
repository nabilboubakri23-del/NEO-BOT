import { UsageError } from '../../utils/errors.js';
import { assertUrl } from './.lib.js';
import { downloadPost, parseArgs } from './.social.js';

/**
 * Instagram public posts through the local extractor:
 *   .ig <link>        reel / video / photo / carousel (up to 10 items)
 *   .ig mp3 <link>    audio of a reel as MP3
 */

export const IG_HOSTS = ['instagram.com', 'instagr.am'];

export default {
    name: 'instagram',
    aliases: ['insta', 'ig', 'igdl', 'انستا', 'انستقرام'],
    category: 'download',
    description: 'Download an Instagram reel, video, photo or carousel (public posts), or a reel\'s audio.',
    usage: '[mp3] <instagram link>',
    examples: ['instagram https://www.instagram.com/reel/abc123/', 'ig mp3 https://www.instagram.com/reel/abc123/'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const { audio, link } = parseArgs(args);
        if (!link) throw new UsageError();
        const url = assertUrl(link.replace('instagr.am/', 'www.instagram.com/'), ['instagram.com'], 'Instagram link');
        await downloadPost(sock, message, url, 'instagram', { audio });
    }
};
