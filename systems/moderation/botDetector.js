/**
 * Detects messages sent by other WhatsApp bots. Pure: no I/O.
 *
 * Signals (points; THRESHOLD or more = bot):
 *   +3 message types a normal WhatsApp app cannot send (buttons, lists, templates,
 *      native-flow / interactive cards, carousels)
 *   +3 message ids only bot libraries make: "BAE5" + 12 hex (old Baileys),
 *      "3EB0" + 36 hex (Baileys generateMessageID)
 *   +2 a reply to someone else's command (".menu", "!help"...) within 4 seconds
 *   +1 "3EB0" + 18 hex: new Baileys, BUT WhatsApp Web / Desktop use the same shape,
 *      so it never flags anyone alone
 *
 * A sender is remembered as a bot once flagged (see knownBots.js), so later
 * plain-text messages from it are caught too.
 */

export const THRESHOLD = 3;
const REPLY_WINDOW_MS = 4000;
const COMMAND_RE = /^[.!#/$%&*+,;=?@^~-][\p{L}\p{N}]/u;

const BOT_ONLY_TYPES = new Set([
    'buttonsMessage', 'listMessage', 'templateMessage', 'interactiveMessage',
    'highlyStructuredMessage'
]);

export const idSignal = (id = '') => {
    const s = String(id);
    if (/^BAE5[0-9A-F]{12}$/.test(s)) return { points: 3, why: 'bot library message id' };
    if (/^3EB0[0-9A-F]{36}$/.test(s)) return { points: 3, why: 'bot library message id' };
    if (/^3EB0[0-9A-F]{18}$/.test(s)) return { points: 1, why: 'web-style message id' };
    return { points: 0 };
};

/** True when the raw content is something only a bot can send. */
export const isBotOnlyContent = (message) => {
    if (BOT_ONLY_TYPES.has(message?.type)) return true;
    const content = message?.raw?.message || {};
    const inner = content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content.documentWithCaptionMessage?.message || content.ephemeralMessage?.message || {};
    return Boolean(inner.interactiveMessage || inner.buttonsMessage || inner.listMessage || inner.templateMessage);
};

/** Remembers recent command messages per group, to spot instant replies to them. */
export class CommandTracker {
    constructor({ windowMs = REPLY_WINDOW_MS, max = 500 } = {}) {
        this.windowMs = windowMs;
        this.max = max;
        this.recent = new Map(); // `${chat}|${id}` → { at, author }
    }

    record(message, now = Date.now()) {
        if (!COMMAND_RE.test(message?.text || '')) return;
        this.recent.set(`${message.chat}|${message.id}`, { at: now, author: message.senderNumber || message.sender });
        if (this.recent.size > this.max) this.recent.delete(this.recent.keys().next().value);
    }

    /** True when `message` quotes another person's command sent within the window. */
    isInstantReply(message, now = Date.now()) {
        const id = message?.quoted?.id;
        if (!id) return false;
        const hit = this.recent.get(`${message.chat}|${id}`);
        if (!hit) return false;
        const author = message.senderNumber || message.sender;
        return hit.author !== author && now - hit.at <= this.windowMs;
    }
}

/** @returns {{ score: number, reasons: string[], bot: boolean }} */
export const scoreMessage = (message, tracker, now = Date.now()) => {
    const reasons = [];
    let score = 0;
    if (isBotOnlyContent(message)) { score += 3; reasons.push('buttons / interactive message'); }
    const id = idSignal(message?.id);
    if (id.points) { score += id.points; reasons.push(id.why); }
    if (tracker?.isInstantReply(message, now)) { score += 2; reasons.push('instant reply to a command'); }
    return { score, reasons, bot: score >= THRESHOLD };
};
