import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, isCobaltConfigured, sendFile, tiktokDownload } from './.lib.js';

/**
 * TikTok downloads, no watermark when available:
 *   .tiktok <link>   video without watermark (+ audio when the video has none)
 * Primary provider: ssstik.io (no key needed). Falls back to the
 * cobalt-compatible backend when it is configured.
 */

const TT_HOSTS = ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'];

export default {
    name: 'tiktok',
    aliases: ['tt', 'tik', 'تيكتوك', 'تيك'],
    category: 'download',
    description: 'Download a TikTok video without watermark.',
    usage: '<tiktok link>',
    examples: ['tiktok https://www.tiktok.com/@user/video/1234567890'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const url = assertUrl(args[0], TT_HOSTS, 'TikTok link');
        await message.react?.('⏳');

        try {
            const result = await tiktokDownload(url);
            const caption = box('TIKTOK', [result.author && `👤 ${result.author}`, '✅ Without watermark.'].filter(Boolean));
            if (result.videoUrl) {
                await sendFile(sock, message, { kind: 'video', url: result.videoUrl, caption });
                return;
            }
            if (result.audioUrl) {
                await sendFile(sock, message, { kind: 'audio', url: result.audioUrl, fileName: 'tiktok.mp3' });
                return;
            }
        } catch (error) {
            // Fall back to the cobalt backend when the free provider misses.
            if (!isCobaltConfigured()) throw error?.expose ? error : new UserError('⚠️ Could not download that TikTok. Check the link and that the video is public.');
        }

        const result = await cobaltDownload(url, { audio: false });
        if (result.kind === 'picker') {
            const first = result.items[0];
            await sendFile(sock, message, { kind: first.type === 'video' ? 'video' : 'image', url: first.url, caption: box('TIKTOK', ['✅ Done.']) });
            return;
        }
        await sendFile(sock, message, { kind: 'video', url: result.url, caption: box('TIKTOK', ['✅ Done.']) });
    }
};
