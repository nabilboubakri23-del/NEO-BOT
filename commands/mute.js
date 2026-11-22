import config from '../config/config.js';
import { assertCanModerate } from '../systems/moderation/targetRules.js';
import { activeMute, listMutes, muteMember, unmuteMember } from '../systems/moderation/mutes.js';
import { formatRemaining, isDuration, parseDuration } from '../utils/duration.js';
import { mentionTarget } from '../utils/mentions.js';
import { box } from '../utils/formatter.js';
import { UsageError } from '../utils/errors.js';
import { isTargetArg, resolveUserTarget, senderOf } from '../utils/targets.js';

/**
 * Member mute: the bot deletes every message a muted member sends in this group
 * (needs the bot to be a group admin). To close the whole group use ".close".
 *
 *   .mute <user> [30m|2h|1d]   mute, optionally for a while
 *   .unmute <user>
 *   .mutelist
 */

const P = config.bot.prefix;
const WHO = 'Who? Give a number, a @mention, or reply to their message.';

const until = (record) => (record.until ? `for ${formatRemaining(record.until - Date.now())}` : 'until unmuted');

const reply = (sock, message, title, lines, mentions) => sock.sendMessage(message.chat, { text: box(title, lines), mentions }, { quoted: message.raw });

export const mute = {
    name: 'mute',
    aliases: ['silence'],
    category: 'group',
    description: 'Mute a member: their messages are deleted (optionally for a while).',
    usage: '<number|@mention|reply> [30m|2h|1d]',
    examples: ['@user 1h', '@user'],
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin', 'botAdmin'],
    async execute(sock, message, args, ctx) {
        const t = await resolveUserTarget(sock, message, args[0]);
        if (!t) throw new UsageError(WHO);
        assertCanModerate(sock, ctx.access.rank, t);
        const rest = isTargetArg(args[0]) ? args.slice(1) : args;
        const ms = rest[0] ? parseDuration(rest[0]) : 0;
        if (rest[0] && (!isDuration(rest[0]) || !ms)) throw new UsageError('Duration like 30m, 2h or 1d.');
        const by = senderOf(message).number || senderOf(message).lid;
        const record = muteMember(message.chat, t, { ms, by });
        const tag = mentionTarget(t);
        await reply(sock, message, 'MUTED', [`🔇 ${tag.text} is muted ${until(record)}.`, 'Their messages will be deleted.', `Undo: ${P}unmute`], [tag.jid]);
    }
};

export const unmute = {
    name: 'unmute',
    aliases: ['unsilence'],
    category: 'group',
    description: 'Unmute a member.',
    usage: '<number|@mention|reply>',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    async execute(sock, message, args) {
        const t = await resolveUserTarget(sock, message, args[0]);
        if (!t) throw new UsageError(WHO);
        const tag = mentionTarget(t);
        const was = activeMute(message.chat, t);
        unmuteMember(message.chat, t);
        await reply(sock, message, 'UNMUTED', [was ? `🔊 ${tag.text} can talk again.` : `${tag.text} was not muted.`], [tag.jid]);
    }
};

export const mutelist = {
    name: 'mutelist',
    aliases: ['muted'],
    category: 'group',
    description: 'List muted members of this group.',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    async execute(sock, message) {
        const list = listMutes(message.chat);
        const tags = list.map(mentionTarget);
        await reply(sock, message, 'MUTED MEMBERS', list.length ? list.map((r, i) => `${i + 1}. ${tags[i].text} — ${until(r)}`) : ['Nobody is muted.'], tags.map((t) => t.jid));
    }
};

export default [mute, unmute, mutelist];
