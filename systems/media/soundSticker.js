import { downloadMediaMessage, generateWAMessageFromContent, prepareWAMessageMedia } from 'baileys';
import { child } from '../../core/logger.js';
import { UserError } from '../../utils/errors.js';
import { convert } from './ffmpeg.js';
import { stickerAudioReady } from '../security/stickerAudioProtocol.js';

/**
 * Sound stickers: a WebP sticker that carries a short Opus voice clip inside
 * stickerMessage.audioMessage (field 26, enabled by stickerAudioProtocol.js).
 *
 *   prepareClip(buffer, ext, { start, seconds })  any audio → normalized mono Opus clip + real waveform
 *   sendSoundSticker(sock, jid, { webp, clip })   uploads both parts and relays one sticker message
 *   embeddedAudio(message) / extractAudio(...)    read the clip back out of a received sound sticker
 *
 * Clients that do not know the field still show a normal sticker.
 */

const log = child('sound-sticker');

export const DEFAULT_SECONDS = 10;
export const MIN_SECONDS = 2;
export const MAX_SECONDS = 20;
const PCM_RATE = 8000; // analysis only: cheap and enough for loudness and waveform
const MAX_ANALYSIS_SECONDS = 15 * 60;
const UPLOAD_TIMEOUT_MS = 25_000;

/** "1:05", "01:02:03", "65", "65s" → seconds; anything else → null. */
export const parseTime = (text) => {
    const raw = String(text ?? '').trim().toLowerCase().replace(/s$/, '');
    if (!raw) return null;
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(raw)) return null;
    return raw.split(':').reduce((total, part) => total * 60 + Number(part), 0);
};

export const clampSeconds = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SECONDS;
    return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(n)));
};

/**
 * "song name | start | seconds"  (start may be "auto"; both optional)
 * @returns {{ query: string, start: number|null, seconds: number }}
 */
export const parseClipArgs = (text) => {
    const [query = '', startText = '', secondsText = ''] = String(text || '').split('|').map((s) => s.trim());
    const start = /^(auto|best|تلقائي)?$/i.test(startText) ? null : parseTime(startText);
    if (startText && !/^(auto|best|تلقائي)$/i.test(startText) && start === null) throw new UserError('Start must look like 1:05 or 65 (seconds), or auto.');
    if (secondsText && !/^\d+s?$/.test(secondsText)) throw new UserError(`Length must be a number of seconds (${MIN_SECONDS}-${MAX_SECONDS}).`);
    return { query: query.slice(0, 200), start, seconds: secondsText ? clampSeconds(parseInt(secondsText, 10)) : DEFAULT_SECONDS };
};

/** Decodes any audio/video to 8 kHz mono signed 16-bit PCM for analysis. */
export const decodePcm = async (buffer, ext) => {
    const raw = await convert(buffer, {
        inExt: ext,
        outExt: 'pcm',
        timeoutMs: 60_000,
        args: (i, o) => ['-t', String(MAX_ANALYSIS_SECONDS), '-i', i, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', o]
    });
    return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
};

/**
 * Start (seconds) of the loudest `seconds`-long window: a good guess for the hook/chorus.
 * Sliding RMS in 0.5 s steps; the first and last few seconds (intros, fades) are skipped when possible.
 */
export const bestWindow = (pcm, seconds, rate = PCM_RATE) => {
    const step = Math.floor(rate / 2);
    const blocks = Math.floor(pcm.length / step);
    const width = Math.max(1, Math.round((seconds * rate) / step));
    if (blocks <= width) return 0;
    const energy = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
        let sum = 0;
        for (let i = b * step, end = i + step; i < end; i++) sum += pcm[i] * pcm[i];
        energy[b] = sum;
    }
    const total = blocks * 0.5;
    const margin = total > seconds + 20 ? 10 : 0; // seconds skipped at both ends on long tracks
    const first = Math.floor(margin * 2);
    const last = blocks - width - Math.floor(margin * 2);
    let window = 0;
    for (let b = first; b < first + width; b++) window += energy[b];
    let best = window;
    let bestAt = first;
    for (let b = first + 1; b <= last; b++) {
        window += energy[b + width - 1] - energy[b - 1];
        if (window > best) { best = window; bestAt = b; }
    }
    return bestAt * 0.5;
};

