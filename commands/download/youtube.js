import { extractMedia, deliverExtracted } from './.extractor.js';
import { requireVerifiedExtractor } from './.verification.js';
import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, deliverMedia, isCobaltConfigured, youtubeSearch } from './.lib.js';

/**
 * YouTube through the local yt-dlp extractor (no external API):
 *   .yt <link>        video, H.264 up to 720p (video + audio tracks muxed with ffmpeg)
 *   .ytmp3 <link>     audio (m4a)
 *   .play <name>      search YouTube, send the first result's audio
 * The cobalt backend is only a fallback for audio when DOWNLOAD_API_BASE is set.
 */

export const YT_HOSTS = ['youtube.com', 'youtu.be', 'music.youtube.com'];

/** Download one YouTube URL as video or audio and send it. */
export const downloadYoutube = async (sock, message, url, { audio = false } = {}) => {
    await message.react?.('⏳');
    try {
        await requireVerifiedExtractor('youtube');
        const result = await extractMedia(url, 'youtube', { audio });
        const caption = box('YOUTUBE', [result.title && `🎬 ${result.title}`, '✅ Done.'].filter(Boolean));
        await deliverExtracted(sock, message, result, 'youtube', caption);
        await message.react?.('✅');
    } catch (error) {
        if (!audio || !isCobaltConfigured()) { await message.react?.('❌'); throw error; }
        const result = await cobaltDownload(url, { audio: true });
        await deliverMedia(sock, message, result, { audio: true });
        await message.react?.('✅');
    }
};

export const yt = {
    name: 'yt',
    aliases: ['youtube', 'ytdl', 'ytmp4', 'ytv', 'يوتيوب'],
    category: 'download',
    description: 'Download a public YouTube video (up to 720p).',
    usage: '<youtube link>',
    examples: ['yt https://youtu.be/dQw4w9WgXcQ'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const url = assertUrl(args[0], YT_HOSTS, 'YouTube link');
        await downloadYoutube(sock, message, url);
    }
};

export const ytmp3 = {
    name: 'ytmp3',
    aliases: ['ytaudio', 'yta', 'يوت_اغنية', 'يوت_اغنيه'],
    category: 'download',
    description: 'Download the audio of a YouTube video.',
    usage: '<youtube link>',
    examples: ['ytmp3 https://youtu.be/dQw4w9WgXcQ'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const url = assertUrl(args[0], YT_HOSTS, 'YouTube link');
        await downloadYoutube(sock, message, url, { audio: true });
    }
};

export const play = {
    name: 'play',
    aliases: ['شغل', 'تشغيل', 'شغل_اغنية'],
    category: 'download',
    description: 'Search YouTube by name and send the audio of the first result.',
    usage: '<song or video name>',
    examples: ['play cheb bilal'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args, ctx) {
        const query = [ctx.argsText, ctx.body].filter(Boolean).join('\n').trim().slice(0, 200);
        if (!query) throw new UsageError();
        await message.react?.('🔎');
        const ids = await youtubeSearch(query);
        if (!ids.length) throw new UserError('⚠️ No YouTube result matched that search.');
        await downloadYoutube(sock, message, `https://www.youtube.com/watch?v=${ids[0]}`, { audio: true });
    }
};

export default [yt, ytmp3, play];
