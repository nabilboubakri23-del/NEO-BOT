import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import config from '../../config/config.js';
import events from '../../core/events.js';
import { child } from '../../core/logger.js';
import { box } from '../../utils/formatter.js';
import { UserError, describeError } from '../../utils/errors.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { sendButtons, sendListMenu } from '../../systems/menus/interactiveMenu.js';
import { FlowSessions } from '../../systems/interaction/flowSessions.js';
import { CANCEL_WORDS, captureInput } from '../../systems/interaction/inputCapture.js';
import { defaultMeta, makeSticker } from '../../systems/media/sticker.js';
import { latestSound, stickerOf } from '../../systems/media/soundStickerCache.js';
import { convert } from '../../systems/media/ffmpeg.js';
import { soundOf, extractAudio, parseClipArgs, prepareClip, sendSoundSticker, MAX_SECONDS, MIN_SECONDS } from '../../systems/media/soundSticker.js';
import { downloadFile } from '../download/.lib.js';
import { acquireAudio, classifyInput, searchTracks, toTrackUrl, trackInfo } from '../download/.spotify-core.js';

/**
 * .soundsticker — stickers that play sound.
 *
 *   .ss <song>                    Spotify song → sticker from its cover + the best part of the song
 *   .ss <song>   (with/reply to an image, video or sticker)   your picture + the song
 *   .ss          (reply to an audio or voice note)            that audio on a sticker
 *   .ss          (with a picture, no song)                    buttons: Spotify song / my own audio
 *   .ss <song> | 1:05 | 8         choose the start and length (2-20 s); "auto" = loudest part
 *   .ss extract [mp3]  (reply to any sound sticker, from anyone; no reply = latest one in the chat)
 *                                                            get its sound back as a voice note (or MP3)
 *   .ss cancel
 *
 * Every sticker carries the bot's pack/author. The flow uses the shared FlowSessions:
 * a new menu cancels the old one, buttons carry a token, menus expire after 5 minutes.
 */

const log = child('soundsticker');
const P = () => config.bot.prefix;
const sessions = new FlowSessions({ name: 'Sound sticker', command: 'soundsticker', maxActive: 2 });
const INPUT_TAG = 'command:soundsticker:input';
const MEDIA_TAG = 'command:soundsticker:media';
const COVER_HOSTS = ['i.scdn.co'];
const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm' };

