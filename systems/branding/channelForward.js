import { proto, generateMessageIDV2 } from 'baileys';
import config from '../../config/config.js';
import { getSetting } from '../settings/settingsStore.js';
import { randomCard } from './thumbnailCard.js';

/**
 * Makes every outgoing bot message look "Forwarded from channel": WhatsApp then shows
 * the channel name (tappable, with its picture) above the message.
 *
 * Channel: NEWSLETTER_JID / NEWSLETTER_NAME in .env. Toggle: ".settings set channelForward off".
 */

const CONTENT_KEYS = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'caption'];
const SKIP_KEYS = ['react', 'delete', 'edit', 'poll', 'pin', 'forward', 'protocolMessage', 'disappearingMessagesInChat'];

export const channelInfo = () => ({
    newsletterJid: config.channel.jid,
    newsletterName: config.channel.name,
    serverMessageId: -1
});

const readSetting = (key) => {
    try {
        return getSetting(key);
    } catch {
        return true; // settings not loaded yet → default on
    }
};

const isSkippedTarget = (jid) => String(jid).endsWith('@newsletter') || String(jid) === 'status@broadcast';

// Card used by each sent message id, so an edit keeps the same picture.
const cardById = new Map();
const MAX_REMEMBERED = 300;
const rememberCard = (id, card) => {
    if (!id || !card) return;
    cardById.set(id, card);
    if (cardById.size > MAX_REMEMBERED) cardById.delete(cardById.keys().next().value);
};

/** Builds the branding contextInfo fields (forward header + picture card). */
const brandingContext = (existing = {}, cardFor) => {
    const forward = readSetting('channelForward');
    const card = readSetting('thumbnailCard') && !existing.externalAdReply ? cardFor() : null;
    if (!forward && !card) return null;
    return {
        ctx: {
            ...existing,
            ...(forward ? { isForwarded: true, forwardingScore: 1, forwardedNewsletterMessageInfo: channelInfo() } : {}),
            ...(card ? { externalAdReply: card } : {})
        },
        card
    };
};

/**
 * Returns { content, card }: a copy of the content with the branding context added.
 * Text edits are decorated too (WhatsApp replaces the whole message on edit, so the
 * card must be sent again), reusing the card of the original message.
 */
export const decorateWithCard = (jid, content) => {
    if (!config.channel.jid || !content || typeof content !== 'object' || isSkippedTarget(jid)) return { content };
    const isTextEdit = 'edit' in content && 'text' in content;
    if (!isTextEdit && (SKIP_KEYS.some((k) => k in content) || !CONTENT_KEYS.some((k) => k in content))) return { content };
    // Preview card only on text messages (media already has its own preview).
    const cardFor = () => {
        if (!('text' in content)) return null;
        if (isTextEdit) return cardById.get(content.edit?.id) || randomCard();
        return randomCard();
    };
    const branded = brandingContext(content.contextInfo || {}, cardFor);
    if (!branded) return { content };
    if (isTextEdit && branded.card) rememberCard(content.edit?.id, branded.card);
    return { content: { ...content, contextInfo: branded.ctx }, card: branded.card };
};

export const decorate = (jid, content) => decorateWithCard(jid, content).content;

/** Finds the interactiveMessage inside a built (Button builder) message, if any. */
const findInteractive = (msg) => {
    if (!msg || typeof msg !== 'object') return null;
    if (msg.interactiveMessage) return msg.interactiveMessage;
    for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage']) {
        const inner = msg[wrapper]?.message;
        if (inner?.interactiveMessage) return inner.interactiveMessage;
    }
    return null;
};

/** Adds the branding to interactive (button / list) messages that are relayed directly. */
export const decorateRelayed = (jid, msg) => {
    if (!config.channel.jid || isSkippedTarget(jid)) return msg;
    const interactive = findInteractive(msg);
    if (!interactive || interactive.contextInfo?.forwardedNewsletterMessageInfo) return msg;
    const branded = brandingContext(interactive.contextInfo || {}, () => (interactive.header?.hasMediaAttachment ? null : randomCard()));
    if (branded) interactive.contextInfo = branded.ctx;
    return msg;
};

/** Sends a text edit whose new content keeps the branding context. */
const sendBrandedEdit = async (sock, relay, jid, content) => {
    const message = {
        protocolMessage: {
            key: content.edit,
            type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            timestampMs: Date.now(),
            editedMessage: { extendedTextMessage: { text: content.text, contextInfo: content.contextInfo } }
        }
    };
    const id = generateMessageIDV2(sock.user?.id);
    await relay(jid, message, { messageId: id, additionalAttributes: { edit: String(jid).endsWith('@newsletter') ? '3' : '1' } });
    return { key: { remoteJid: jid, fromMe: true, id }, message };
};

/** Wraps sock.sendMessage and sock.relayMessage once so every message gets the branding. */
export const applyChannelForward = (sock) => {
    if (sock.__channelForward) return sock;
    const send = sock.sendMessage.bind(sock);
    const relay = sock.relayMessage?.bind(sock);
    sock.sendMessage = async (jid, content, options) => {
        const { content: decorated, card } = decorateWithCard(jid, content);
        // Baileys puts contextInfo on the protocolMessage of an edit, where WhatsApp ignores it.
        // Build the edit ourselves so the card/header sit inside the edited message.
        if (relay && content?.edit && 'text' in content && decorated.contextInfo) {
            return sendBrandedEdit(sock, relay, jid, decorated);
        }
        const sent = await send(jid, decorated, options);
        if (card && !('edit' in (content || {}))) rememberCard(sent?.key?.id, card);
        return sent;
    };
    if (relay) sock.relayMessage = (jid, msg, opts) => relay(jid, decorateRelayed(jid, msg), opts);
    sock.__channelForward = true;
    return sock;
};
