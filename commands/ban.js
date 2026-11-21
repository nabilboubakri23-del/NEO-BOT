import config from '../config/config.js';
import { child } from '../core/logger.js';
import { isOwner } from '../systems/owners/ownerStore.js';
import { listBanned, setBanned } from '../systems/users/userStore.js';
import { box, success } from '../utils/formatter.js';
import { UsageError, UserError } from '../utils/errors.js';
import { describeTarget, resolveUserTarget } from '../utils/targets.js';

/**
 * .ban / .unban / .banlist — banned users are ignored by the bot everywhere.
 * The alias used decides the action.
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
    permissions: ['owner'],

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
        if (action === 'ban' && isOwner({ senderNumber: target.number, senderLid: target.lid })) throw new UserError('Owners cannot be banned.');

        const reasonArgs = /\d{6,}/.test(args[0] || '') || args[0]?.startsWith('@') ? args.slice(1) : args;
        const user = setBanned(target, action === 'ban', reasonArgs.join(' '));
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