const errorText = (error) => (error?.expose ? error.message : '⚠️ Could not make the sound sticker. Try again.');
const clock = (sec) => { const t = Math.max(0, Math.round(sec)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const meta = () => ({ pack: `${defaultMeta().pack} 🎵`, author: defaultMeta().author || 'Sound sticker', emojis: ['🎵'] });

// ── Inputs ──────────────────────────────────────────────────────────────

const audioExt = (mimetype = '') => AUDIO_EXT[mimetype.split(';')[0].trim()] || 'ogg';

/** Picture (image / video / sticker) of this message or the one it replies to → branded WebP. */
const visualFrom = async (sock, m) => {
    const media = findMedia(m, ['image', 'video', 'sticker']);
    if (!media) return null;
    if (media.kind === 'video' && media.seconds > 15) throw new UserError('Videos up to 15 seconds.');
    const buffer = await downloadMedia(sock, media);
    const sound = soundOf(media);
    return { webp: await makeSticker(buffer, media, meta()), hadSound: Boolean(sound), sound };
};

/** Audio / voice note of this message or the one it replies to. */
const audioFrom = (m) => findMedia(m, ['audio']);

/** Cover picture a Spotify song card carries (our .spotify audio), when it is on Spotify's CDN. */
const coverOf = (m) => {
    const ad = m.quoted?.message?.audioMessage?.contextInfo?.externalAdReply || m.raw?.message?.audioMessage?.contextInfo?.externalAdReply;
    const url = ad?.thumbnailUrl || '';
    return /^https:\/\/i\.scdn\.co\//.test(url) ? { url, title: ad.title || '' } : null;
};

const coverSticker = async (url) => {
    const file = await downloadFile(url, { allowHosts: COVER_HOSTS, maxBytes: 5 * 1024 * 1024, expect: ['image'] });
    return makeSticker(file.buffer, { kind: 'image' }, meta());
};

let botCover;
const botCoverSticker = async () => {
    if (!botCover) {
        const dir = path.resolve('assets/thumbs');
        const file = (await readdir(dir)).find((f) => /\.jpe?g$/i.test(f));
        if (!file) throw new UserError('No bot cover available. Send a picture instead.');
        botCover = await readFile(path.join(dir, file));
    }
    return makeSticker(botCover, { kind: 'image' }, meta());
};

// ── Screens ─────────────────────────────────────────────────────────────

const GUIDE = () => [
    'Stickers that play sound when tapped.',
    '',
    `🎵 ${P()}ss <song>  → song cover + best part`,
    `🖼️ Image/sticker + ${P()}ss <song>  → your picture`,
    `🎤 Reply to a voice note with ${P()}ss`,
    `✂️ ${P()}ss <song> | 1:05 | 8  → start and length`,
    `🔊 ${P()}ss extract [mp3]  → sound of any sound sticker (reply, or the latest in chat)`,
    '',
    `Clips are ${MIN_SECONDS}-${MAX_SECONDS} s (10 s by default).`
];

const home = (sock, m) => {
    const s = sessions.create(m);
    const body = box('SOUND STICKER', [...GUIDE(), '', 'Tap a button, then just type.']);
    return sendButtons(sock, m.chat, {
        title: 'Sound Sticker',
        body,
        footer: `${defaultMeta().pack} • Sound stickers`,
        buttons: [
            { type: 'reply', text: '🎵 Song from Spotify', id: `soundsticker:song:${s.token}` },
            { type: 'reply', text: '✖️ Cancel', id: `soundsticker:cancel:${s.token}` }
        ]
    }, { quoted: m.raw, fallbackText: `${body}\n\n${P()}ss <song name>` });
};

/** A picture is ready: choose where the sound comes from. */
const chooseSound = (sock, m, s) => {
    const body = box('SOUND STICKER', [
        '🖼️ Picture ready. Now pick the sound:',
        '',
        '🎵 *Spotify*: type a song name.',
        '🎤 *My audio*: send a voice note or audio file.',
        s.visual.hadSound ? '🔊 *Extract*: get this sticker\'s current sound.' : null,
        '',
        'Waiting 2 minutes.'
    ].filter((l) => l !== null));
    const buttons = [
        { type: 'reply', text: '🎵 Song from Spotify', id: `soundsticker:song:${s.token}` },
        { type: 'reply', text: '🎤 My own audio', id: `soundsticker:audio:${s.token}` },
        s.visual.hadSound
            ? { type: 'reply', text: '🔊 Extract sound', id: `soundsticker:extract:${s.token}` }
            : { type: 'reply', text: '✖️ Cancel', id: `soundsticker:cancel:${s.token}` }
    ];
    return sendButtons(sock, m.chat, { title: 'Sound Sticker', body, buttons }, { quoted: m.raw, fallbackText: `${body}\n${P()}ss <song name>` });
};

/** An audio is ready: choose the picture. */
const choosePicture = (sock, m, s) => {
    sessions.expect(m, s.token, 'image');
    const body = box('SOUND STICKER', ['🎤 Sound ready. Now the picture:', '', '🖼️ Send an image, short video or sticker,', '🎨 or use the bot cover.', '', 'Waiting 2 minutes.']);
    return sendButtons(sock, m.chat, {
        title: 'Sound Sticker',
        body,
        buttons: [
            { type: 'reply', text: '🎨 Bot cover', id: `soundsticker:cover:${s.token}` },
            { type: 'reply', text: '✖️ Cancel', id: `soundsticker:cancel:${s.token}` }
        ]
    }, { quoted: m.raw, fallbackText: body });
};

const askSong = (sock, m, token) => {
    sessions.expect(m, token, 'song');
    return m.reply(box('SOUND STICKER • SONG', ['Type the song name now (artist helps),', 'or paste a Spotify track link.', '', 'Optional part: Song | 1:05 | 8', 'Waiting 2 minutes.']));
};

const askAudio = (sock, m, token) => {
    sessions.expect(m, token, 'audio');
    return m.reply(box('SOUND STICKER • AUDIO', ['Send a voice note or audio file now.', 'Or type a song name to use Spotify.', 'Waiting 2 minutes.']));
};

const sendResults = (sock, m, s) => sendListMenu(sock, m.chat, {
    title: 'Pick the song',
    body: box('SOUND STICKER • SONGS', s.tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist || 'Unknown'}${t.duration ? ` (${t.duration})` : ''}`)
        .concat(['', s.visual ? '🖼️ Your picture + the song.' : '💿 The song cover becomes the sticker.', s.clip.start === null ? `✂️ Best ${s.clip.seconds} s, found automatically.` : `✂️ From ${clock(s.clip.start)}, ${s.clip.seconds} s.`])),
    footer: `${defaultMeta().pack} • Sound stickers`,
    buttonText: 'Choose a song',
    sections: [
        { title: 'Songs', rows: s.tracks.map((t, i) => ({ id: `soundsticker:pick:${s.token}:${i}`, title: `🎵 ${i + 1}. ${t.title}`.slice(0, 72), description: [t.artist, t.duration].filter(Boolean).join(' • ').slice(0, 72) })) },
        { title: 'Options', rows: [{ id: `soundsticker:cancel:${s.token}`, title: '✖️ Cancel', description: 'Close this search' }] }
    ]
}, { quoted: m.raw, fallbackText: box('SOUND STICKER', [...s.tracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist || 'Unknown'}`), '', `Reply: ${P()}ss choose ${s.token} <number>`]) });

