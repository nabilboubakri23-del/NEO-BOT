import config from '../config/config.js';
import { applyWarning } from '../systems/moderation/actions.js';
import { getGroupOption } from '../systems/moderation/groupConfig.js';
import { assertCanModerate } from '../systems/moderation/targetRules.js';
import { clearWarnings, listWarnings, removeWarning, warningCount, warningHistory } from '../systems/moderation/warnings.js';
import { mentionTarget } from '../utils/mentions.js';
import { box } from '../utils/formatter.js';
import { UsageError } from '../utils/errors.js';
import { isTargetArg, resolveUserTarget, senderOf, targetJid } from '../utils/targets.js';

/**
 * Warnings with an automatic kick at the group's limit (".gset warnlimit <n>", default 3).
 *
 *   .warn <user> [reason]      give a warning (group admins; bot must be admin to kick)
 *   .unwarn <user> [n|all]     remove warnings
 *   .warnings [user|list]      someone's warnings, or every warned member
 *
 * <user> = number, @mention, or reply to their message. Ranked members are protected from lower ranks.
 */

const P = config.bot.prefix;
const WHO = 'Who? Give a number, a @mention, or reply to their message.';

const target = async (sock, message, args) => {
    const t = await resolveUserTarget(sock, message, args[0]);
    if (!t) throw new UsageError(WHO);
    return t;
};

export const warn = {
    name: 'warn',
    category: 'group',
    description: 'Warn a member; at the warn limit they are removed.',
    usage: '<number|@mention|reply> [reason]',
    examples: ['@user spamming'],
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin', 'botAdmin'],
    async execute(sock, message, args, ctx) {
        const t = await target(sock, message, args);
        assertCanModerate(sock, ctx.access.rank, t);
        const reason = (isTargetArg(args[0]) ? args.slice(1) : args).join(' ').trim();
        const by = senderOf(message).number || senderOf(message).lid;
        const result = await applyWarning(sock, message.chat, t, targetJid(t), { by, reason });
        const tag = mentionTarget(t);
        await sock.sendMessage(
            message.chat,
            {
                text: box('WARNING', [
                    `⚠️ ${tag.text}`,
                    `Warnings: ${result.count}/${result.limit}`,
                    reason ? `Reason: ${reason}` : null,
                    result.count >= result.limit ? (result.kicked ? '🚫 Limit reached: removed from the group.' : '❗ Limit reached, but I could not remove them.') : null
                ]),
                mentions: [tag.jid]
            },
            { quoted: message.raw }
        );
    }
};

export const unwarn = {
    name: 'unwarn',
    aliases: ['delwarn', 'resetwarn'],
    category: 'group',
    description: 'Remove one, several or all warnings of a member.',
    usage: '<number|@mention|reply> [n|all]',
    examples: ['@user', '@user all'],
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    async execute(sock, message, args, ctx) {
        const t = await target(sock, message, args);
        const rest = isTargetArg(args[0]) ? args.slice(1) : args;
        const amountArg = String(rest[0] || (ctx.usedName === 'resetwarn' ? 'all' : '1')).toLowerCase();
        const amount = amountArg === 'all' ? Infinity : Number.parseInt(amountArg, 10);
        if (!(amount > 0)) throw new UsageError('Give a number of warnings or "all".');
        const before = warningCount(message.chat, t);
        const tag = mentionTarget(t);
        if (!before) return sock.sendMessage(message.chat, { text: box('WARNINGS', [`${tag.text} has no warnings.`]), mentions: [tag.jid] }, { quoted: message.raw });
        const left = amount === Infinity ? clearWarnings(message.chat, t) : removeWarning(message.chat, t, amount);
        await sock.sendMessage(message.chat, { text: box('WARNINGS', [`✅ ${tag.text}`, `Warnings: ${before} → ${left}`]), mentions: [tag.jid] }, { quoted: message.raw });
    }
};

const formatAge = (at) => {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    return days ? `${days}d ago` : 'today';
};

export const warnings = {
    name: 'warnings',
    aliases: ['warns', 'warnlist'],
    category: 'group',
    description: 'Show warnings: yours, a member\'s, or "list" for every warned member.',
    usage: '[number|@mention|reply|list]',
    permission: 'public',
    scope: 'group',
    async execute(sock, message, args, ctx) {
        const limit = getGroupOption(message.chat, 'warnlimit');
        if (String(args[0]).toLowerCase() === 'list' || ctx.usedName === 'warnlist') {
            const all = listWarnings(message.chat);
            const tags = all.map((r) => mentionTarget(r));
            return sock.sendMessage(
                message.chat,
                { text: box('WARNED MEMBERS', all.length ? all.map((r, i) => `${i + 1}. ${tags[i].text} — ${r.count}/${limit}`) : ['Nobody has warnings.']), mentions: tags.map((t) => t.jid) },
                { quoted: message.raw }
            );
        }
        const t = (await resolveUserTarget(sock, message, args[0])) || senderOf(message);
        const tag = mentionTarget(t);
        const count = warningCount(message.chat, t);
        const history = warningHistory(message.chat, t);
        await sock.sendMessage(
            message.chat,
            {
                text: box('WARNINGS', [
                    `${tag.text}: ${count}/${limit}`,
                    ...(history.length ? ['', ...history.map((h, i) => `${i + 1}. ${h.reason || 'No reason'} (${formatAge(h.at)})`)] : []),
                    count ? `At ${limit} warnings a member is removed.` : null,
                    count ? `Admins: ${P}unwarn to remove.` : null
                ]),
                mentions: [tag.jid]
            },
            { quoted: message.raw }
        );
    }
};

export default [warn, unwarn, warnings];
