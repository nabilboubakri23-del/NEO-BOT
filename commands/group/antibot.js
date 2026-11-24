import config from '../../config/config.js';
import { getGroupOption, setGroupOption } from '../../systems/moderation/groupConfig.js';
import { allowBot, clearBots, flagBot, forgetBot, listBots } from '../../systems/moderation/knownBots.js';
import { readinessLines } from '../../systems/moderation/readiness.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { mentionTarget } from '../../utils/mentions.js';
import { isSelf, resolveUserTarget, targetJid } from '../../utils/targets.js';

/**
 * .antibot — stop other bots in a group (group admins).
 *   .antibot <off|delete|warn|kick>   switch it on / off
 *   .antibot add @bot      (or reply)  mark a bot by hand
 *   .antibot allow @bot    (or reply)  keep a bot you want (never touched)
 *   .antibot remove @bot   (or reply)  take it off both lists
 *   .antibot list | clear
 * Detection is in systems/moderation/botDetector.js; enforcement in guard.js. The bot must be admin.
 */

const P = () => config.bot.prefix;
const MODES = ['off', 'delete', 'warn', 'kick'];
const MODE_TEXT = {
    off: 'Off.',
    delete: 'Bot messages are deleted.',
    warn: 'Bot messages are deleted and the bot gets a warning (removed at the warn limit).',
    kick: 'Bot messages are deleted and the bot is removed.'
};

const target = async (sock, m, arg) => {
    const t = await resolveUserTarget(sock, m, arg);
    if (!t) throw new UsageError('Mention the bot, reply to its message, or give its number.');
    if (isSelf(sock, targetJid(t))) throw new UserError('That is me.');
    return t;
};

const status = async (sock, m) => {
    const { bots, allow } = listBots(m.chat);
    return m.reply(box('ANTI-BOT', [
        `Mode: ${getGroupOption(m.chat, 'antibot')}`,
        `🤖 Caught / marked bots: ${bots.length}`,
        `✅ Allowed bots: ${allow.length}`,
        '',
        `${P()}antibot delete | warn | kick | off`,
        `${P()}antibot add @bot  ·  allow @bot  ·  remove @bot`,
        `${P()}antibot list  ·  clear`,
        ...(await readinessLines(sock, m))
    ]));
};

const list = (m) => {
    const { bots, allow } = listBots(m.chat);
    const row = ([key, v]) => `• +${key}${v.reason ? ` (${v.reason})` : ''}`;
    return m.reply(box('BOTS HERE', [
        `Blocked (${bots.length}):`, ...(bots.length ? bots.slice(-30).map(row) : ['—']),
        '', `Allowed (${allow.length}):`, ...(allow.length ? allow.map(row) : ['—'])
    ]));
};

export default {
    name: 'antibot',
    aliases: ['antibots', 'nobots', 'ضدالبوتات'],
    category: 'group',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    description: 'Stop other bots in this group: deletes their messages, warns or removes them.',
    usage: '<off|delete|warn|kick>  |  add|allow|remove @bot  |  list  |  clear',
    examples: ['delete', 'kick', 'allow @bot', 'list'],
    cooldown: 3,
    async execute(sock, m, args) {
        const sub = String(args[0] || '').toLowerCase();
        if (!sub) return status(sock, m);
        if (MODES.includes(sub) || ['on', 'تشغيل', 'ايقاف', 'إيقاف'].includes(sub)) {
            const mode = sub === 'on' || sub === 'تشغيل' ? 'delete' : ['ايقاف', 'إيقاف'].includes(sub) ? 'off' : sub;
            const { value } = setGroupOption(m.chat, 'antibot', mode);
            return m.reply(success('ANTI-BOT', [`Mode → ${value}`, MODE_TEXT[value], ...(value === 'off' ? [] : ['', 'Allow a bot you want to keep:', `${P()}antibot allow @bot`]), ...(await readinessLines(sock, m))]));
        }
        if (sub === 'list') return list(m);
        if (sub === 'clear') return m.reply(`🧹 Cleared ${clearBots(m.chat)} blocked bots. Allowed bots kept.`);
        if (['add', 'allow', 'remove', 'del'].includes(sub)) {
            const t = await target(sock, m, args[1]);
            const tag = mentionTarget(t);
            if (sub === 'add') {
                flagBot(m.chat, t, { jid: targetJid(t), reason: 'marked by an admin', by: m.senderNumber });
                const off = getGroupOption(m.chat, 'antibot') === 'off';
                return m.reply({ text: `🤖 ${tag.text} marked as a bot.${off ? `\nTurn it on: ${P()}antibot delete` : ''}`, mentions: [tag.jid] });
            }
            if (sub === 'allow') {
                allowBot(m.chat, t, targetJid(t));
                return m.reply({ text: `✅ ${tag.text} is allowed here.`, mentions: [tag.jid] });
            }
            const had = forgetBot(m.chat, t);
            return m.reply({ text: had ? `♻️ ${tag.text} removed from the bot lists.` : `${tag.text} was not on any list.`, mentions: [tag.jid] });
        }
        throw new UsageError(`Use ${MODES.join(' | ')}, add, allow, remove, list or clear.`);
    }
};