// ── Building ────────────────────────────────────────────────────────────

/**
 * Makes and sends the sticker. Sources: s.track (Spotify) or s.audioMedia (WhatsApp audio);
 * picture: s.visual, else the song cover, else the bot cover.
 */
const build = (sock, m, s) => sessions.run(m, 'build', 5_000, async () => {
    s.used = true;
    await m.react?.('⏳');
    const status = await m.reply(s.track ? `⏳ Getting *${s.track.title}*...` : '⏳ Preparing your sound...').catch(() => null);
    const update = (text) => (status?.key ? sock.sendMessage(m.chat, { text, edit: status.key }).catch(() => {}) : m.reply(text).catch(() => {}));
    const started = Date.now();
    try {
        let source;
        if (s.track) {
            const audio = await acquireAudio(s.track, { isCancelled: () => s.cancelled });
            source = { buffer: audio.buffer, ext: audio.ext };
        } else {
            source = { buffer: await downloadMedia(sock, s.audioMedia), ext: audioExt(s.audioMedia.mimetype) };
        }
        if (s.cancelled) throw new UserError('Sound sticker cancelled.');
        await update(`✂️ Cutting ${s.clip.start === null ? `the best ${s.clip.seconds} s` : `${s.clip.seconds} s from ${clock(s.clip.start)}`}...`);
        const coverUrl = s.track?.cover || s.cover?.url;
        const [clip, webp] = await Promise.all([
            prepareClip(source.buffer, source.ext, s.clip),
            s.visual?.webp || (coverUrl ? coverSticker(coverUrl).catch(() => botCoverSticker()) : botCoverSticker())
        ]);
        if (s.cancelled) throw new UserError('Sound sticker cancelled.');
        await sendSoundSticker(sock, m.chat, { webp, clip, quoted: m.raw });
        const title = s.track ? `${s.track.title}${s.track.artist ? ` — ${s.track.artist}` : ''}` : (s.cover?.title || 'Your audio');
        await update(box('SOUND STICKER ✅', [
            `🎵 ${title}`.slice(0, 120),
            `✂️ ${clock(clip.start)} → ${clock(clip.start + clip.seconds)} (${clip.seconds} s)${clip.auto ? ' • best part' : ''}`,
            `🏷️ ${meta().pack}${meta().author ? ` • ${meta().author}` : ''}`,
            `⚡ ${((Date.now() - started) / 1000).toFixed(1)} s`,
            '',
            'Tap the sticker to play it.',
            `Another part: reply to it with ${P()}ss <song> | 1:20 | 8`,
            `Get the sound: reply with ${P()}ss extract`
        ]));
        await m.react?.('✅');
    } catch (error) {
        await m.react?.('❌');
        await update(`❌ ${errorText(error)}`);
        if (!error?.expose) log.warn(`Sound sticker failed: ${describeError(error)}`);
    } finally {
        if (sessions.peek(m) === s) sessions.cancel(m);
    }
});

