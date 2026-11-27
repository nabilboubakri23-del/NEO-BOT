import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { isPinterestHost } from './.pinterest-api.js';
import { downloadYoutube, YT_HOSTS } from './youtube.js';
import instagram from './instagram.js';
import facebook from './facebook.js';
import tiktok from './tiktok.js';
import mediafire from './mediafire.js';
import pinterest from './pinterest.js';
import spotify from './spotify.js';

/**
 * One command for any supported link: detects the platform and runs its downloader.
 *   .dl <link>        video (or the platform's default)
 *   .dl mp3 <link>    audio only (YouTube)
 */

const matches = (host, list) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Link host → platform id, or null when unsupported. */
export const detectPlatform = (link) => {
    let host;
    try { host = new URL(link).hostname.toLowerCase(); } catch { return null; }
    if (matches(host, YT_HOSTS)) return 'youtube';
    if (matches(host, ['instagram.com'])) return 'instagram';
    if (matches(host, ['facebook.com', 'fb.watch', 'fb.com'])) return 'facebook';
    if (matches(host, ['tiktok.com'])) return 'tiktok';
    if (matches(host, ['mediafire.com'])) return 'mediafire';
    if (host === 'pin.it' || isPinterestHost(host)) return 'pinterest';
    if (matches(host, ['spotify.com', 'spotify.link'])) return 'spotify';
    return null;
};

const HANDLERS = { instagram, facebook, tiktok, mediafire, pinterest, spotify };
export const SUPPORTED = ['YouTube', 'Instagram', 'Facebook', 'TikTok', 'MediaFire', 'Pinterest', 'Spotify'];

export default {
    name: 'dl',
    aliases: ['download', 'تحميل', 'حمل', 'نزل'],
    category: 'download',
    description: 'Download from any supported link (detects the platform).',
    usage: '[mp3] <link>',
    examples: ['dl https://youtu.be/dQw4w9WgXcQ', 'dl mp3 https://youtu.be/dQw4w9WgXcQ', 'dl https://www.instagram.com/reel/abc123/'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args, ctx = {}) {
        const words = [...args];
        const audio = /^(mp3|audio|صوت)$/i.test(words[0] || '');
        if (audio) words.shift();
        const link = (words.find((w) => /^https?:\/\//i.test(w)) || '').trim();
        if (!link) throw new UsageError();
        const platform = detectPlatform(link);
        if (!platform) throw new UserError(box('DOWNLOAD', ['⚠️ Unsupported link.', `Supported: ${SUPPORTED.join(', ')}`]));
        if (platform === 'youtube') return downloadYoutube(sock, message, link, { audio });
        return HANDLERS[platform].execute(sock, message, [link], { ...ctx, argsText: link });
    }
};
