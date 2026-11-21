import config from '../config/config.js';
import { getGroup, invalidateGroup } from '../systems/groups/groupCache.js';
import { box, success } from '../utils/formatter.js';
import { UsageError, UserError } from '../utils/errors.js';
import { canModerateMember } from '../systems/permissions/rankRules.js';
import { rankOfTarget } from '../systems/permissions/resolveRank.js';
import { resolveUserTarget, describeTarget } from '../utils/targets.js';

/**
 * Group management, in the style of well-known bots (Levanter, Silva):
 *   .kick    remove a member
 *   .promote make a member admin
 *   .demote  remove a member's admin
 *   .tagall  mention everyone
 *
 * Everyone may use them (permission 'public') but only in groups, as a group admin
 * (owners always pass), with the bot itself an admin. Members with a rank above
 * User are protected from anyone not ranked above them; the creator cannot be targeted.
 * Real WhatsApp actions, one member at a time.
 */

const P = config.bot.prefix;

const toJid = (t) => (t.number ? `${t.number}@s.whatsapp.net` : `${t.lid}@lid`);

const participantAction = async (sock, message, args, ctx, action, pastTense) => {
    const target = await resolveUserTarget(sock, message, args[0]);
    if (!target) throw new UsageError('Who? Give a number, a @mention, or reply to their message.');
    if (action !== 'promote') {
        const allowed = canModerateMember(ctx.access.rank, rankOfTarget(target));
        if (!allowed.ok) throw new UserError(allowed.reason);
    }

    const jid = toJid(target);
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

const tagAll = async (sock, message, args) => {
    const metadata = await getGroup(sock, message.chat);
    const members = metadata?.participants || [];
    if (!members.length) throw new UserError('No members found.');
    const note = args.join(' ').trim();
    const jids = members.map((p) => p.id);
    const text = box(metadata.subject || 'ANNOUNCEMENT', [
        note || 'Attention everyone:',
        '',
        ...members.map((p, i) => `${i + 1}. @${(p.phoneNumber || p.id).split('@')[0]}`)
    ]);
    await sock.sendMessage(message.chat, { text, mentions: jids }, { quoted: message.raw });
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

// One file, several commands: the loader accepts an array default export.
export default [kick, promote, demote, tagall];
