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
import { learnRankIdentity } from '../systems/permissions/rankStore.js';
import { isDuplicate, isOwnMessage, rememberOwnMessage } from '../systems/security/dedupe.js';
import { getSetting } from '../systems/settings/settingsStore.js';
import { trackMessage } from '../systems/users/userStore.js';
import { countMessage } from '../systems/stats/statsStore.js';
import events from './events.js';
import { isSelf } from '../utils/targets.js';
import governor from '../systems/antiban/index.js';

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

/**
 * Text a message carries outside its body: poll question and options, event details,
 * location name, document file name, contact names. Scanned by moderation only.
 */
const extractExtraText = (content, type) => {
    const c = content[type] || {};
    switch (type) {
        case 'pollCreationMessage':
        case 'pollCreationMessageV2':
        case 'pollCreationMessageV3':
        case 'pollCreationMessageV5':
            return [c.name, ...(c.options || []).map((o) => o.optionName)].filter(Boolean).join('\n');
        case 'eventMessage': return [c.name, c.description, c.location?.name].filter(Boolean).join('\n');
        case 'locationMessage':
        case 'liveLocationMessage': return [c.name, c.address, c.comment, c.caption].filter(Boolean).join('\n');
        case 'documentMessage': return c.fileName || '';
        case 'contactMessage': return c.displayName || '';
        case 'contactsArrayMessage': return [c.displayName, ...(c.contacts || []).map((x) => x.displayName)].filter(Boolean).join('\n');
        case 'groupInviteMessage': return [c.groupName, c.caption].filter(Boolean).join('\n');
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
              text: (extractText(context.quotedMessage, getContentType(context.quotedMessage)) || '').trim(),
              // Key of the replied message: lets commands delete it or download its media.
              key: {
                  remoteJid: chat,
                  id: context.stanzaId,
                  fromMe: isSelf(sock, context.participant || (isGroup ? '' : chat)),
                  ...(isGroup && context.participant ? { participant: context.participant } : {})
              }
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
        extraText: extractExtraText(content, type),
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

const EDIT_TYPE = 14; // proto.Message.ProtocolMessage.Type.MESSAGE_EDIT

/**
 * An edit arrives as a protocolMessage pointing at the original message. Returns a
 * normal message object holding the NEW content and the ORIGINAL key (so moderation
 * deletes the edited message itself), or null when this is not an edit.
 */
const serializeEdit = (sock, raw) => {
    const content = normalizeMessageContent(raw.message);
    const proto = content?.protocolMessage;
    if (!proto || proto.type !== EDIT_TYPE || !proto.editedMessage || !proto.key) return null;
    const original = {
        ...proto.key,
        remoteJid: raw.key.remoteJid,
        ...(raw.key.participant ? { participant: raw.key.participant } : {}),
        ...(raw.key.participantAlt ? { participantAlt: raw.key.participantAlt } : {})
    };
    const message = serialize(sock, { ...raw, key: { ...raw.key, ...original }, message: proto.editedMessage });
    if (message) message.isEdit = true;
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
            if (isJidStatusBroadcast(jid) || isJidBroadcast(jid)) continue;
            // Channels: only the owner's own command posts (e.g. ".jid" in your channel) are handled.
            if (isJidNewsletter(jid) && !raw.key.fromMe) continue;
            if (isDuplicate(raw.key.id)) continue;
            governor.noteInbound(jid); // this chat wrote to us: replies are not cold messages

            const ts = Number(raw.messageTimestamp || 0);
            if (ts && ts < BOOT_TIME - MAX_AGE_SECONDS) continue;

            // Edited messages are re-checked by moderation (plugins listen on 'message:edit'),
            // but never run commands or count as new activity.
            const edit = serializeEdit(sock, raw);
            if (edit) {
                await resolvePhoneNumber(sock, edit);
                if (!edit.fromMe) await events.barrier('message:edit', { sock, message: edit });
                continue;
            }

            const message = serialize(sock, raw);
            if (!message) continue;
            await resolvePhoneNumber(sock, message);
            if (!message.fromMe && isOwner(message)) await learnIdentity(message).catch(() => {});
            if (!message.fromMe) learnRankIdentity(message);

            countMessage();
            if (!message.fromMe && getSetting('autoRead')) sock.readMessages?.([raw.key]).catch(() => {});

            // Plugins see every message (auto-reply, anti-link, counters...).
            // A hook returning false stops the message from being routed further.
            if (!message.fromMe && !(await events.barrier('message', { sock, message }))) continue;

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
