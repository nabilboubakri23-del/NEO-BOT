import config from '../../config/config.js';
import commandHandler from '../../core/commandHandler.js';
import { child } from '../../core/logger.js';
import { getOwners } from '../../systems/owners/ownerStore.js';
import { recentAudit } from '../../systems/permissions/auditLog.js';
import { dailyLimitFor } from '../../systems/permissions/perks.js';
import { effectiveRank } from '../../systems/permissions/permissions.js';
import { MANAGE_MIN } from '../../systems/permissions/rankRules.js';
import { changeRank } from '../../systems/permissions/rankService.js';
import { listStoredRanks } from '../../systems/permissions/rankStore.js';
import { rankOfTarget } from '../../systems/permissions/resolveRank.js';
import { badge, getRank, levelOf, rankName, RANKS } from '../../systems/permissions/ranks.js';
import { usedToday } from '../../systems/permissions/dailyLimit.js';
import { listBanned } from '../../systems/users/userStore.js';
import { formatRemaining, isDuration, parseDuration } from '../../utils/duration.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { describeTarget, isTargetArg, resolveUserTarget } from '../../utils/targets.js';

/**
 * .rank — the rank system from WhatsApp.
 *
 *   .rank / .myrank                         your rank, perks, expiry, unlocked commands
 *   .rank list                              every rank with its level and member count
 *   .rank who <rank>                        who holds a rank
 *   .rank info <user>                       someone's rank (moderator+)
 *   .rank set <user> <rank> [7d] [reason]   grant a rank, optionally temporary (moderator+)
 *   .rank del <user>                        back to User (moderator+)
 *   .rank log [n]                           audit log (owner+)
 *   .premium <user> <duration> [reason]     shortcut for .rank set <user> premium <duration>
 *
 * <user> = number, @mention, or reply to their message.
 * You can only grant ranks below your own, to people below you.
 */

const log = child('ranks');
const P = config.bot.prefix;
const CMD = `${P}rank`;
const SUBS = { me: 'me', list: 'list', ls: 'list', all: 'list', who: 'who', holders: 'who', info: 'info', check: 'info', set: 'set', give: 'set', grant: 'set', del: 'del', remove: 'del', revoke: 'del', reset: 'del', log: 'log', audit: 'log', help: 'help' };

const requireLevel = (ctx, rank) => {
    if (!ctx.access.atLeast(rank)) throw new UserError(`Requires ${badge(rank)}. Your rank: ${badge(ctx.access.rank.name)}.`);
};

const whoText = (entry) => describeTarget(entry);

/** Splits "<user> rest..." where <user> may also come from a mention or a reply. */
const takeTarget = async (sock, message, args) => {
    const target = await resolveUserTarget(sock, message, args[0]);
    if (!target) throw new UsageError('Who? Give a number, a @mention, or reply to their message.');
    return { target, rest: isTargetArg(args[0]) ? args.slice(1) : args };
};

const perksLines = (rank) => {
    const limit = dailyLimitFor(rank);
    const cd = rank.perks.cooldownMultiplier;
    return [
        `Cooldowns: ${cd === 0 ? 'none' : cd === 1 ? 'normal' : `${cd * 100}% of normal`}`,
        `Daily commands: ${limit === Infinity ? 'unlimited' : limit}`
    ];
};

