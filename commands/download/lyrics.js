import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { box } from '../../utils/formatter.js';
import { UserError, describeError } from '../../utils/errors.js';
import { sendListMenu } from '../../systems/menus/interactiveMenu.js';
import { cardButton, sendCarousel, uploadHeader } from '../../systems/menus/carousel.js';
import { FlowSessions } from '../../systems/interaction/flowSessions.js';
import { CANCEL_WORDS, captureInput } from '../../systems/interaction/inputCapture.js';
import { toVoiceNote } from '../../systems/media/voiceNote.js';
import { downloadFile, sanitizeFilename } from './.lib.js';
import { acquireAudio, classifyInput, searchTracks, toTrackUrl, trackInfo } from './.spotify-core.js';
import { findLyrics } from './.lyrics-api.js';
import { start as soundSticker } from '../sticker/soundsticker.js';

/**
 * .lyrics — a song card with its lyrics, and the song as a voice note that plays
 * right in the chat (it keeps playing while you type).
 *
 *   .lyrics <song name>     search Spotify, pick a result
 *   .lyrics <track link>    straight to the card
 *   .lyrics                 asks for the song
 *   .lyrics cancel
 *
 * The card: song cover, title, artist, the lyrics (LRCLIB) and buttons:
 * Full lyrics / MP3 file / Sound sticker. Lyrics are static text: WhatsApp gives
 * the bot no way to know when the voice note is played or paused.
 */

const log = child('lyrics');
const P = () => config.bot.prefix;
const sessions = new FlowSessions({ name: 'Lyrics', command: 'lyrics', maxActive: 2 });
const INPUT_TAG = 'command:lyrics:input';
const CARD_LYRICS_CHARS = 850;
const FULL_LYRICS_CHARS = 60_000;

const errorText = (error) => (error?.expose ? error.message : '⚠️ Could not get that song. Try again.');

/** First verses that fit on the card, cut at a line end. */
export const cardLyrics = (text, limit = CARD_LYRICS_CHARS) => {
    const clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
    if (clean.length <= limit) return { text: clean, cut: false };
    const slice = clean.slice(0, limit);
    const end = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
    return { text: `${(end > limit * 0.5 ? slice.slice(0, end) : slice).trim()}\n…`, cut: true };
};

const coverBuffer = async (track) => {
    if (!track.cover) return null;
    const file = await downloadFile(track.cover, { allowHosts: ['i.scdn.co'], maxBytes: 2 * 1024 * 1024, expect: ['image'] }).catch(() => null);
    return file?.buffer || null;
};

// ── Screens ─────────────────────────────────────────────────────────────

const ask = (m, s) => {
    sessions.expect(m, s.token, 'song');
    return m.reply(box('LYRICS', [
        'A song card with its lyrics, and the song',
        'as a voice note that plays in the chat.',
        '',
        'Type the song name now (artist helps),',
        'or paste a Spotify track link.',
        `Example: ${P()}lyrics Zahri Inkonnu`,
        'Waiting 2 minutes.'
    ]));
};

const sendResults = (sock, m, s) => sendListMenu(sock, m.chat, {
    title: 'Pick the song',
    body: box('LYRICS • SONGS', s.tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist || 'Unknown'}${t.duration ? ` (${t.duration})` : ''}`)
        .concat(['', 'Pick one: you get the card with its lyrics', 'and the song as a voice note.'])),
    footer: `${config.bot.name} • Lyrics`,
    buttonText: 'Choose a song',
    sections: [
        { title: 'Songs', rows: s.tracks.map((t, i) => ({ id: `lyrics:pick:${s.token}:${i}`, title: `🎵 ${i + 1}. ${t.title}`.slice(0, 72), description: [t.artist, t.duration].filter(Boolean).join(' • ').slice(0, 72) })) },
        { title: 'Options', rows: [{ id: `lyrics:cancel:${s.token}`, title: '✖️ Cancel', description: 'Close this search' }] }
    ]
}, { quoted: m.raw, fallbackText: box('LYRICS', [...s.tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist || 'Unknown'}`), '', `Reply: ${P()}lyrics choose ${s.token} <number>`]) });

