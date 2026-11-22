import config from '../../config/config.js';
import { rankOfTarget } from '../../systems/permissions/resolveRank.js';
import { box } from '../../utils/formatter.js';
import { resolveUserTarget } from '../../utils/targets.js';

/**
 * .myid — your number, LID and rank; with a @mention, a reply or a number,
 * the same for that person (handy when granting ranks in LID-only groups).
 * Group and channel IDs: .jid
 */
export default {
    name: 'myid',
    aliases: ['whoami', 'id', 'userid'],
    category: 'system',
    description: 'Show the WhatsApp number, LID and rank of you or someone else.',
    usage: '[number|@mention|reply]',
    permission: 'public',

    async execute(sock, message, args, ctx) {
        const other = args.length || message.mentions?.length || message.quoted ? await resolveUserTarget(sock, message, args[0]) : null;
        if (other) {
            const rank = rankOfTarget(other);
            return message.reply(
                box(config.bot.name, [
                    `Number: ${other.number || 'Unknown'}`,
                    `LID: ${other.lid || 'none'}`,
                    `Rank: ${rank.emoji} ${rank.label} (level ${rank.level})`,
                    message.isGroup ? `Chat: ${message.chat}` : null
                ])
            );
        }
        const { rank, isOwner: owner } = ctx.access;
        const id = message.senderNumber || message.senderLid;
        await message.reply(
            box(config.bot.name, [
                `Name: ${message.pushName || 'Unknown'}`,
                `Number: ${message.senderNumber || 'Unknown'}`,
                `LID: ${message.senderLid || 'none'}`,
                `Rank: ${rank.emoji} ${rank.label} (level ${rank.level})`,
                message.isGroup ? `Chat: ${message.chat}` : null,
                ...(owner ? [] : ['', 'To get a rank, ask staff to send:', `${config.bot.prefix}rank set ${id} <rank>`])
            ])
        );
    }
};
