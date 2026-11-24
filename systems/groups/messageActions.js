import { generateWAMessageFromContent } from 'baileys';

/**
 * Chat-level actions on an existing message:
 *   pin  – pin for everyone for 24 h, 7 d or 30 d (WhatsApp's only durations), or unpin
 *   keep – keep a message in a disappearing-messages chat, or undo it
 * WhatsApp applies them like a person's tap; group settings can limit them to admins.
 */

export const PIN_DURATIONS = Object.freeze({ '24h': 86_400, '1d': 86_400, '7d': 604_800, '1w': 604_800, '30d': 2_592_000, '1m': 2_592_000 });
export const PIN_LABEL = Object.freeze({ 86_400: '24 hours', 604_800: '7 days', 2_592_000: '30 days' });

/** "7d" / "7" / "week"… → seconds (default 7 days, WhatsApp's own default). */
export const parsePinDuration = (text) => {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return 604_800;
    if (PIN_DURATIONS[t]) return PIN_DURATIONS[t];
    if (['day', 'يوم', '24'].includes(t)) return 86_400;
    if (['week', 'اسبوع', 'أسبوع', '7'].includes(t)) return 604_800;
    if (['month', 'شهر', '30'].includes(t)) return 2_592_000;
    return null;
};

export const pinMessage = (sock, chat, key, seconds) => sock.sendMessage(chat, { pin: key, type: 1, time: seconds });
export const unpinMessage = (sock, chat, key) => sock.sendMessage(chat, { pin: key, type: 2 });

/** KeepInChatMessage: keepType 1 = keep for all, 2 = undo. Baileys has no helper, so it is relayed directly. */
export const keepMessage = async (sock, chat, key, keep = true) => {
    const content = { keepInChatMessage: { key, keepType: keep ? 1 : 2, timestampMs: Date.now() } };
    const msg = generateWAMessageFromContent(chat, content, { userJid: sock.user?.id });
    await sock.relayMessage(chat, msg.message, { messageId: msg.key.id });
    return msg;
};
