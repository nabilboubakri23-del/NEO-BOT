import { readFile } from 'node:fs/promises';
import { child } from '../../core/logger.js';
import { sendTextAudioCard } from './.text-audio-card.js';

const log = child('text-audio-test');
const lastByChat = new Map();
let active = false;
export const TEST_TEXT = 'Text and audio in one card. If your app supports it, play the one-second tone below.';

export function textAudioDecision(chat, args, busy, last, now) {
    if (!/^(?:\d+@(s\.whatsapp\.net|lid)|\d+(?:-\d+)?@g\.us)$/.test(String(chat || ''))) return 'unsupported_chat';
    if (args.length) return 'invalid_input';
    if (busy) return 'busy';
    if (last !== undefined && now - last < 60000) return 'cooldown';
    return 'ready';
}

export default {
    name: 'textaudiotest',
    category: 'media',
    description: 'Test one interactive text card with embedded audio. Client support varies.',
    usage: '',
    permission: 'public',
    cooldown: 60,
    async execute(sock, message, args) {
        const now = Date.now();
        const decision = textAudioDecision(message.chat, args, active, lastByChat.get(message.chat), now);
        log.info({ decision }, 'Text-audio diagnostic decision.');
        if (decision !== 'ready') {
            if (decision === 'unsupported_chat') return;
            await message.reply({
                invalid_input: 'Use .textaudiotest without arguments. No card was sent.',
                busy: 'A text-audio test is already running. No card was sent for this request.',
                cooldown: 'Please wait 60 seconds between text-audio tests in this chat. No card was sent.'
            }[decision]);
            return;
        }
        active = true;
        lastByChat.set(message.chat, now);
        if (lastByChat.size > 500) lastByChat.delete(lastByChat.keys().next().value);
        try {
            log.info({ stage: 'prepare' }, 'Text-audio diagnostic stage.');
            const audio = await readFile(new URL('./.text-audio-test.ogg', import.meta.url));
            await sendTextAudioCard(sock, message.chat, TEST_TEXT, audio);
            log.info({ stage: 'relayed' }, 'Text-audio diagnostic stage.');
        } finally {
            active = false;
        }
    }
};
