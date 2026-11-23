import { readFile } from 'node:fs/promises';
import { generateWAMessageFromContent, jidNormalizedUser, prepareWAMessageMedia } from 'baileys';
import { getOwners } from '../../systems/owners/ownerStore.js';
import { stickerAudioReady } from '../../systems/security/stickerAudioProtocol.js';

const PRIVATE = /^\d+@(s\.whatsapp\.net|lid)$/;
const normalize = (value) => jidNormalizedUser(String(value || ''));
let attempted = false;

export function allowedDiagnosticChat(sock, message, main) {
    const chat = normalize(message.chat);
    if (message.isGroup || !PRIVATE.test(chat) || message.chat !== message.raw?.key?.remoteJid) return false;
    if (message.fromMe) {
        return [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalize).includes(chat);
    }
    if (normalize(message.sender) !== chat) return false;
    const number = String(message.senderNumber || '');
    const lid = String(message.senderLid || '');
    return Boolean((main.number && main.number === number) || (main.lid && main.lid === lid));
}

export default {
    name: 'soundstickertest',
    category: 'sticker',
    description: 'Private main-owner diagnostic: blue sticker with a one-second tone.',
    usage: '',
    permission: 'creator',
    scope: 'private',
    hidden: true,
    cooldown: 60,
    async execute(sock, message, args) {
        // Do not rely on configurable rank overrides, and never reply in an
        // outgoing chat with another person. Linked-account self-chat is OK.
        if (!allowedDiagnosticChat(sock, message, getOwners().owner)) return;
        if (args.length || !stickerAudioReady() || attempted) return;
        attempted = true; // one attempt per process; no automatic re-send
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
        await sock.relayMessage(message.chat, built.message, { messageId: built.key.id });
    }
};
