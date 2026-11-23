import { box, fields } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, cobaltDownload, deliverMedia, downloadFile, isCobaltConfigured, MAX_MEDIA_BYTES, NOT_CONFIGURED, parseSpotifyTrack, sanitizeFilename, sendFile, spotifyDownload, spotifyInfo, youtubeSearch } from './.lib.js';

/**
 * Spotify tracks:
 *   .spotify <track link>   audio as MP3
 * Primary path: spotimate.app, a free third-party converter (no key), then the
 * bot downloads the MP3 itself with the usual size and type checks. Fallback:
 * the cobalt-compatible backend with audio matched from YouTube. Without any
 * working path it answers with the track info instead of pretending.
 * Neither path is an official Spotify download.
 */

const SPOTIFY_HOSTS = ['open.spotify.com'];

export default {
    name: 'spotify',
    aliases: ['سبوتيفاي'],
    category: 'download',
    description: 'Get a Spotify track as MP3 (third-party converter; not an official Spotify download).',
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

        try {
            const track = await spotifyDownload(url);
            const file = await downloadFile(track.url, { allowHosts: ['spotimate.app'], maxBytes: MAX_MEDIA_BYTES, expect: ['audio'] });
            await sendFile(sock, message, {
                kind: 'audio',
                buffer: file.buffer,
                mimetype: 'audio/mpeg',
                fileName: `${sanitizeFilename(track.title || 'spotify')}.mp3`
            });
            return;
        } catch (error) {
            if (!isCobaltConfigured()) throw error?.expose ? error : new UserError('⚠️ Could not download that Spotify track right now. Try again later.');
        }

        const info = await spotifyInfo(url);
        const title = info.title || 'Unknown track';
        const ids = await youtubeSearch(`${title} audio`);
        if (!ids.length) throw new UserError('⚠️ Could not find matching audio for that track.');
        const result = await cobaltDownload(`https://www.youtube.com/watch?v=${ids[0]}`, { audio: true });
        result.fileName = sanitizeFilename(title);
        await deliverMedia(sock, message, result, { audio: true });
    }
};
