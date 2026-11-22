import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { banUser, unbanUser } from '../../systems/permissions/rankService.js';
import { listBanned } from '../../systems/users/userStore.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError } from '../../utils/errors.js';
import { describeTarget, isTargetArg, resolveUserTarget } from '../../utils/targets.js';

/**
 * .ban / .unban / .banlist — banned users (🚫 Banned rank) are ignored by the bot everywhere.
 * The alias used decides the action. You can only ban someone below your own rank.
 */

const log = child('users');
const P = config.bot.prefix;

export default {
    name: 'ban',
    aliases: ['unban', 'banlist', 'bans'],
    category: 'owner',
    description: 'Ban or unban a user from the bot.',
    usage: '<number|@mention|reply> [reason]',
    examples: ['212600000000 spam', '@user'],
    permission: 'moderator',

    async execute(sock, message, args, ctx) {
        const action = ctx.usedName === 'unban' ? 'unban' : ['banlist', 'bans'].includes(ctx.usedName) ? 'list' : 'ban';

        if (action === 'list') {
            const banned = listBanned();
            return message.reply(
                box('BANNED USERS', banned.length ? banned.map((u) => `• ${describeTarget(u)}${u.banReason ? `  (${u.banReason})` : ''}`) : ['Nobody is banned.'])
            );
        }

        const target = await resolveUserTarget(sock, message, args[0]);
        if (!target) throw new UsageError('Who? Give a number, a @mention, or reply to their message.');

        const actor = { rank: ctx.access.rank, person: message };
        const reason = (isTargetArg(args[0]) ? args.slice(1) : args).join(' ');
        const user = action === 'ban' ? banUser(actor, target, reason) : unbanUser(actor, target);
        log.warn({ action, target: describeTarget(target) }, 'Ban list changed.');
        await message.reply(
            success(action === 'ban' ? 'USER BANNED' : 'USER UNBANNED', [
                describeTarget(target),
                action === 'ban' && user.banReason ? `Reason: ${user.banReason}` : null,
                action === 'ban' ? `Undo: ${P}unban ${target.number || target.lid}` : 'They can use the bot again.'
            ])
        );
    }
};