const actions = {
    async me(sock, message, args, ctx) {
        const { rank } = ctx.access;
        const userKey = message.senderNumber || message.senderLid || message.sender;
        const usable = commandHandler.visible(ctx.access);
        const extra = usable.filter((c) => levelOf(effectiveRank(c).rank) > levelOf('user')).map((c) => `${P}${c.name}`);
        const limit = dailyLimitFor(rank);
        await message.reply(
            box('MY RANK', [
                `${rank.emoji} ${rank.label}  ·  level ${rank.level}`,
                rank.expiresAt ? `Expires in: ${formatRemaining(rank.expiresAt - Date.now())}` : rank.name === 'user' ? null : 'Expires: never',
                '',
                '[ PERKS ]',
                ...perksLines(rank),
                limit === Infinity ? null : `Used today: ${usedToday(userKey)}/${limit}`,
                '',
                `[ COMMANDS ] ${usable.length} available`,
                extra.length ? `Unlocked by rank: ${extra.join(', ')}` : null,
                '',
                `All ranks: ${CMD} list`
            ])
        );
    },

    async list(sock, message) {
        const stored = listStoredRanks();
        const count = {
            creator: 1,
            owner: getOwners().admins.length,
            banned: listBanned().length,
            ...Object.fromEntries(['moderator', 'vip', 'premium'].map((r) => [r, stored.filter((e) => e.rank === r).length]))
        };
        const lines = RANKS.flatMap((r) => [
            `${r.emoji} ${r.label}  ·  level ${r.level}  ·  ${r.name === 'user' ? 'everyone else' : `${count[r.name]} member${count[r.name] === 1 ? '' : 's'}`}`
        ]);
        await message.reply(box('RANKS', [...lines, '', 'Higher ranks have every permission of lower ones.', `Holders: ${CMD} who <rank>`, `Your rank: ${CMD}`]));
    },

    async who(sock, message, [name]) {
        const rank = getRank(name);
        if (!rank) throw new UsageError(`Give a rank: ${RANKS.map((r) => r.name).join(', ')}.`);
        let lines;
        if (rank.name === 'creator') lines = [whoText(getOwners().owner)];
        else if (rank.name === 'owner') lines = getOwners().admins.map(whoText);
        else if (rank.name === 'banned') lines = listBanned().map(whoText);
        else if (rank.name === 'user') lines = ['Everyone without another rank.'];
        else {
            lines = listStoredRanks(rank.name).map((e) => `• ${whoText(e)}${e.expiresAt ? `  ⏳ ${formatRemaining(e.expiresAt - Date.now())}` : ''}`);
        }
        await message.reply(box(`${rank.emoji} ${rank.label.toUpperCase()}`, lines.length ? lines : ['Nobody yet.']));
    },

    async info(sock, message, args, ctx) {
        requireLevel(ctx, MANAGE_MIN);
        const { target } = await takeTarget(sock, message, args);
        const rank = rankOfTarget(target);
        await message.reply(
            box('RANK INFO', [
                describeTarget(target),
                `${rank.emoji} ${rank.label}  ·  level ${rank.level}`,
                rank.expiresAt ? `Expires in: ${formatRemaining(rank.expiresAt - Date.now())}` : null,
                rank.grantedBy ? `Granted by: ${rank.grantedBy}` : null,
                rank.reason ? `Reason: ${rank.reason}` : null
            ])
        );
    },

    async set(sock, message, args, ctx, forced = null) {
        requireLevel(ctx, MANAGE_MIN);
        const { target, rest } = await takeTarget(sock, message, args);
        const [first, ...more] = forced ? [forced, ...rest] : rest;
        const next = rankName(first);
        if (!next) throw new UsageError(`Give a rank: ${RANKS.filter((r) => r.name !== 'creator').map((r) => r.name).join(', ')}.`);
        let reasonWords = more;
        let durationMs = null;
        if (isDuration(more[0])) {
            durationMs = parseDuration(more[0]);
            if (!durationMs) throw new UserError('Duration out of range (max 10 years).');
            reasonWords = more.slice(1);
        } else if (['perm', 'permanent', 'forever'].includes(String(more[0]).toLowerCase())) {
            reasonWords = more.slice(1);
        }
        const result = await changeRank({ rank: ctx.access.rank, person: message }, target, next, { durationMs, reason: reasonWords.join(' ') });
        log.warn({ target: describeTarget(target), from: result.before.name, to: next }, 'Rank changed.');
        await message.reply(
            success('RANK UPDATED', [
                describeTarget(target),
                `${badge(result.before.name)} → ${badge(next)}`,
                result.expiresAt ? `Expires in: ${formatRemaining(result.expiresAt - Date.now())}` : 'Permanent',
                reasonWords.length ? `Reason: ${reasonWords.join(' ')}` : null,
                `Undo: ${CMD} del ${target.number || target.lid}`
            ])
        );
    },

    async del(sock, message, args, ctx) {
        requireLevel(ctx, MANAGE_MIN);
        const { target } = await takeTarget(sock, message, args);
        const result = await changeRank({ rank: ctx.access.rank, person: message }, target, 'user');
        log.warn({ target: describeTarget(target), from: result.before.name }, 'Rank removed.');
        await message.reply(success('RANK REMOVED', [describeTarget(target), `${badge(result.before.name)} → ${badge('user')}`]));
    },

    async log(sock, message, [n], ctx) {
        requireLevel(ctx, 'owner');
        const limit = Math.min(Math.max(Number.parseInt(n, 10) || 10, 1), 50);
        const entries = recentAudit(limit);
        const lines = entries.length
            ? entries.flatMap((e) => [`• ${new Date(e.at).toISOString().replace('T', ' ').slice(0, 16)} UTC`, `   ${e.action}  ${e.target}${e.detail ? `  ${e.detail}` : ''}`, `   by ${e.actor}`])
            : ['No entries yet.'];
        await message.reply(box(`AUDIT LOG (${entries.length})`, lines));
    },

    async help(sock, message) {
        await message.reply(
            box('RANK HELP', [
                `${CMD}  → your rank and perks`,
                `${CMD} list  → all ranks`,
                `${CMD} who <rank>  → holders`,
                `${CMD} info <user>  → someone's rank`,
                `${CMD} set <user> <rank> [7d|12h|30m] [reason]`,
                `${CMD} del <user>  → back to User`,
                `${CMD} log [n]  → audit log (owners)`,
                `${P}premium <user> <duration>  → quick Premium`,
                '',
                '<user> = number, @mention or reply.',
                'You can only grant ranks below your own.'
            ])
        );
    }
};

export default {
    name: 'rank',
    aliases: ['ranks', 'myrank', 'setrank', 'premium'],
    category: 'system',
    description: 'Ranks: see yours, list them, grant or remove them (temporary ranks supported).',
    usage: '[list|who|info|set|del|log] ...',
    examples: ['', 'list', 'set 212600000000 vip 30d', 'who premium', 'log 20'],
    permission: 'public', // viewing is for everyone; managing checks the rank inside

    async execute(sock, message, args, ctx) {
        if (ctx.usedName === 'myrank') return actions.me(sock, message, args, ctx);
        if (ctx.usedName === 'setrank') return actions.set(sock, message, args, ctx);
        if (ctx.usedName === 'premium') {
            if (!args.length && !message.quoted && !message.mentions?.length) return actions.help(sock, message);
            return actions.set(sock, message, args, ctx, 'premium');
        }
        const sub = SUBS[String(args[0] || (ctx.usedName === 'ranks' ? 'list' : 'me')).toLowerCase()];
        if (!sub) return actions.help(sock, message);
        return actions[sub](sock, message, args.slice(1), ctx);
    }
};
