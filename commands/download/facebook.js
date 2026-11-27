import { UsageError } from '../../utils/errors.js';
import { assertUrl } from './.lib.js';
import { downloadPost, parseArgs } from './.social.js';

/**
 * Facebook public videos through the local extractor:
 *   .fb <link>        video / reel / watch / share link
 *   .fb mp3 <link>    audio as MP3
 */

export const FB_HOSTS = ['facebook.com', 'fb.watch', 'fb.com'];

export default {
    name: 'facebook',
    aliases: ['fb', 'fbdl', 'فيسبوك', 'فيس'],
    category: 'download',
    description: 'Download a public Facebook video or reel (share links too), or its audio.',
    usage: '[mp3] <facebook link>',
    examples: ['facebook https://www.facebook.com/reel/1234567890', 'fb mp3 https://fb.watch/abc/'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const { audio, link } = parseArgs(args);
        if (!link) throw new UsageError();
        const url = assertUrl(link, FB_HOSTS, 'Facebook link');
        await downloadPost(sock, message, url, 'facebook', { audio });
    }
};