/** The song card: cover, title, artist, lyrics and buttons (one-card carousel, like .pinterest). */
const sendCard = async (sock, m, s, cover) => {
    const t = s.track;
    const lyrics = s.lyrics?.plain ? cardLyrics(s.lyrics.plain) : null;
    const body = [
        `🎤 *${t.artist || 'Unknown artist'}*`,
        [t.album ? `💿 ${t.album}` : null, t.duration ? `⏱️ ${t.duration}` : null].filter(Boolean).join('  •  ') || null,
        '',
        lyrics ? lyrics.text : '📝 No lyrics found for this song.',
        '',
        '▶️ Play the voice note under this card.'
    ].filter((line) => line !== null).join('\n');
    const buttons = [
        lyrics?.cut ? cardButton.reply('📜 Full lyrics', `lyrics:full:${s.token}`) : null,
        cardButton.reply('⬇️ MP3 file', `lyrics:mp3:${s.token}`),
        cardButton.reply('🎵 Sound sticker', `lyrics:sticker:${s.token}`)
    ].filter(Boolean);
    try {
        if (!cover) throw new Error('no cover');
        return await sendCarousel(sock, m.chat, {
            body: `🎧 *${t.title}*`,
            footer: `${config.bot.name} • Lyrics`,
            cards: [{ title: t.title.slice(0, 60), header: await uploadHeader(sock, 'image', cover), body, footer: s.lyrics ? `Lyrics: ${s.lyrics.source}` : '', buttons }]
        }, { quoted: m.raw });
    } catch (error) {
        log.debug(`Card failed, sending text: ${describeError(error)}`);
        return sock.sendMessage(m.chat, { text: box(`🎧 ${t.title}`.slice(0, 60), body.split('\n')) }, { quoted: m.raw });
    }
};

// ── Building ────────────────────────────────────────────────────────────

const build = (sock, m, s) => sessions.run(m, 'build', 5_000, async () => {
    s.used = true;
    const t = s.track;
    await m.react?.('⏳');
    const status = await m.reply(`⏳ Getting *${t.title}*${t.artist ? ` — ${t.artist}` : ''} and its lyrics...`).catch(() => null);
    const update = (text) => (status?.key ? sock.sendMessage(m.chat, { text, edit: status.key }).catch(() => {}) : m.reply(text).catch(() => {}));
    const started = Date.now();
    try {
        const [audio, lyrics, cover] = await Promise.all([
            acquireAudio(t, { isCancelled: () => s.cancelled }),
            findLyrics(t).catch(() => null),
            coverBuffer(t)
        ]);
        if (s.cancelled) throw new UserError('Lyrics request cancelled.');
        s.lyrics = lyrics;
        s.audio = audio;
        await update('🎚️ Preparing the voice note...');
        const voice = await toVoiceNote(audio.buffer, audio.ext);
        if (s.cancelled) throw new UserError('Lyrics request cancelled.');
        const card = await sendCard(sock, m, s, cover);
        await sock.sendMessage(m.chat, {
            audio: voice.ogg,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            seconds: voice.seconds,
            waveform: voice.waveform,
            contextInfo: {
                externalAdReply: {
                    title: t.title.slice(0, 80),
                    body: [t.artist, t.album].filter(Boolean).join(' • ').slice(0, 100) || `${config.bot.name} • Lyrics`,
                    mediaType: 1,
                    ...(t.cover ? { thumbnailUrl: t.cover } : {}),
                    ...(cover ? { thumbnail: cover } : {}),
                    sourceUrl: t.url,
                    renderLargerThumbnail: false
                }
            }
        }, { quoted: card?.key ? card : m.raw });
        await update(box('LYRICS ✅', [
            `🎵 ${t.title}${t.artist ? ` — ${t.artist}` : ''}`.slice(0, 120),
            lyrics ? `📝 Lyrics: ${lyrics.source}` : '📝 No lyrics found',
            `⚡ ${((Date.now() - started) / 1000).toFixed(1)} s`,
            '',
            'The voice note keeps playing while you type.'
        ]));
        await m.react?.('✅');
    } catch (error) {
        await m.react?.('❌');
        await update(`❌ ${errorText(error)}`);
        if (!error?.expose) log.warn(`Lyrics failed: ${describeError(error)}`);
        if (sessions.peek(m) === s) sessions.cancel(m);
    }
});

