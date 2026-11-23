import config from '../../config/config.js';
import events from '../../core/events.js';
import { child } from '../../core/logger.js';
import { box } from '../../utils/formatter.js';
import { UserError, describeError } from '../../utils/errors.js';
import { sendButtons, sendListMenu } from '../../systems/menus/interactiveMenu.js';
import { sendSpotifyCarousel, cardText } from './.spotify-cards.js';
import { spotifySessions as sessions } from './.spotify-session.js';
import { acquireAudio, classifyInput, searchTracks, toTrackUrl, trackInfo } from './.spotify-core.js';

/**
 * .spotify — search Spotify by song name or download a track link.
 *
 *   .spotify                 guide + buttons: Search by name / Download by link / Cancel
 *   .spotify <song name>     search, then pick a result (carousel or list)
 *   .spotify <track link>    download directly (open.spotify.com, spotify.link, spotify:track:)
 *   .spotify cancel          cancel the current menu or download
 *
 * After tapping "Search by name" or "Download by link", the user's next plain
 * message (no prefix) is taken as the input. Audio comes from a third-party
 * converter with YouTube/cobalt fallbacks; it is not an official Spotify download.
 */

const log = child('spotify');
const P = () => config.bot.prefix;
const CANCEL_WORDS = /^(cancel|stop|back|exit|إلغاء|الغاء|رجوع|خروج)$/i;
const INPUT_TAG = 'command:spotify:input';

const errorText = (error) => (error?.expose ? error.message : '⚠️ Something went wrong with Spotify. Try again.');

// ── Screens ─────────────────────────────────────────────────────────────

const home = async (sock, m) => {
    const s = sessions.create(m);
    const body = box('SPOTIFY', [
        'Download any song from Spotify as MP3.',
        '',
        '🔎 *By name*: type the song (and artist).',
        `   ${P()}spotify Shape of You Ed Sheeran`,
        '🔗 *By link*: paste a Spotify track link.',
        `   ${P()}spotify https://open.spotify.com/track/...`,
        `🎵 *Sound sticker*: reply to a song with ${P()}ss`,
        '',
        'Or tap a button below, then just type.',
        'This menu expires in 5 minutes.'
    ]);
    return sendButtons(sock, m.chat, {
        title: 'Spotify Downloader',
        body,
        footer: 'Audio via third-party converters',
        buttons: [
            { type: 'reply', text: '🔎 Search by name', id: `spotify:name:${s.token}` },
            { type: 'reply', text: '🔗 Download by link', id: `spotify:link:${s.token}` },
            { type: 'reply', text: '↩️ Back / Cancel', id: `spotify:cancel:${s.token}` }
        ]
    }, { quoted: m.raw, fallbackText: `${body}\n\n${P()}spotify <song name | link>\n${P()}spotify cancel` });
};

const askInput = async (sock, m, token, mode) => {
    sessions.expect(m, token, mode);
    const body = mode === 'name'
        ? box('SPOTIFY • BY NAME', ['Type the song name now, no command needed.', 'Adding the artist gives better results.', '', 'Example: Blinding Lights The Weeknd', 'Waiting 2 minutes.'])
        : box('SPOTIFY • BY LINK', ['Paste the Spotify track link now, no command needed.', '', 'Example: https://open.spotify.com/track/...', 'Albums and playlists are not supported.', 'Waiting 2 minutes.']);
    return sendButtons(sock, m.chat, {
        title: 'Spotify',
        body,
        buttons: [
            { type: 'reply', text: '↩️ Back', id: `spotify:home:${token}` },
            { type: 'reply', text: '✖️ Cancel', id: `spotify:cancel:${token}` }
        ]
    }, { quoted: m.raw, fallbackText: `${body}\n${P()}spotify cancel` });
};

