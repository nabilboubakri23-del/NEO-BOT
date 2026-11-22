import config from '../../config/config.js';
import sessionManager from '../../core/sessionManager.js';
import { cleanSession } from '../../systems/session/sessionCleaner.js';
import { box } from '../../utils/formatter.js';

const P = config.bot.prefix;

export default {
    name: 'session',
    aliases: ['sess'],
    category: 'owner',
    description: 'Show the session size or clean stale session entries now.',
    usage: '[clean]',
    examples: ['', 'clean'],
    permission: 'owner',

    async execute(sock, message, args) {
        const { threshold, minAgeMs, enabled } = config.sessionCleanup;
        const hours = Math.round(minAgeMs / 3600000);
        if ((args[0] || '').toLowerCase() === 'clean') {
            const { before, removed, after } = await cleanSession({ force: true });
            return message.reply(
                box('SESSION', [`🧹 Removed ${removed} stale entries.`, `Entries: ${before} → ${after}`, '', `Kept: credentials, keys, and anything used in the last ${hours}h.`])
            );
        }
        const count = await sessionManager.fileCount();
        return message.reply(
            box('SESSION', [
                `Entries: ${count}`,
                `Auto clean: ${enabled ? `on (above ${threshold})` : 'off'}`,
                `Removes: entries unused for ${hours}h+`,
                '',
                `${P}session clean  → clean now`
            ])
        );
    }
};
