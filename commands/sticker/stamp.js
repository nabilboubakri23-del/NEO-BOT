import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { makeSticker } from '../../systems/media/sticker.js';
import { LIMITS, resetStamp, saveStamp, savedStamp, sendStamps, undoStamps } from '../../systems/media/stickerStamp.js';
import { removeBackground } from '../../systems/media/backgroundRemoval.js';
import { isOwner } from '../../systems/owners/ownerStore.js';

/**
 * .stamp — put a sticker ON someone's message (WhatsApp sticker annotation).
 *
 *   .stamp [n]          (reply to a message)   n stamps (users max 3, owners max 15)
 *   .stamp set [raw]    (reply to a sticker)   save it as your stamp, background removed (raw keeps it)
 *   .stamp show                                 see your current stamp
 *   .stamp reset                                go back to the bot's stamp
 *   .stamp undo [n]     (reply: that message's stamps; else your last n in this chat, max 5)
 *
 * Caps per command and per message (users 3, owners 15), sent 0.7 s apart: a stamp, not a flood.
 * Where the stickers sit on the message is decided by the WhatsApp app, not the bot.
 * Clients that do not support sticker annotations show it as a normal sticker.
 */

const P = () => config.bot.prefix;
const owner = (m) => m.senderNumber || m.sender;
const limitOf = (m) => (isOwner(m) ? LIMITS.owner : LIMITS.user);

const help = (m) => m.reply(box('STICKER STAMP', [
    'Put stickers on top of a message.',
    '',
    `🏷️ ${P()}stamp  → reply to a message`,
    `🔢 ${P()}stamp 3  → several at once (max ${limitOf(m)} for you)`,
    `💾 ${P()}stamp set  → reply to a sticker, background removed`,
    `🖼️ ${P()}stamp set raw  → keep the background`,
    `👀 ${P()}stamp show  → your current stamp`,
    `♻️ ${P()}stamp reset  → back to the bot's stamp`,
    `🗑️ ${P()}stamp undo  → remove your last stamp`,
    '',
    `Users max ${LIMITS.user}, owners max ${LIMITS.owner} per message.`
]));

const NOTE = {
    animated: 'Animated sticker: saved as it is (background removal works on still stickers).',
    'no-background': 'No plain background found: saved as it is.',
    'nothing-left': 'Removing the background would erase the sticker: saved as it is.',
    decode: 'Could not read the picture for background removal: saved as it is.'
};

const set = async (sock, m, mode) => {
    const media = findMedia(m, ['sticker', 'image']);
    if (!media) throw new UserError(`Reply to a sticker with ${P()}stamp set`);
    await m.react?.('⏳');
    let webp = await downloadMedia(sock, media, { maxBytes: 2 * 1024 * 1024 });
    if (media.kind !== 'sticker') webp = await makeSticker(webp, { kind: 'image' });
    let note = 'Background kept.';
    if (!/^(raw|keep|خام)$/.test(mode)) {
        const result = await removeBackground(webp);
        webp = result.webp;
        note = result.changed ? '✂️ Background removed.' : NOTE[result.reason] || 'Saved as it is.';
    }
    await saveStamp(owner(m), webp);
    await m.react?.('💾');
    return m.reply(`✅ Saved as your stamp. ${note}\nReply to any message with ${P()}stamp`);
};

const show = async (sock, m) => {
    const saved = await savedStamp(owner(m));
    if (!saved) return m.reply(`You use the bot's stamp. Save your own: reply to a sticker with ${P()}stamp set`);
    await sock.sendMessage(m.chat, { sticker: saved.webp }, { quoted: m.raw });
    return m.reply(`👆 Your stamp, saved ${saved.savedAt.slice(0, 10)}.`);
};

const undo = async (sock, m, countText) => {
    const count = Math.min(limitOf(m), Math.max(1, parseInt(countText, 10) || 1));
    const parentId = m.quoted?.id || null;
    const { found, removed } = await undoStamps(sock, m.chat, { parentId, owner: owner(m), count });
    if (!found) throw new UserError(parentId ? 'You have no stamps on that message.' : 'You have no recent stamps in this chat.');
    return m.reply(removed ? `🗑️ Removed ${removed} stamp${removed > 1 ? 's' : ''}.` : '❌ WhatsApp refused to delete them (too old or already gone).');
};

const stamp = async (sock, m, countText) => {
    if (!m.quoted?.key?.id) return help(m);
    const key = { ...m.quoted.key };
    if (!key.participant && m.isGroup) key.participant = m.quoted.sender;
    const limit = limitOf(m);
    const { sent, capped } = await sendStamps(sock, m.chat, key, owner(m), { count: parseInt(countText, 10) || 1, limit });
    await m.react?.('🏷️');
    if (capped) return m.reply(`🏷️ Sent ${sent} (your limit is ${limit} per message).`);
};

export default {
    name: 'stamp',
    aliases: ['stickerstamp', 'ختم', 'س'],
    category: 'media',
    permission: 'public',
    description: 'Put a sticker on top of a message (sticker annotation). Save your own stamp with "set".',
    usage: '[n] (reply to a message)  |  set [raw] (reply to a sticker)  |  show  |  reset  |  undo [n]',
    examples: ['stamp', 'stamp 3', 'stamp set', 'stamp set raw', 'stamp undo'],
    cooldown: 5,
    minArgs: 0,
    async execute(sock, m, args) {
        const [action = '', extra = ''] = args.map((a) => String(a).toLowerCase());
        if (/^(set|save|حفظ|س1)$/.test(action)) return set(sock, m, extra);
        if (/^(show|view|عرض)$/.test(action)) return show(sock, m);
        if (/^(reset|default|افتراضي)$/.test(action)) {
            const had = await resetStamp(owner(m));
            return m.reply(had ? "♻️ Back to the bot's stamp." : "You already use the bot's stamp.");
        }
        if (/^(undo|delete|del|remove|مسح|حذف)$/.test(action)) return undo(sock, m, extra);
        if (/^(help|مساعدة)$/.test(action)) return help(m);
        if (/^\d{1,3}$/.test(action)) return stamp(sock, m, action);
        if (action) throw new UserError(`Unknown option "${action.slice(0, 20)}". Send ${P()}stamp for help.`);
        return stamp(sock, m, '1');
    }
};
