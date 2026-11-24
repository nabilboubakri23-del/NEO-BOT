import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { quotedKey } from '../../utils/quotedKey.js';
import { PIN_LABEL, parsePinDuration, pinMessage, unpinMessage } from '../../systems/groups/messageActions.js';
import { allowedToAct } from './.messageActionAccess.js';

const P = () => config.bot.prefix;

const help = (m) => m.reply(box('PIN', [
    'Reply to a message:',
    `${P()}pin        → pin for 7 days`,
    `${P()}pin 24h    → 24 hours`,
    `${P()}pin 30d    → 30 days`,
    `${P()}unpin      → remove the pin`,
    '',
    'WhatsApp only offers 24 h, 7 d and 30 d.'
]));

export default {
    name: 'pin',
    aliases: ['unpin', 'تثبيت', 'الغاء_تثبيت'],
    category: 'group',
    permission: 'public',
    description: 'Pin a replied message for everyone (24h / 7d / 30d) or unpin it.',
    usage: '[24h|7d|30d]  (reply to a message) · unpin',
    examples: ['pin', 'pin 24h', 'pin 30d', 'unpin'],
    cooldown: 3,
    async execute(sock, m, args, ctx) {
        const unpin = ctx.usedName === 'unpin' || ctx.usedName === 'الغاء_تثبيت' || String(args[0]).toLowerCase() === 'off';
        const key = quotedKey(m);
        if (!key) return help(m);
        if (!(await allowedToAct(m, ctx, 'PIN'))) return undefined;
        if (unpin) {
            await unpinMessage(sock, m.chat, key);
            return m.reply(box('PIN', ['📌 Unpinned.']));
        }
        const seconds = parsePinDuration(args[0]);
        if (!seconds) return help(m);
        await pinMessage(sock, m.chat, key, seconds);
        const lines = [`📌 Pinned for ${PIN_LABEL[seconds]}.`];
        if (m.isGroup && !(await ctx.access?.isBotAdmin?.())) lines.push('', 'If it does not appear, make the bot an admin', '(the group may allow only admins to pin).');
        return m.reply(box('PIN', lines));
    }
};
