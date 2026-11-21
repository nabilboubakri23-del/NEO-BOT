import config from '../config/config.js';
import connectionManager from '../core/connection.js';
import { box } from '../utils/formatter.js';

export default {
    name: 'ping',
    aliases: [],
    category: 'general',
    description: 'Measure bot response time.',
    permissions: ['user'],

    async execute(sock, message) {
        const status = connectionManager.isOpen ? 'Online' : 'Reconnecting';
        const start = process.hrtime.bigint();

        // Round-trip: time for WhatsApp servers to accept our message.
        const sent = await message.reply(box(config.bot.name, ['Calculating...']));
        const roundTrip = Number(process.hrtime.bigint() - start) / 1e6;
        const processing = Math.max(0, Date.now() - message.receivedAt - roundTrip);

        const text = box(config.bot.name, [
            'PONG!',
            '',
            `Response: ${Math.round(roundTrip)}ms`,
            `Processing: ${Math.round(processing)}ms`,
            `Status: ${status}`
        ]);

        try {
            await sock.sendMessage(message.chat, { text, edit: sent.key });
        } catch {
            await message.reply(text);
        }
    }
};