/** Song text (name or Spotify link) → direct build for links, result list for names. */
const fromSong = async (sock, m, s, text) => {
    const { query, start, seconds } = parseClipArgs(text);
    if (start !== null || /\|/.test(text)) s.clip = { start, seconds };
    if (!query) throw new UserError('Type a song name or a Spotify track link.');
    const kind = classifyInput(query).kind;
    if (kind !== 'name') {
        if (sessions.isBusy(m)) throw new UserError('Your sound sticker is still being made. Wait for it to finish.');
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

/** Sticker to read: the command/reply sticker, else (no reply) the latest sound sticker in this chat. */
const soundToExtract = (m) => {
    const media = findMedia(m, ['sticker']) || lottieReply(m);
    if (media) {
        const sound = soundOf(media);
        if (!sound) throw new UserError('That sticker has no sound.');
        return sound;
    }
    if (m.quoted) throw new UserError('Reply to a sound sticker to get its sound.');
    const last = latestSound(m.chat);
    if (!last) throw new UserError('Reply to a sound sticker to get its sound (no recent one in this chat).');
    return { ...last, alternatives: [last] };
};

// Lottie (animated) sound stickers are wrapped, so findMedia does not see them as stickers.
const lottieReply = (m) => {
    const sticker = m.quoted?.message ? stickerOf(m.quoted.message) : null;
    return sticker ? { kind: 'sticker', key: m.quoted.key, message: { stickerMessage: sticker } } : null;
};

const extract = async (sock, m, ref = null, mp3 = false) => {
    const sound = ref || soundToExtract(m);
    await m.react?.('🔊');
    const ogg = await extractAudio(sock, sound.key, sound.audio, sound.alternatives);
    if (mp3) {
        const audio = await convert(ogg, { inExt: 'ogg', outExt: 'mp3', args: (i, o) => ['-i', i, '-c:a', 'libmp3lame', '-b:a', '128k', o], timeoutMs: 60_000 });
        await sock.sendMessage(m.chat, { audio, mimetype: 'audio/mpeg', fileName: 'sound-sticker.mp3' }, { quoted: m.raw });
    } else {
        await sock.sendMessage(m.chat, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m.raw });
    }
    await m.react?.('✅');
};

/** Entry point shared by .soundsticker and `.sticker song …`. */
export const start = async (sock, m, text = '') => {
    const input = String(text || '').trim();
    if (CANCEL_WORDS.test(input)) return cancel(m);
    const ex = input.match(/^(extract|sound|استخراج)(?:\s+(mp3|audio|ملف))?$/i);
    if (ex) return extract(sock, m, null, Boolean(ex[2]));
    const visualMedia = findMedia(m, ['image', 'video', 'sticker']);
    const audioMedia = audioFrom(m);
    if (!input && !visualMedia && !audioMedia) return home(sock, m);

    const s = sessions.create(m);
    const { start: from, seconds } = parseClipArgs(input);
    s.clip = { start: from, seconds };
    if (visualMedia) {
        await m.react?.('🖼️');
        s.visual = await visualFrom(sock, m);
    }
    if (audioMedia && !input) {
        s.audioMedia = audioMedia;
        s.cover = coverOf(m);
        if (s.visual || s.cover) return build(sock, m, s);
        return choosePicture(sock, m, s);
    }
    if (input) return fromSong(sock, m, s, input);
    return chooseSound(sock, m, s);
};

const pick = async (sock, m, token, index) => {
    const s = sessions.get(m, token);
    const i = Number(index);
    if (!/^\d+$/.test(String(index)) || !s.tracks?.[i]) throw new UserError(`Invalid choice. Send ${P()}ss again.`);
    if (s.used) throw new UserError('This search was already used. Send the command again for another sticker.');
    s.track = s.tracks[i];
    return build(sock, m, s);
};

const cancel = (m) => {
    const had = sessions.cancel(m);
    return m.reply(had ? '✖️ Sound sticker cancelled.' : `Nothing to cancel. Send ${P()}ss to start.`);
};

// ── Typed input and media after a button ────────────────────────────────

const onInput = async (sock, m, text, mode, s) => {
    if (mode === 'image' && findMedia(m, ['image', 'video', 'sticker'])) return useImage(sock, m, s);
    if (mode === 'image') throw new UserError('Send a picture, or tap Bot cover.');
    return fromSong(sock, m, s, text);
};

const useImage = async (sock, m, s) => {
    s.visual = await visualFrom(sock, m);
    return build(sock, m, s);
};

captureInput({
    tag: INPUT_TAG,
    sessions,
    onInput,
    onCancel: (sock, m) => cancel(m),
    onError: (sock, m, error) => m.reply(`❌ ${errorText(error)}`).catch(() => {})
});

/** Voice note / audio after "My own audio", or a picture after the sound was chosen. */
const onMedia = ({ sock, message: m }) => {
    if (!m || m.selectionId || String(m.text || '').startsWith(P())) return undefined;
    const waiting = sessions.peek(m)?.awaiting;
    if (!waiting) return undefined;
    const audio = waiting.mode === 'audio' ? findMedia(m, ['audio']) : null;
    const image = waiting.mode === 'image' && !String(m.text || '').trim() ? findMedia(m, ['image', 'video', 'sticker']) : null;
    if (!audio && !image) return undefined;
    if (audio && findMedia(m, ['audio'])?.key !== m.raw?.key) return undefined; // must be the new message itself
    const taken = sessions.takeAwaiting(m);
    if (!taken) return undefined;
    const s = taken.session;
    const job = audio ? (s.audioMedia = audio, build(sock, m, s)) : useImage(sock, m, s);
    Promise.resolve(job).catch((error) => m.reply(`❌ ${errorText(error)}`).catch(() => {}));
    return undefined;
};

events.offTag(MEDIA_TAG);
events.on('message', onMedia, { tag: MEDIA_TAG });
events.on('message:self', onMedia, { tag: MEDIA_TAG });

// ── Command ─────────────────────────────────────────────────────────────

export default {
    name: 'soundsticker',
    aliases: ['ss', 'ssticker', 'stickersound', 'ملصق_صوتي'],
    category: 'media',
    permission: 'public',
    description: 'Stickers that play sound: a picture or song cover with a Spotify clip or your own audio.',
    usage: '[song | start | seconds]  (with or replying to an image, sticker or audio)  |  extract [mp3]  |  cancel',
    examples: ['ss', 'ss Blinding Lights The Weeknd', 'ss Shape of You | 0:45 | 8', 'ss extract', 'ss extract mp3'],
    cooldown: 3,
    minArgs: 0,

    async execute(sock, m, args, ctx = {}) {
        if (args[0] === 'choose') return pick(sock, m, args[1], /^\d+$/.test(args[2] || '') ? Number(args[2]) - 1 : 'invalid');
        return start(sock, m, (ctx.argsText ?? args.join(' ')).slice(0, 300));
    },

    async onSelect(sock, m, parts) {
        const [action, token, index] = parts;
        if (action === 'cancel') {
            const current = sessions.peek(m);
            if (current && current.token !== token) throw new UserError(`This menu expired. Send ${P()}ss again.`);
            return cancel(m);
        }
        const s = sessions.get(m, token);
        if (action === 'song') return askSong(sock, m, token);
        if (action === 'audio') return askAudio(sock, m, token);
        if (action === 'pick') return pick(sock, m, token, index);
        if (action === 'extract') {
            if (!s.visual?.sound) throw new UserError('This sticker has no sound.');
            const ref = s.visual.sound;
            sessions.cancel(m);
            return extract(sock, m, ref);
        }
        if (action === 'cover') {
            if (!s.audioMedia) throw new UserError(`Send ${P()}ss again.`);
            s.awaiting = null;
            s.visual = { webp: await botCoverSticker() };
            return build(sock, m, s);
        }
        throw new UserError(`Invalid choice. Send ${P()}ss again.`);
    }
};

export { onMedia, onInput };
