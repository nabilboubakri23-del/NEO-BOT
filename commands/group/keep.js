import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { quotedKey } from '../../utils/quotedKey.js';
import { keepMessage } from '../../systems/groups/messageActions.js';
import { allowedToAct } from './.messageActionAccess.js';

const P = () => config.bot.prefix;

const help = (m) => m.reply(box('KEEP', [
    'Reply to a message in a chat with disappearing messages:',
    `${P()}keep    → keep it for everyone (it will not disappear)`,
    `${P()}unkeep  → let it disappear again`,
    '',
    'Only works when disappearing messages are on.'
]));

export default {
    name: 'keep',
    aliases: ['unkeep', 'احتفظ', 'حفظ'],
    category: 'group',
    permission: 'public',
    description: 'Keep a replied message in a disappearing-messages chat, or undo it.',
    usage: '(reply to a message) · unkeep',
    examples: ['keep', 'unkeep'],
    cooldown: 3,
    async execute(sock, m, args, ctx) {
        const undo = ctx.usedName === 'unkeep' || String(args[0]).toLowerCase() === 'off';
        const key = quotedKey(m);
        if (!key) return help(m);
        if (!(await allowedToAct(m, ctx, 'KEEP'))) return undefined;
        await keepMessage(sock, m.chat, key, !undo);
        return m.reply(box('KEEP', [undo ? '🔓 Unkept: it will disappear on schedule.' : '🔖 Kept for everyone.', '', 'No effect if disappearing messages are off.']));
    }
};
