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

/** Returns a copy of the content with the channel-forward context added (or the content unchanged). */
export const decorate = (jid, content) => {
    if (!config.channel.jid || !content || typeof content !== 'object') return content;
    if (String(jid).endsWith('@newsletter') || String(jid) === 'status@broadcast') return content;
    if (SKIP_KEYS.some((k) => k in content) || !CONTENT_KEYS.some((k) => k in content)) return content;
    const setting = (key) => {
        try {
            return getSetting(key);
        } catch {
            return true; // settings not loaded yet → default on
        }
    };
    const forward = setting('channelForward');
    // Preview card only on text messages (media already has its own preview).
    const card = setting('thumbnailCard') && 'text' in content && !content.contextInfo?.externalAdReply ? randomCard() : null;
    if (!forward && !card) return content;
    return {
        ...content,
        contextInfo: {
            ...(content.contextInfo || {}),
            ...(forward ? { isForwarded: true, forwardingScore: 1, forwardedNewsletterMessageInfo: channelInfo() } : {}),
            ...(card ? { externalAdReply: card } : {})
        }
    };
};

/** Wraps sock.sendMessage once so every message goes through decorate(). */
export const applyChannelForward = (sock) => {
    if (sock.__channelForward) return sock;
    const send = sock.sendMessage.bind(sock);
    sock.sendMessage = (jid, content, options) => send(jid, decorate(jid, content), options);
    sock.__channelForward = true;
    return sock;
};
