import config from '../../config/config.js';
import commandHandler from '../../core/commandHandler.js';
import { child } from '../../core/logger.js';
import { audit } from '../../systems/permissions/auditLog.js';
import * as overrides from '../../systems/permissions/commandOverrides.js';
import { accessSpec, effectiveRank } from '../../systems/permissions/permissions.js';
import { rankOfTarget } from '../../systems/permissions/resolveRank.js';
import { badge, rankName, RANKS } from '../../systems/permissions/ranks.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { describeTarget, isTargetArg, resolveUserTarget } from '../../utils/targets.js';

/**
 * .perm — change who may use a command at runtime, without editing its file.
 * Owners can read; only the 🔱 Creator can change anything.
 *
 *   .perm list                     every runtime change
 *   .perm show <cmd>               a command's file default and current rule
 *   .perm set <cmd> <rank>         new minimum rank (wins over the file)
 *   .perm reset <cmd>              back to the file default (clears lock, allow, deny)
 *   .perm lock <cmd> / unlock <cmd>   locked = creator only
 *   .perm allow <user> <cmd>       this user may use it whatever their rank
 *   .perm deny <user> <cmd>        this user may never use it (wins over allow)
 *   .perm clear <user> <cmd>       remove that user's allow/deny
 */

const log = child('permissions');
const P = config.bot.prefix;
const CMD = `${P}perm`;
// Locking or denying these could lock everyone out of fixing it.
const PROTECTED = new Set(['perm', 'owner']);
const WRITE = new Set(['set', 'reset', 'lock', 'unlock', 'allow', 'deny', 'clear']);

/** Canonical command name for a name or alias. */
const commandOf = (input) => {
    const command = commandHandler.get(String(input || '').replace(new RegExp(`^\\${P}`), ''));
    if (!command) throw new UserError(`No command named "${input}".`);
    return command.name.toLowerCase();
};

const guard = (name) => {
    if (PROTECTED.has(name)) throw new UserError(`${P}${name} is protected and cannot be restricted.`);
};

const ruleText = (command) => {
    const rule = effectiveRank(command);
    return rule.locked ? '🔒 Locked (creator only)' : badge(rule.rank);
};

/** "<user> <cmd>" where the user may come from a mention or a reply instead. */
const userAndCommand = async (sock, message, args) => {
    const target = await resolveUserTarget(sock, message, args[0]);
    if (!target) throw new UsageError('Who? Give a number, a @mention, or reply to their message.');
    const name = commandOf((isTargetArg(args[0]) ? args.slice(1) : args)[0]);
    return { target, name };
};

