import config from '../config/config.js';
import { box } from '../utils/formatter.js';

export default {
    name: 'myid',
    aliases: ['whoami', 'id'],
    category: 'system',
    description: 'Show your WhatsApp number, LID and rank.',
    permission: 'public',

    async execute(sock, message, args, ctx) {
        const { rank, isOwner: owner } = ctx.access;
        const id = message.senderNumber || message.senderLid;
        await message.reply(
            box(config.bot.name, [
                `Name: ${message.pushName || 'Unknown'}`,
                `Number: ${message.senderNumber || 'Unknown'}`,
                `LID: ${message.senderLid || 'none'}`,
                `Rank: ${rank.emoji} ${rank.label} (level ${rank.level})`,
                ...(owner ? [] : ['', 'To get a rank, ask staff to send:', `${config.bot.prefix}rank set ${id} <rank>`])
            ])
        );
    }
};