/** Song name → result list; Spotify link → straight to the card. */
const fromSong = async (sock, m, s, text) => {
    const query = String(text || '').trim().slice(0, 200);
    if (!query) throw new UserError('Type a song name or a Spotify track link.');
    if (classifyInput(query).kind !== 'name') {
        s.track = await trackInfo(await toTrackUrl(query));
        return build(sock, m, s);
    }
    return sessions.run(m, 'search', 3_000, async () => {
        await m.react?.('🔎');
        const tracks = await searchTracks(query);
        if (!tracks.length) throw new UserError(`No Spotify results for "${query.slice(0, 60)}". Add the artist name.`);
        if (s.cancelled) return;
        s.tracks = tracks;
        sessions.touch(s);
        await sendResults(sock, m, s);
    });
};

const cancel = (m) => {
    const had = sessions.cancel(m);
    return m.reply(had ? '✖️ Lyrics cancelled.' : `Nothing to cancel. Send ${P()}lyrics to start.`);
};

captureInput({
    tag: INPUT_TAG,
    sessions,
    onInput: (sock, m, text, mode, s) => fromSong(sock, m, s, text),
    onCancel: (sock, m) => cancel(m),
    onError: (sock, m, error) => m.reply(`❌ ${errorText(error)}`).catch(() => {})
});

// ── Card buttons ────────────────────────────────────────────────────────

const fullLyrics = (m, s) => {
    if (!s.lyrics?.plain) throw new UserError('No lyrics for this song.');
    sessions.touch(s);
    return m.reply(`📜 *${s.track.title}*${s.track.artist ? ` — ${s.track.artist}` : ''}\n\n${s.lyrics.plain.slice(0, FULL_LYRICS_CHARS)}`);
};

const mp3File = async (sock, m, s) => {
    if (!s.audio) throw new UserError(`The song is no longer in memory. Send ${P()}lyrics again.`);
    sessions.touch(s);
    const name = sanitizeFilename([s.track.title, s.track.artist].filter(Boolean).join(' - '), 'song');
    return sock.sendMessage(m.chat, { document: s.audio.buffer, mimetype: s.audio.mimetype, fileName: `${name}.${s.audio.ext}` }, { quoted: m.raw });
};

// ── Command ─────────────────────────────────────────────────────────────

export default {
    name: 'lyrics',
    aliases: ['lyric', 'ly', 'songcard', 'كلمات'],
    category: 'download',
    permission: 'public',
    description: 'Song card with lyrics, and the song as a voice note that plays in the chat.',
    usage: '<song name | Spotify track link>  |  cancel',
    examples: ['lyrics Zahri Inkonnu', 'lyrics Blinding Lights The Weeknd'],
    cooldown: 3,
    minArgs: 0,

    async execute(sock, m, args, ctx = {}) {
        if (args[0] === 'choose') {
            const s = sessions.get(m, args[1]);
            const i = Number(args[2]) - 1;
            if (!s.tracks?.[i]) throw new UserError(`Invalid choice. Send ${P()}lyrics again.`);
            s.track = s.tracks[i];
            return build(sock, m, s);
        }
        const text = (ctx.argsText ?? args.join(' ')).trim();
        if (CANCEL_WORDS.test(text)) return cancel(m);
        const s = sessions.create(m);
        if (!text) return ask(m, s);
        return fromSong(sock, m, s, text);
    },

    async onSelect(sock, m, parts) {
        const [action, token, index] = parts;
        if (action === 'cancel') {
            const current = sessions.peek(m);
            if (current && current.token !== token) throw new UserError(`This menu expired. Send ${P()}lyrics again.`);
            return cancel(m);
        }
        const s = sessions.get(m, token);
        if (action === 'pick') {
            const i = Number(index);
            if (!s.tracks?.[i]) throw new UserError(`Invalid choice. Send ${P()}lyrics again.`);
            if (s.used) throw new UserError('This search was already used. Send the command again for another song.');
            s.track = s.tracks[i];
            return build(sock, m, s);
        }
        if (!s.track) throw new UserError(`Send ${P()}lyrics again.`);
        if (action === 'full') return fullLyrics(m, s);
        if (action === 'mp3') return mp3File(sock, m, s);
        if (action === 'sticker') return soundSticker(sock, m, s.track.url);
        throw new UserError(`Invalid choice. Send ${P()}lyrics again.`);
    }
};