const sendResultList = (sock, m, s) => sendListMenu(sock, m.chat, {
    title: 'Spotify results',
    body: box('SPOTIFY RESULTS', s.tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist || 'Unknown'}${t.duration ? ` (${t.duration})` : ''}`).concat(['', 'Tap *Choose a song* and pick one.', 'Results expire in 5 minutes.'])),
    footer: 'NEO BOT • Spotify',
    buttonText: 'Choose a song',
    sections: [
        {
            title: 'Results',
            rows: s.tracks.map((t, i) => ({
                id: `spotify:pick:${s.token}:${i}`,
                title: `${i + 1}. ${t.title}`.slice(0, 72),
                description: [t.artist, t.duration].filter(Boolean).join(' • ').slice(0, 72)
            }))
        },
        {
            title: 'Download as file (MP3 document)',
            rows: s.tracks.map((t, i) => ({ id: `spotify:file:${s.token}:${i}`, title: `📄 ${i + 1}. ${t.title}`.slice(0, 72), description: t.artist ? t.artist.slice(0, 72) : '' }))
        },
        { title: 'Options', rows: [{ id: `spotify:cancel:${s.token}`, title: '✖️ Cancel', description: 'Close this search' }] }
    ]
}, {
    quoted: m.raw,
    fallbackText: box('SPOTIFY', [
        ...s.tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist || 'Unknown'} ${t.duration ? `(${t.duration})` : ''}`),
        '',
        `Reply: ${P()}spotify choose ${s.token} <number>`
    ])
});

// ── Actions ─────────────────────────────────────────────────────────────

const search = (sock, m, query) => sessions.run(m, 'search', 4_000, async () => {
    await m.react?.('🔎');
    const tracks = await searchTracks(query);
    if (!tracks.length) {
        await m.react?.('❌');
        throw new UserError(`No Spotify results for "${query.slice(0, 60)}". Try the song name with the artist.`);
    }
    const s = sessions.create(m, tracks);
    // The list menu is the reliable default: WhatsApp silently drops carousels on some
    // accounts (relay succeeds, nothing shows). Carousel is opt-in via SPOTIFY_CAROUSEL=on.
    if (process.env.SPOTIFY_CAROUSEL === 'on') {
        try {
            await sendSpotifyCarousel(sock, m, s);
            await m.react?.('✅');
            return;
        } catch (error) {
            log.debug(`Carousel failed, sending list: ${describeError(error)}`);
            if (s.cancelled) return;
        }
    }
    await sendResultList(sock, m, s);
    await m.react?.('✅');
});

const deliver = async (sock, m, track, s, { asFile = false } = {}) => {
    await m.react?.('⏳');
    const status = await m.reply(`⏳ Downloading *${track.title}*${track.artist ? ` — ${track.artist}` : ''}...`).catch(() => null);
    const update = (text) => (status?.key ? sock.sendMessage(m.chat, { text, edit: status.key }).catch(() => {}) : m.reply(text).catch(() => {}));
    try {
        const audio = await acquireAudio(track, { isCancelled: () => s.cancelled });
        if (s.cancelled) throw new UserError('Spotify request cancelled.');
        const content = asFile
            ? { document: audio.buffer, mimetype: audio.mimetype, fileName: audio.fileName, caption: cardText(track) }
            : {
                audio: audio.buffer,
                mimetype: audio.mimetype,
                fileName: audio.fileName,
                contextInfo: {
                    externalAdReply: {
                        title: track.title.slice(0, 80),
                        body: [track.artist, track.album, track.duration].filter(Boolean).join(' • ').slice(0, 100),
                        mediaType: 1,
                        ...(track.cover ? { thumbnailUrl: track.cover } : {}),
                        sourceUrl: track.url,
                        renderLargerThumbnail: false
                    }
                }
            };
        await sock.sendMessage(m.chat, content, { quoted: m.raw });
        await update(`✅ *${track.title}*${track.artist ? ` — ${track.artist}` : ''}`);
        await m.react?.('✅');
    } catch (error) {
        await m.react?.('❌');
        await update(`❌ ${errorText(error)}`);
        if (!error?.expose) log.warn(`Spotify delivery failed: ${describeError(error)}`);
    }
};

