import governor from '../../systems/antiban/index.js';
import { box } from '../../utils/formatter.js';

export default {
    name: 'antiban',
    aliases: ['sendstats'],
    category: 'owner',
    description: 'Show the anti-ban send governor status.',
    permission: 'owner',
    async execute(sock, message) {
        const s = governor.status();
        await message.reply(
            box('ANTI-BAN', [
                `Status: ${s.enabled ? 'on' : 'off'}`,
                `Sent last hour: ${s.lastHour}/${s.perHour}`,
                `Rate: ${s.perMinute}/min (burst limited)`,
                `Queued now: ${s.queued}`,
                `Dropped: ${s.dropped}`,
                `Rate limits from WhatsApp: ${s.rateLimited}`,
                s.pausedMs ? `⏸️ Paused: ${Math.ceil(s.pausedMs / 1000)} s` : 'Not paused',
                '',
                'No cold DMs · no repeated texts · one reply at a time per chat'
            ])
        );
    }
};
