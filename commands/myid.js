import config from '../config/config.js';
import commandHandler from '../core/commandHandler.js';
import { box } from '../utils/formatter.js';

export default {
    name: 'myid',
    aliases: ['whoami', 'id'],
    category: 'system',
    description: 'Show your WhatsApp number, LID and owner status.',
    permissions: ['user'],

    async execute(sock, message) {
        const owner = commandHandler.isOwner(message);
        const id = message.senderNumber || message.senderLid;
        await message.reply(
            box(config.bot.name, [
                `Name: ${message.pushName || 'Unknown'}`,
                `Number: ${message.senderNumber || 'Unknown'}`,
                `LID: ${message.senderLid || 'none'}`,
                `Owner: ${owner ? 'Yes' : 'No'}`,
                ...(owner ? [] : ['', 'Ask the main owner to send:', `${config.bot.prefix}owner add ${id}`])
            ])
        );
    }
};