/** 64-value (0-100) voice-note waveform, the bars WhatsApp draws. */
export const waveform = (pcm, bars = 64) => {
    const out = Buffer.alloc(bars);
    if (!pcm.length) return out;
    const per = Math.max(1, Math.floor(pcm.length / bars));
    const peaks = [];
    for (let b = 0; b < bars; b++) {
        let peak = 0;
        for (let i = b * per, end = Math.min(pcm.length, i + per); i < end; i++) peak = Math.max(peak, Math.abs(pcm[i]));
        peaks.push(peak);
    }
    const max = Math.max(...peaks) || 1;
    peaks.forEach((p, i) => { out[i] = Math.round((p / max) * 100); });
    return out;
};

/**
 * Cuts, fades, loudness-normalizes and encodes a clip as mono 48 kHz Opus (WhatsApp voice format).
 * @param {Buffer} buffer  source audio or video
 * @param {string} ext     source extension hint (mp3, m4a, ogg, mp4…)
 * @param {{ start?: number|null, seconds?: number }} [options]  start null = loudest part
 * @returns {Promise<{ ogg: Buffer, seconds: number, start: number, total: number, waveform: Buffer, auto: boolean }>}
 */
export const prepareClip = async (buffer, ext, { start = null, seconds = DEFAULT_SECONDS } = {}) => {
    const length = clampSeconds(seconds);
    const pcm = await decodePcm(buffer, ext);
    const total = pcm.length / PCM_RATE;
    if (total < 0.5) throw new UserError('That audio is empty or too short.');
    const auto = start === null || start === undefined;
    let from = auto ? bestWindow(pcm, length) : Math.max(0, Number(start));
    if (from >= total) throw new UserError(`The audio is only ${Math.floor(total)} seconds long; pick an earlier start.`);
    const duration = Math.min(length, total - from);
    from = Math.round(from * 10) / 10;
    const fadeOut = Math.max(0, duration - 0.6).toFixed(2);
    const ogg = await convert(buffer, {
        inExt: ext,
        outExt: 'ogg',
        timeoutMs: 60_000,
        args: (i, o) => [
            '-ss', String(from), '-t', duration.toFixed(2), '-i', i, '-vn',
            '-af', `afade=t=in:d=0.25,afade=t=out:st=${fadeOut}:d=0.6,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000`,
            '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', '-f', 'ogg', o
        ]
    });
    const slice = pcm.subarray(Math.floor(from * PCM_RATE), Math.floor((from + duration) * PCM_RATE));
    return { ogg, seconds: Math.max(1, Math.round(duration)), start: from, total, waveform: waveform(slice), auto };
};

/** The audio clip inside a received sound sticker, or null. */
export const embeddedAudio = (content) => content?.stickerMessage?.audioMessage || null;

/** Downloads the clip of a sound sticker as an Opus buffer. */
export const extractAudio = async (sock, key, audioMessage) => {
    try {
        return await downloadMediaMessage({ key, message: { audioMessage } }, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
    } catch (error) {
        log.warn(`Sound sticker audio download failed: ${error?.message}`);
        throw new UserError('Could not download the sound of that sticker.');
    }
};

/**
 * Sends one sound sticker. The sticker and its clip are uploaded separately, then
 * the clip is attached to the sticker and relayed as a single message.
 * @param {{ webp: Buffer, clip: { ogg: Buffer, seconds: number, waveform?: Buffer }, quoted?: object }} parts
 */
export const sendSoundSticker = async (sock, jid, { webp, clip, quoted }) => {
    if (!stickerAudioReady()) throw new UserError('Sound stickers are not supported by this build of the WhatsApp library. A normal sticker was not sent.');
    const options = { upload: sock.waUploadToServer, mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS };
    const [sticker, audio] = await Promise.all([
        prepareWAMessageMedia({ sticker: webp, width: 512, height: 512 }, options),
        prepareWAMessageMedia({ audio: clip.ogg, mimetype: 'audio/ogg; codecs=opus', seconds: clip.seconds, ptt: true, waveform: clip.waveform || Buffer.alloc(64) }, options)
    ]);
    sticker.stickerMessage.audioMessage = audio.audioMessage;
    const built = generateWAMessageFromContent(jid, sticker, { userJid: sock.user?.id, ...(quoted ? { quoted } : {}) });
    await sock.relayMessage(jid, built.message, { messageId: built.key.id });
    return built;
};
