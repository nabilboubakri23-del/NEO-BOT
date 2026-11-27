import { extractMedia, deliverExtracted } from './.extractor.js';
import { requireVerifiedExtractor } from './.verification.js';
import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, deliverMedia, fetchJson, isCobaltConfigured, sendFile, youtubeSearch } from './.lib.js';
import { acquireAudio, searchTracks, SOURCES } from './.spotify-core.js';

/**
 * YouTube through the local yt-dlp extractor (no external API):
 *   .yt <link>        video, H.264 up to 720p (video + audio tracks muxed with ffmpeg)
 *   .ytmp3 <link>     audio (m4a)
 *   .play <name>      search YouTube, send the first result's audio
 * When YouTube refuses the server (bot check), audio falls back to the same song
 * found on Spotify (spotimate converter), then to cobalt when DOWNLOAD_API_BASE is set.
 */

export const YT_HOSTS = ['youtube.com', 'youtu.be', 'music.youtube.com'];

/** Video title from YouTube's public oEmbed (no key), or ''. */
export const youtubeTitle = async (url) => {
    try {
        const data = await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { allowHosts: ['youtube.com'] });
        return String(data?.title || '').trim().slice(0, 150);
    } catch { return ''; }
};

/** Same song through Spotify search + converter (no YouTube involved). */
export const audioViaSpotify = async (query) => {
    const cleaned = String(query || '').replace(/\((official|lyrics?|audio|video|clip|hd|4k)[^)]*\)|\[[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) throw new UserError('nothing to search');
    const tracks = await searchTracks(cleaned);
    if (!tracks.length) throw new UserError('no spotify match');
    const noYoutube = { ...SOURCES, youtube: async () => { throw new Error('skipped'); } };
    return { track: tracks[0], audio: await acquireAudio(tracks[0], { sources: noYoutube }) };
};

/** Download one YouTube URL as video or audio and send it. `query` helps the audio fallback. */
export const downloadYoutube = async (sock, message, url, { audio = false, query = '' } = {}) => {
    await message.react?.('⏳');
    try {
        await requireVerifiedExtractor('youtube');
        const result = await extractMedia(url, 'youtube', { audio });
        const caption = box('YOUTUBE', [result.title && `🎬 ${result.title}`, '✅ Done.'].filter(Boolean));
        await deliverExtracted(sock, message, result, 'youtube', caption);
        await message.react?.('✅');
        return;
    } catch (error) {
        if (!audio) { await message.react?.('❌'); throw error; }
        try {
            const { audio: song } = await audioViaSpotify(query || await youtubeTitle(url));
            await sendFile(sock, message, { kind: 'audio', buffer: song.buffer, mimetype: song.mimetype, fileName: song.fileName });
            await message.react?.('✅');
            return;
        } catch { /* next fallback */ }
        if (!isCobaltConfigured()) { await message.react?.('❌'); throw error; }
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
        await downloadYoutube(sock, message, `https://www.youtube.com/watch?v=${ids[0]}`, { audio: true, query });
    }
};

export default [yt, ytmp3, play];
