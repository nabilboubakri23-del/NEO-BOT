import { UserError } from '../../utils/errors.js';
import { convert } from './ffmpeg.js';
import { decodePcm, waveform } from './soundSticker.js';

/**
 * Any audio → WhatsApp voice note (mono 48 kHz Opus) with a real waveform.
 * Voice notes play inline in the chat and keep playing while the user types.
 */

export const MAX_VOICE_SECONDS = 10 * 60;

export const toVoiceNote = async (buffer, ext, { maxSeconds = MAX_VOICE_SECONDS, bitrate = '64k' } = {}) => {
    const pcm = await decodePcm(buffer, ext);
    const total = pcm.length / 8000;
    if (total < 0.5) throw new UserError('That audio is empty or too short.');
    const seconds = Math.min(total, maxSeconds);
    const ogg = await convert(buffer, {
        inExt: ext,
        outExt: 'ogg',
        timeoutMs: 120_000,
        args: (i, o) => ['-t', seconds.toFixed(2), '-i', i, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', bitrate, '-application', 'audio', '-f', 'ogg', o]
    });
    return { ogg, seconds: Math.max(1, Math.round(seconds)), waveform: waveform(pcm.subarray(0, Math.floor(seconds * 8000))) };
};
