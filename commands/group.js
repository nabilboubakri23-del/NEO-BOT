import config from '../config/config.js';
import { getGroup, invalidateGroup } from '../systems/groups/groupCache.js';
import { box, success } from '../utils/formatter.js';
import { UsageError, UserError } from '../utils/errors.js';
import { canModerateMember } from '../systems/permissions/rankRules.js';
import { rankOfTarget } from '../systems/permissions/resolveRank.js';
import { resolveUserTarget, describeTarget, targetJid } from '../utils/targets.js';

/**
 * Group management, in the style of well-known bots (Levanter, Silva):
 *   .kick    remove a member
 *   .promote make a member admin
 *   .demote  remove a member's admin
 *   .tagall  mention everyone (admins and members listed apart)
 *   .hidetag notify everyone without listing them
 *
 * Everyone may use them (permission 'public') but only in groups, as a group admin
 * (owners always pass), with the bot itself an admin. Members with a rank above
 * User are protected from anyone not ranked above them; the creator cannot be targeted.
 * Real WhatsApp actions, one member at a time.
 */

const P = config.bot.prefix;

const participantAction = async (sock, message, args, ctx, action, pastTense) => {
    const target = await resolveUserTarget(sock, message, args[0]);
    if (!target) throw new UsageError('Who? Give a number, a @mention, or reply to their message.');
    if (action !== 'promote') {
        const allowed = canModerateMember(ctx.access.rank, rankOfTarget(target));
        if (!allowed.ok) throw new UserError(allowed.reason);
    }

    const jid = targetJid(target);
    const result = await sock.groupParticipantsUpdate(message.chat, [jid], action).catch((e) => {
        throw new UserError(`WhatsApp refused the action: ${e.message}`);
    });
    invalidateGroup(message.chat);

    const status = result?.[0]?.status;
    if (status && String(status) !== '200') {
        throw new UserError(`Could not ${action} ${describeTarget(target)} (status ${status}).`);
    }
    await message.reply(success(`MEMBER ${pastTense.toUpperCase()}`, [describeTarget(target)]));
};

const memberTag = (p) => `@${(p.phoneNumber || p.id).split('@')[0]}`;

const tagAll = async (sock, message, args) => {
    const metadata = await getGroup(sock, message.chat);
    const members = metadata?.participants || [];
    if (!members.length) throw new UserError('No members found.');
    const note = args.join(' ').trim();
    const admins = members.filter((p) => p.admin);
    const others = members.filter((p) => !p.admin);
    const text = box(metadata.subject || 'ANNOUNCEMENT', [
        note || 'Attention everyone:',
        '',
        `[ ADMINS (${admins.length}) ]`,
        ...admins.map((p, i) => `${i + 1}. ${memberTag(p)}`),
        '',
        `[ MEMBERS (${others.length}) ]`,
        ...others.map((p, i) => `${i + 1}. ${memberTag(p)}`),
        '',
        `Total: ${members.length}`
    ]);
    const jids = members.map((p) => p.id);
    await sock.sendMessage(message.chat, { text, mentions: jids }, { quoted: message.raw });
};

/** Sends a text that notifies every member without listing them. */
const hideTag = async (sock, message, ctx) => {
    const metadata = await getGroup(sock, message.chat);
    const members = metadata?.participants || [];
    if (!members.length) throw new UserError('No members found.');
    const text = [ctx.argsText, ctx.body].filter(Boolean).join('\n').trim() || message.quoted?.text || '';
    if (!text) throw new UsageError('Write the message, or reply to a text message.');
    await sock.sendMessage(message.chat, { text, mentions: members.map((p) => p.id) });
};

const make = (name, aliases, action, past, description) => ({
    name,
    aliases,
    category: 'group',
    description,
    usage: '<number|@mention|reply>',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin', 'botAdmin'],
    async execute(sock, message, args, ctx) {
        await participantAction(sock, message, args, ctx, action, past);
    }
});

export const kick = make('kick', ['remove'], 'remove', 'removed', 'Remove a member from the group.');
export const promote = make('promote', ['admin'], 'promote', 'promoted', 'Make a member a group admin.');
export const demote = make('demote', ['unadmin'], 'demote', 'demoted', 'Remove a member\'s admin.');

export const tagall = {
    name: 'tagall',
    aliases: ['everyone', 'all'],
    category: 'group',
    description: 'Mention every member of the group.',
    usage: '[message]',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    async execute(sock, message, args) {
        await tagAll(sock, message, args);
    }
};

export const hidetag = {
    name: 'hidetag',
    aliases: ['htag', 'hidetagall'],
    category: 'group',
    description: 'Send a message that notifies every member without listing them.',
    usage: '<message> (or reply to a text)',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    cooldown: 10,
    async execute(sock, message, args, ctx) {
        await hideTag(sock, message, ctx);
    }
};

// One file, several commands: the loader accepts an array default export.
export default [kick, promote, demote, tagall, hidetag];
