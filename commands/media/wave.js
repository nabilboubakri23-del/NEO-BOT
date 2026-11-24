import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { toVoiceNote } from '../../systems/media/voiceNote.js';
import { SHAPE_NAMES, drawDigits, drawShape, drawUnits, morseUnits, pcmToOgg, preview, shapeIcon, synth } from '../../systems/media/waveArt.js';

/**
 * .wave — voice notes whose waveform draws a picture.
 *   .wave heart                 a tone that swells with the shape
 *   .wave heart (reply to audio/voice/video)   that sound, drawn as a heart
 *   .wave morse NEO             Morse beeps, and the bars show the dots and dashes
 *   .wave custom 1 3 6 9 6 3 1  your own bars (digits 0–9)
 *   .wave list
 */

const P = () => config.bot.prefix;
const UNIT_SECONDS = 0.09;

const help = (m) => m.reply(box('WAVE ART', [
    'Voice notes whose waves draw a picture.',
    '',
    `${P()}wave <shape>  → e.g. ${P()}wave heart`,
    '  reply to a voice / audio / video to use its sound',
    `${P()}wave morse <text>  → Morse beeps you can see`,
    `${P()}wave custom 1 3 6 9 6 3 1  → your own bars`,
    '',
    'Shapes:',
    ...SHAPE_NAMES.map((n) => `${shapeIcon(n)} ${n}`)
]));

const sendWave = (sock, m, { ogg, seconds, bars }) =>
    sock.sendMessage(m.chat, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: Math.max(1, Math.round(seconds)), waveform: bars }, { quoted: m.raw });

export default {
    name: 'wave',
    aliases: ['waveart', 'wavedraw', 'موجة'],
    category: 'media',
    permission: 'public',
    description: 'Voice note whose waveform draws a shape, Morse text or your own bars.',
    usage: '<shape> | morse <text> | custom <digits> | list  (reply to audio to use its sound)',
    examples: ['wave heart', 'wave morse NEO', 'wave custom 1 3 6 9 6 3 1', 'wave list'],
    cooldown: 5,
    async execute(sock, m, args) {
        const sub = String(args[0] || '').toLowerCase();
        if (!sub || ['list', 'help', 'shapes'].includes(sub)) return help(m);
        const rest = args.slice(1).join(' ');
        await m.react?.('〰️');

        if (sub === 'morse') {
            if (!rest.trim()) throw new UserError(`Give the text: ${P()}wave morse NEO`);
            const units = morseUnits(rest);
            const seconds = units.length * UNIT_SECONDS + 0.4;
            const pcm = synth([...units.map((u) => u * 100), 0], seconds, { freq: 700, smooth: false });
            const bars = drawUnits(units);
            await sendWave(sock, m, { ogg: await pcmToOgg(pcm), seconds, bars });
            return m.reply(`📡 ${rest.toUpperCase().slice(0, 40)}\n${preview(bars)}`);
        }

        const bars = sub === 'custom' ? drawDigits(rest) : drawShape(sub);
        const media = findMedia(m, ['audio', 'video']);
        if (media) {
            const buffer = await downloadMedia(sock, media, { maxBytes: 16 * 1024 * 1024 });
            const voice = await toVoiceNote(buffer, media.kind === 'video' ? 'mp4' : 'ogg', { maxSeconds: 300 });
            await sendWave(sock, m, { ogg: voice.ogg, seconds: voice.seconds, bars });
        } else {
            const seconds = Math.min(15, Math.max(2, parseFloat(rest) || 4));
            await sendWave(sock, m, { ogg: await pcmToOgg(synth(bars, seconds)), seconds, bars });
        }
        return m.react?.(shapeIcon(sub === 'custom' ? '' : sub));
    }
};

