import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, isCobaltConfigured, NOT_CONFIGURED, sendFile, youtubeSearch } from './.lib.js';

/**
 * YouTube downloads through the owner-configured cobalt-compatible backend:
 *   .yt <link>    video (720p)
 *   .ytmp3 <link> audio (mp3)
 *   .play <song or video name>  search YouTube, download the first result's audio
 */

const YT_HOSTS = ['youtube.com', 'youtu.be', 'music.youtube.com'];

const download = async (sock, message, url, audio) => {
    await message.react?.('⏳');
    const result = await cobaltDownload(url, { audio, quality: '720' });
    if (result.kind === 'picker') {
        // YouTube rarely returns a picker; take the first item defensively.
        const first = result.items[0];
        return sendFile(sock, message, { kind: first.type === 'video' ? 'video' : 'image', url: first.url, caption: box('YOUTUBE', ['✅ Done.']) });
    }
    await sendFile(sock, message, audio
        ? { kind: 'audio', url: result.url, fileName: `${result.fileName || 'youtube-audio'}.mp3` }
        : { kind: 'video', url: result.url, caption: box('YOUTUBE', ['✅ Done.']) });
};

const guardConfigured = () => {
    if (!isCobaltConfigured()) throw new UserError(NOT_CONFIGURED);
};

export const yt = {
    name: 'yt',
    aliases: ['youtube', 'ytdl', 'ytmp4', 'يوتيوب'],
    category: 'download',
    description: 'Download a YouTube video (720p).',
    usage: '<youtube link>',
    examples: ['yt https://youtu.be/dQw4w9WgXcQ'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        guardConfigured();
        const url = assertUrl(args[0], YT_HOSTS, 'YouTube link');
        await download(sock, message, url, false);
    }
};

export const ytmp3 = {
    name: 'ytmp3',
    aliases: ['ytaudio', 'يوت_اغنية', 'يوت_اغنيه'],
    category: 'download',
    description: 'Download the audio of a YouTube video as MP3.',
    usage: '<youtube link>',
    examples: ['ytmp3 https://youtu.be/dQw4w9WgXcQ'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        guardConfigured();
        const url = assertUrl(args[0], YT_HOSTS, 'YouTube link');
        await download(sock, message, url, true);
    }
};

export const play = {
    name: 'play',
    aliases: ['شغل', 'تشغيل', 'شغل_اغنية'],
    category: 'download',
    description: 'Search YouTube by name and download the audio of the first result.',
    usage: '<song or video name>',
    examples: ['play cheb bilal'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args, ctx) {
        guardConfigured();
        const query = [ctx.argsText, ctx.body].filter(Boolean).join('\n').trim().slice(0, 200);
        if (!query) throw new UsageError();
        await message.react?.('🔎');
        const ids = await youtubeSearch(query);
        if (!ids.length) throw new UserError('⚠️ No YouTube result matched that search.');
        await download(sock, message, `https://www.youtube.com/watch?v=${ids[0]}`, true);
    }
};

export default [yt, ytmp3, play];
