import {
    getContentType,
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    isJidStatusBroadcast,
    jidNormalizedUser,
    normalizeMessageContent
} from 'baileys';
import config from '../config/config.js';
import commandHandler from './commandHandler.js';
import { child } from './logger.js';
import { describeError } from '../utils/errors.js';
import { isOwner, learnIdentity } from '../systems/owners/ownerStore.js';
import { isDuplicate, isOwnMessage, rememberOwnMessage } from '../systems/security/dedupe.js';
import { getSetting } from '../systems/settings/settingsStore.js';
import { trackMessage } from '../systems/users/userStore.js';
import { countMessage } from '../systems/stats/statsStore.js';

const log = child('messages');

const BOOT_TIME = Math.floor(Date.now() / 1000);
const MAX_AGE_SECONDS = 60; // ignore backlog delivered after downtime

// Kept here so existing imports keep working; the logic lives in systems/security/dedupe.js.
export { rememberOwnMessage };

const extractText = (content, type) => {
    switch (type) {
        case 'conversation': return content.conversation;
        case 'extendedTextMessage': return content.extendedTextMessage?.text;
        case 'imageMessage': return content.imageMessage?.caption;
        case 'videoMessage': return content.videoMessage?.caption;
        case 'documentMessage': return content.documentMessage?.caption;
        default: return '';
    }
};

/** Returns the selected id of an interactive response, or null. */
const extractSelection = (content, type) => {
    switch (type) {
        case 'interactiveResponseMessage': {
            const params = content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
            if (!params) return null;
            try {
                return JSON.parse(params).id ?? null;
            } catch {
                return null;
            }
        }
        case 'listResponseMessage': return content.listResponseMessage?.singleSelectReply?.selectedRowId ?? null;
        case 'buttonsResponseMessage': return content.buttonsResponseMessage?.selectedButtonId ?? null;
        case 'templateButtonReplyMessage': return content.templateButtonReplyMessage?.selectedId ?? null;
        default: return null;
    }
};

const MEDIA_TYPES = {
    imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio',
    documentMessage: 'document', stickerMessage: 'sticker'
};

/** Normalizes a raw Baileys message into a NEO BOT message object. */
const serialize = (sock, raw) => {
    const content = normalizeMessageContent(raw.message);
    if (!content) return null;
    const type = getContentType(content);
    if (!type || type === 'protocolMessage' || type === 'reactionMessage') return null;

    const chat = raw.key.remoteJid;
    const isGroup = isJidGroup(chat);
    const sender = jidNormalizedUser(isGroup ? raw.key.participant : chat);
    // v7 may address users by LID; the *Alt fields carry the phone-number JID when known.
    const senderPn = jidNormalizedUser(isGroup ? raw.key.participantAlt || raw.key.participant : raw.key.remoteJidAlt || chat);

    let mediaType = MEDIA_TYPES[type] || null;
    const context = content[type]?.contextInfo || null;
    const quoted = context?.quotedMessage
        ? {
              id: context.stanzaId,
              sender: context.participant ? jidNormalizedUser(context.participant) : chat,
              message: context.quotedMessage,
              type: getContentType(context.quotedMessage),
              text: (extractText(context.quotedMessage, getContentType(context.quotedMessage)) || '').trim()
          }
        : null;
    if (type === 'audioMessage' && content.audioMessage?.ptt) mediaType = 'voice';

    const message = {
        raw,
        id: raw.key.id,
        chat,
        isGroup,
        sender,
        fromMe: Boolean(raw.key.fromMe),
        senderNumber: (senderPn || '').split('@')[0],
        pushName: raw.pushName || '',
        type,
        mediaType,
        text: (extractText(content, type) || '').trim(),
        selectionId: extractSelection(content, type),
        quoted,
        mentions: (context?.mentionedJid || []).map((j) => jidNormalizedUser(j)),
        timestamp: Number(raw.messageTimestamp || 0),
        receivedAt: Date.now(),
        reply: (payload) => sock.sendMessage(chat, typeof payload === 'string' ? { text: payload } : payload, { quoted: raw }),
        send: (payload) => sock.sendMessage(chat, typeof payload === 'string' ? { text: payload } : payload),
        react: (emoji) => sock.sendMessage(chat, { react: { text: emoji, key: raw.key } })
    };
    return message;
};

/**
 * v7 can address a sender only by LID (e.g. in groups). When no phone-number
 * JID came with the message, ask the library's LID mapping store for it.
 */
const resolvePhoneNumber = async (sock, message) => {
    const jid = message.isGroup ? message.raw.key.participantAlt || message.raw.key.participant : message.raw.key.remoteJidAlt || message.chat;
    message.senderLid = message.sender?.endsWith('@lid') ? message.sender.split('@')[0] : '';
    if (!String(jid || '').endsWith('@lid')) return;
    try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
        if (pn) message.senderNumber = jidNormalizedUser(pn).split('@')[0];
    } catch (error) {
        log.debug(`LID lookup failed: ${describeError(error)}`);
    }
};

/**
 * messages.upsert entry point.
 * Incoming → serialize → filter → command / interaction detection → commandHandler.
 */
export const handleUpsert = async (sock, { messages, type }) => {
    if (type !== 'notify') return; // only fresh incoming notifications

    for (const raw of messages) {
        try {
            if (!raw?.message || !raw.key?.remoteJid) continue;
            // The linked account's own messages (e.g. the owner typing in "Message yourself")
            // are accepted, but never the bot's own replies.
            if (raw.key.fromMe && isOwnMessage(raw.key.id)) continue;
            const jid = raw.key.remoteJid;
            if (isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) continue;
            if (isDuplicate(raw.key.id)) continue;

            const ts = Number(raw.messageTimestamp || 0);
            if (ts && ts < BOOT_TIME - MAX_AGE_SECONDS) continue;

            const message = serialize(sock, raw);
            if (!message) continue;
            await resolvePhoneNumber(sock, message);
            if (!message.fromMe && isOwner(message)) await learnIdentity(message).catch(() => {});

            countMessage();
            if (!message.fromMe && getSetting('autoRead')) sock.readMessages?.([raw.key]).catch(() => {});

            const isCommand = message.text.startsWith(config.bot.prefix);
            if (message.fromMe && !message.selectionId && !isCommand) continue;

            if (message.selectionId) {
                await commandHandler.handleSelection(sock, message);
            } else if (isCommand) {
                await commandHandler.handleCommand(sock, message);
            } else if (!message.fromMe) {
                trackMessage(message); // activity stats; commands are tracked by the engine
            }
        } catch (error) {
            log.error(`Message processing failed: ${describeError(error)}`);
        }
    }
};
