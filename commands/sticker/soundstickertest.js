import { readFile } from 'node:fs/promises';
import { generateWAMessageFromContent, prepareWAMessageMedia } from 'baileys';
import { child } from '../../core/logger.js';
import { stickerAudioReady } from '../../systems/security/stickerAudioProtocol.js';

const log = child('sound-sticker-test');
const lastByChat = new Map();
let active = false;
const COOLDOWN_MS = 60000;

export function diagnosticDecision(message, args, ready, busy, last, now) {
    if (!/^(?:\d+@(s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(String(message.chat || ''))) return 'unsupported_chat';
    if (args.length) return 'unexpected_arguments';
    if (!ready) return 'codec_not_ready';
    if (busy) return 'busy';
    if (last !== undefined && now - last < COOLDOWN_MS) return 'cooldown';
    return 'ready';
}

export default {
    name: 'soundstickertest',
    category: 'media',
    description: 'Sound sticker diagnostic: blue square with a one-second tone.',
    usage: '',
    permission: 'public',
    cooldown: 60,
    async execute(sock, message, args) {
        const now = Date.now();
        const decision = diagnosticDecision(message, args, stickerAudioReady(), active, lastByChat.get(message.chat), now);
        log.info({ decision }, 'Diagnostic decision.'); // no IDs, keys or payloads
        if (decision !== 'ready') {
            if (decision === 'unsupported_chat') return;
            const text = {
                unexpected_arguments: 'Use .soundstickertest without arguments. No sticker was sent.',
                codec_not_ready: 'The sound-sticker codec is not ready. No sticker was sent. Do not repeat the command.',
                busy: 'A sound-sticker test is already running. No sticker was sent for this request.',
                cooldown: 'Please wait 60 seconds between sound-sticker tests in this chat. No sticker was sent.'
            }[decision];
            await message.reply(text);
            return;
        }
        active = true;
        lastByChat.set(message.chat, now);
        if (lastByChat.size > 500) lastByChat.delete(lastByChat.keys().next().value);
        try {
            log.info({ stage: 'prepare' }, 'Diagnostic stage.');
            const options = { upload: sock.waUploadToServer, mediaUploadTimeoutMs: 20000 };
            const sticker = await prepareWAMessageMedia({
                sticker: await readFile(new URL('./.sound-test.webp', import.meta.url)), width: 512, height: 512
            }, options);
            const audio = await prepareWAMessageMedia({
                audio: await readFile(new URL('./.sound-test.ogg', import.meta.url)),
                mimetype: 'audio/ogg; codecs=opus', seconds: 1, ptt: true, waveform: Buffer.alloc(64)
            }, options);
            sticker.stickerMessage.audioMessage = audio.audioMessage;
            const built = generateWAMessageFromContent(message.chat, sticker, { userJid: sock.user.id });
            log.info({ stage: 'relay' }, 'Diagnostic stage.');
            await sock.relayMessage(message.chat, built.message, { messageId: built.key.id });
            log.info({ stage: 'relayed' }, 'Diagnostic stage.');
        } finally {
            active = false; // no automatic media retry after success or failure
        }
    }
};