const actions = {
    async list(sock, message) {
        const items = overrides.listOverrides();
        const lines = items.length
            ? items.flatMap((o) => [
                  `• ${P}${o.name}  ${o.locked ? '🔒 locked' : o.rank ? `→ ${badge(o.rank)}` : ''}`.trimEnd(),
                  ...o.allow.map((e) => `   ✅ allow ${describeTarget(e)}`),
                  ...o.deny.map((e) => `   ⛔ deny ${describeTarget(e)}`)
              ])
            : ['No runtime changes. Every command uses its file default.'];
        await message.reply(box('COMMAND PERMISSIONS', [...lines, '', `${CMD} show <cmd>  ·  ${CMD} help`]));
    },

    async show(sock, message, [input]) {
        const name = commandOf(input);
        const command = commandHandler.get(name);
        const spec = accessSpec(command);
        await message.reply(
            box(`${P}${name}`, [
                `File default: ${badge(spec.rank)}`,
                `Now: ${ruleText(command)}`,
                spec.scope ? `Where: ${spec.scope} only` : null,
                spec.requires.length ? `Requires: ${spec.requires.join(', ')}` : null
            ])
        );
    },

    async set(sock, message, [input, rank]) {
        const name = commandOf(input);
        const wanted = rankName(rank);
        if (!wanted || wanted === 'banned') throw new UsageError(`Give a rank: ${RANKS.filter((r) => r.name !== 'banned').map((r) => r.name).join(', ')}.`);
        if (wanted !== 'user') guard(name);
        overrides.setOverride(name, wanted);
        audit({ action: 'perm:set', actor: message, target: name, detail: wanted });
        await message.reply(success('PERMISSION SET', [`${P}${name} → ${badge(wanted)}`, `Undo: ${CMD} reset ${name}`]));
    },

    async reset(sock, message, [input]) {
        const name = commandOf(input);
        const had = overrides.resetCommand(name);
        audit({ action: 'perm:reset', actor: message, target: name });
        await message.reply(success('PERMISSION RESET', [had ? `${P}${name} uses its file default again.` : `${P}${name} had no runtime changes.`, `Now: ${ruleText(commandHandler.get(name))}`]));
    },

    async lock(sock, message, [input]) {
        const name = commandOf(input);
        guard(name);
        overrides.setLocked(name, true);
        audit({ action: 'perm:lock', actor: message, target: name });
        await message.reply(success('COMMAND LOCKED', [`${P}${name} is now creator only.`, `Unlock: ${CMD} unlock ${name}`]));
    },

    async unlock(sock, message, [input]) {
        const name = commandOf(input);
        overrides.setLocked(name, false);
        audit({ action: 'perm:unlock', actor: message, target: name });
        await message.reply(success('COMMAND UNLOCKED', [`${P}${name} → ${ruleText(commandHandler.get(name))}`]));
    },

    async allow(sock, message, args) {
        const { target, name } = await userAndCommand(sock, message, args);
        overrides.addException('allow', name, target);
        audit({ action: 'perm:allow', actor: message, target, detail: name });
        await message.reply(success('ACCESS GRANTED', [describeTarget(target), `may use ${P}${name} whatever their rank.`]));
    },

    async deny(sock, message, args) {
        const { target, name } = await userAndCommand(sock, message, args);
        guard(name);
        if (rankOfTarget(target).name === 'creator') throw new UserError('The creator cannot be denied anything.');
        overrides.addException('deny', name, target);
        audit({ action: 'perm:deny', actor: message, target, detail: name });
        await message.reply(success('ACCESS DENIED', [describeTarget(target), `can no longer use ${P}${name}.`, `Undo: ${CMD} clear ${target.number || target.lid} ${name}`]));
    },

    async clear(sock, message, args) {
        const { target, name } = await userAndCommand(sock, message, args);
        const removed = overrides.clearException(name, target);
        audit({ action: 'perm:clear', actor: message, target, detail: name });
        await message.reply(box('PERMISSIONS', [removed ? `Exception removed for ${describeTarget(target)} on ${P}${name}.` : 'No exception to remove.']));
    },

    async help(sock, message) {
        await message.reply(
            box('PERM HELP', [
                `${CMD} list  → runtime changes`,
                `${CMD} show <cmd>  → current rule`,
                `${CMD} set <cmd> <rank>`,
                `${CMD} reset <cmd>`,
                `${CMD} lock <cmd>  ·  unlock <cmd>`,
                `${CMD} allow <user> <cmd>`,
                `${CMD} deny <user> <cmd>`,
                `${CMD} clear <user> <cmd>`,
                '',
                `Ranks: ${RANKS.filter((r) => r.name !== 'banned').map((r) => r.name).join(', ')}`,
                'Changes are creator only. Deny wins over allow.'
            ])
        );
    }
};

const SUBS = { ls: 'list', info: 'show', del: 'reset', remove: 'reset' };

export default {
    name: 'perm',
    aliases: ['perms', 'permission'],
    category: 'owner',
    description: 'Change who may use a command at runtime: rank, lock, allow or deny users.',
    usage: '[list|show|set|reset|lock|unlock|allow|deny|clear] ...',
    examples: ['list', 'set ping premium', 'lock dev', 'deny 212600000000 tagall'],
    permission: 'owner',

    async execute(sock, message, args, ctx) {
        const raw = String(args[0] || 'list').toLowerCase();
        const sub = SUBS[raw] || raw;
        const action = actions[sub];
        if (!action) return actions.help(sock, message);
        if (WRITE.has(sub) && !ctx.access.isCreator) throw new UserError(`Only the ${badge('creator')} can change permissions.`);
        if (WRITE.has(sub) && !args[1] && !message.quoted && !message.mentions?.length) throw new UsageError();
        log.info({ sub }, 'Permission command.');
        return action(sock, message, args.slice(1), ctx);
    }
};