const downloadLink = (sock, m, text) => sessions.run(m, 'download', 8_000, async () => {
    const s = sessions.create(m);
    try {
        await m.react?.('🔗');
        const url = await toTrackUrl(text);
        const track = await trackInfo(url);
        if (s.cancelled) return;
        await deliver(sock, m, track, s);
    } finally {
        if (sessions.peek(m) === s) sessions.cancel(m);
    }
});

const select = async (sock, m, token, index, asFile = false) => {
    const s = sessions.get(m, token);
    const i = Number(index);
    if (!/^\d+$/.test(String(index)) || !s.tracks[i]) throw new UserError('Invalid choice. Send .spotify again.');
    if (sessions.isBusy(m)) throw new UserError('Your Spotify download is still running. Wait for it to finish.');
    if (s.used) throw new UserError('That result was already downloaded. Search again to pick another song.');
    return sessions.run(m, 'download', 8_000, async () => {
        s.used = true;
        try {
            await deliver(sock, m, s.tracks[i], s, { asFile });
        } finally {
            if (sessions.peek(m) === s) sessions.cancel(m);
        }
    });
};

const cancel = (m) => {
    const had = sessions.cancel(m);
    return m.reply(had ? '✖️ Spotify cancelled.' : 'Nothing to cancel. Send .spotify to start.');
};

/** Routes any text: a link downloads, anything else searches by name. */
const handleInput = (sock, m, text) => {
    const kind = classifyInput(text).kind;
    if (kind === 'name') return search(sock, m, text);
    return downloadLink(sock, m, text);
};

// ── Typed input after "Search by name" / "Download by link" ─────────────

const onPlainMessage = ({ sock, message: m }) => {
    const text = String(m?.text || '').trim();
    if (!text || m.selectionId || text.startsWith(P())) return undefined;
    const waiting = sessions.takeAwaiting(m);
    if (!waiting) return undefined;
    // Never block the message pipeline: the job runs in the background.
    const job = CANCEL_WORDS.test(text) ? cancel(m) : handleInput(sock, m, text.slice(0, 300));
    Promise.resolve(job).catch((error) => m.reply(`❌ ${errorText(error)}`).catch(() => {}));
    return undefined;
};

events.offTag(INPUT_TAG); // hot reload safe: one listener per event
events.on('message', onPlainMessage, { tag: INPUT_TAG });
events.on('message:self', onPlainMessage, { tag: INPUT_TAG });

// ── Command ─────────────────────────────────────────────────────────────

export default {
    name: 'spotify',
    aliases: ['sp', 'spot', 'سبوتيفاي'],
    category: 'download',
    permission: 'public',
    description: 'Download songs from Spotify by name or track link, with result cards.',
    usage: '[song name | track link | cancel]',
    examples: ['spotify', 'spotify Shape of You Ed Sheeran', 'spotify https://open.spotify.com/track/7qiZfU4dY1lWllzX7mPBI3'],
    cooldown: 2,
    minArgs: 0,

    async execute(sock, m, args, ctx = {}) {
        const input = (ctx.argsText || args.join(' ')).trim();
        if (!input) return home(sock, m);
        if (CANCEL_WORDS.test(input)) return cancel(m);
        if (args[0] === 'choose') return select(sock, m, args[1], /^\d+$/.test(args[2] || '') ? Number(args[2]) - 1 : 'invalid');
        return handleInput(sock, m, input.slice(0, 300));
    },

    async onSelect(sock, m, parts) {
        const [action, token, index] = parts;
        if (action === 'cancel') {
            const current = sessions.peek(m);
            if (current && current.token !== token) throw new UserError('This Spotify menu expired. Use the newest one or send .spotify again.');
            return cancel(m);
        }
        if (action === 'home') { sessions.get(m, token); return home(sock, m); }
        if (action === 'name' || action === 'link') return askInput(sock, m, token, action);
        if (action === 'pick' || action === 'file') return select(sock, m, token, index, action === 'file');
        throw new UserError('Invalid choice. Send .spotify again.');
    }
};

export { onPlainMessage };
