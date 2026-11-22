import { isJidGroup, isJidNewsletter, jidNormalizedUser } from 'baileys';
import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';

/**
 * .jid — get the ID (JID) of a group or a channel.
 *
 *   .jid                         inside a group → this group's ID
 *   .jid                         posted in your own channel → the channel's ID (sent to you privately)
 *   .jid <group invite link>     chat.whatsapp.com/XXXX
 *   .jid <channel link>          whatsapp.com/channel/XXXX
 *   .jid  (reply to a message forwarded from a channel) → that channel's ID
 */

const GROUP_LINK = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{10,})/i;
const CHANNEL_LINK = /whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,})/i;

const groupLines = (meta, jid) => [
    '[ GROUP ]',
    `Name: ${meta?.subject || 'Unknown'}`,
    `ID: ${jid}`,
    ...(meta?.size || meta?.participants?.length ? [`Members: ${meta.size || meta.participants.length}`] : [])
];

const channelLines = (meta, jid) => {
    const thread = meta?.thread_metadata || meta?.threadMetadata || {};
    const name = thread.name?.text || meta?.name || 'Unknown';
    const followers = thread.subscribers_count ?? meta?.subscribers;
    return ['[ CHANNEL ]', `Name: ${name}`, `ID: ${jid}`, ...(followers !== undefined ? [`Followers: ${followers}`] : [])];
};

const fetchChannel = async (sock, type, key) => {
    const meta = await sock.newsletterMetadata(type, key).catch(() => null);
    if (!meta?.id) return null;
    return channelLines(meta, meta.id);
};

/** Channel JID carried by a message forwarded from a channel (the reply target or the command itself). */
const forwardedChannel = (message) => {
    const contexts = [message.raw?.message, message.quoted?.message]
        .filter(Boolean)
        .flatMap((m) => Object.values(m).map((v) => v?.contextInfo))
        .filter(Boolean);
    for (const ctx of contexts) {
        const jid = ctx.forwardedNewsletterMessageInfo?.newsletterJid;
        if (jid) return { jid, name: ctx.forwardedNewsletterMessageInfo.newsletterName };
    }
    return null;
};

const resolve = async (sock, message, input) => {
    const group = input.match(GROUP_LINK);
    if (group) {
        const meta = await sock.groupGetInviteInfo(group[1]).catch(() => null);
        if (!meta?.id) throw new UserError('Invalid or expired group link.');
        return groupLines(meta, meta.id);
    }
    const channel = input.match(CHANNEL_LINK);
    if (channel) {
        const lines = await fetchChannel(sock, 'invite', channel[1]);
        if (!lines) throw new UserError('Invalid channel link.');
        return lines;
    }
    if (input) throw new UserError('Send a group link (chat.whatsapp.com/…) or a channel link (whatsapp.com/channel/…).');

    if (isJidNewsletter(message.chat)) return (await fetchChannel(sock, 'jid', message.chat)) || channelLines(null, message.chat);

    const forwarded = forwardedChannel(message);
    if (forwarded) return (await fetchChannel(sock, 'jid', forwarded.jid)) || channelLines({ name: forwarded.name }, forwarded.jid);

    if (isJidGroup(message.chat)) {
        const meta = await sock.groupMetadata(message.chat).catch(() => null);
        return groupLines(meta, message.chat);
    }
    throw new UserError('Use it inside a group, add a group/channel link, or reply to a message forwarded from a channel.');
};

export default {
    name: 'jid',
    aliases: ['gid', 'groupid', 'cid', 'channelid'],
    category: 'tools',
    description: 'Get the ID of a group or channel (here, by link, or from a forwarded channel post).',
    usage: '[group link | channel link]',
    examples: ['https://chat.whatsapp.com/XXXXXXXX', 'https://whatsapp.com/channel/XXXXXXXX'],
    permission: 'public',
    cooldown: 5,

    async execute(sock, message, args) {
        const lines = await resolve(sock, message, args.join(' ').trim());
        const text = box(config.bot.name, lines);
        // Never post into a channel (it is public): send the result to the owner's own chat.
        if (isJidNewsletter(message.chat)) {
            const self = jidNormalizedUser(sock.user?.id);
            return sock.sendMessage(self, { text });
        }
        await message.reply(text);
    }
};
