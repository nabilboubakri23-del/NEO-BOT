import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { MAX_PER_MESSAGE, resetStamp, saveStamp, savedStamp, sendStamp, undoStamps } from '../../systems/media/stickerStamp.js';

/**
 * .stamp — put a sticker ON someone's message (WhatsApp sticker annotation).
 *
 *   .stamp              (reply to a message)   stamp it with your sticker
 *   .stamp set          (reply to a sticker)   save that sticker as your stamp
 *   .stamp show                                 see your current stamp
 *   .stamp reset                                go back to the bot's stamp
 *   .stamp undo [n]     (reply: that message's stamps; else your last n in this chat, max 5)
 *
 * One stamp per command, at most 3 bot stamps per message: a stamp, not a flood.
 * Clients that do not support sticker annotations show it as a normal sticker.
 */

const P = () => config.bot.prefix;
const owner = (m) => m.senderNumber || m.sender;

const help = (m) => m.reply(box('STICKER STAMP', [
    'Put a sticker on top of a message.',
    '',
    `🏷️ ${P()}stamp  → reply to a message`,
    `💾 ${P()}stamp set  → reply to a sticker to make it yours`,
    `👀 ${P()}stamp show  → your current stamp`,
    `♻️ ${P()}stamp reset  → back to the bot's stamp`,
    `🗑️ ${P()}stamp undo  → remove your last stamp`,
    '',
    `One stamp per command, max ${MAX_PER_MESSAGE} per message.`
]));

const set = async (sock, m) => {
    const media = findMedia(m, ['sticker']);
    if (!media) throw new UserError(`Reply to a sticker with ${P()}stamp set`);
    const webp = await downloadMedia(sock, media, { maxBytes: 1024 * 1024 });
    await saveStamp(owner(m), webp);
    await m.react?.('💾');
    return m.reply(`✅ Saved as your stamp. Reply to any message with ${P()}stamp`);
};

const show = async (sock, m) => {
    const saved = await savedStamp(owner(m));
    if (!saved) return m.reply(`You use the bot's stamp. Save your own: reply to a sticker with ${P()}stamp set`);
    await sock.sendMessage(m.chat, { sticker: saved.webp }, { quoted: m.raw });
    return m.reply(`👆 Your stamp, saved ${saved.savedAt.slice(0, 10)}.`);
};

const undo = async (sock, m, countText) => {
    const count = Math.min(5, Math.max(1, parseInt(countText, 10) || 1));
    const parentId = m.quoted?.id || null;
    const { found, removed } = await undoStamps(sock, m.chat, { parentId, owner: owner(m), count });
    if (!found) throw new UserError(parentId ? 'You have no stamps on that message.' : 'You have no recent stamps in this chat.');
    return m.reply(removed ? `🗑️ Removed ${removed} stamp${removed > 1 ? 's' : ''}.` : '❌ WhatsApp refused to delete them (too old or already gone).');
};

const stamp = async (sock, m) => {
    if (!m.quoted?.key?.id) return help(m);
    const key = { ...m.quoted.key };
    if (!key.participant && m.isGroup) key.participant = m.quoted.sender;
    await sendStamp(sock, m.chat, key, owner(m));
    return m.react?.('🏷️');
};

export default {
    name: 'stamp',
    aliases: ['stickerstamp', 'ختم', 'س'],
    category: 'media',
    permission: 'public',
    description: 'Put a sticker on top of a message (sticker annotation). Save your own stamp with "set".',
    usage: '(reply to a message)  |  set (reply to a sticker)  |  show  |  reset  |  undo [n]',
    examples: ['stamp', 'stamp set', 'stamp undo'],
    cooldown: 5,
    minArgs: 0,
    async execute(sock, m, args) {
        const [action = '', extra = ''] = args.map((a) => String(a).toLowerCase());
        if (/^(set|save|حفظ|س1)$/.test(action)) return set(sock, m);
        if (/^(show|view|عرض)$/.test(action)) return show(sock, m);
        if (/^(reset|default|افتراضي)$/.test(action)) {
            const had = await resetStamp(owner(m));
            return m.reply(had ? "♻️ Back to the bot's stamp." : "You already use the bot's stamp.");
        }
        if (/^(undo|delete|del|remove|مسح|حذف)$/.test(action)) return undo(sock, m, extra);
        if (/^(help|مساعدة)$/.test(action)) return help(m);
        if (action) throw new UserError(`Unknown option "${action.slice(0, 20)}". Send ${P()}stamp for help.`);
        return stamp(sock, m);
    }
};
