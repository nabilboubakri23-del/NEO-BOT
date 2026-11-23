import { box, fields } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, deliverMedia, isCobaltConfigured, NOT_CONFIGURED, parseSpotifyTrack, sanitizeFilename, spotifyInfo, youtubeSearch } from './.lib.js';

/**
 * Spotify tracks:
 *   .spotify <track link>   audio as MP3
 * Spotify itself does not offer free downloads, so the bot reads the official
 * track info (oEmbed), finds the matching audio on YouTube and downloads it
 * through the cobalt-compatible backend. Without the backend it still answers
 * with the track info instead of pretending.
 */

const SPOTIFY_HOSTS = ['open.spotify.com'];

export default {
    name: 'spotify',
    aliases: ['سبوتيفاي'],
    category: 'download',
    description: 'Get a Spotify track as MP3 (matched audio; not a Spotify rip).',
    usage: '<spotify track link>',
    examples: ['spotify https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const url = assertUrl(args[0], SPOTIFY_HOSTS, 'Spotify link');
        const trackId = parseSpotifyTrack(url);
        if (!trackId) throw new UserError('⚠️ That link is not a Spotify track. Send a track link, not an album or playlist.');

        await message.react?.('⏳');
        const info = await spotifyInfo(url);
        const title = info.title || 'Unknown track';

        if (!isCobaltConfigured()) {
            return message.reply(box('SPOTIFY', [...fields({ '🎵 Track': title }), '', NOT_CONFIGURED]));
        }

        const ids = await youtubeSearch(`${title} audio`);
        if (!ids.length) throw new UserError('⚠️ Could not find matching audio for that track.');
        const result = await cobaltDownload(`https://www.youtube.com/watch?v=${ids[0]}`, { audio: true });
        result.fileName = sanitizeFilename(title);
        await deliverMedia(sock, message, result, { audio: true });
    }
};
