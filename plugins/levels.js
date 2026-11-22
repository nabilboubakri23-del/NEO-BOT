import config from '../config/config.js';
import { gainMessageXp } from '../systems/economy/economyStore.js';
import { titleFor } from '../systems/economy/levels.js';
import { getGroupOption } from '../systems/moderation/groupConfig.js';
import { mentionOf } from '../utils/mentions.js';
import { box } from '../utils/formatter.js';
import { senderOf } from '../utils/targets.js';

/**
 * XP for chatting: 5–15 XP per message, at most once a minute per person (no reward for spam).
 * Level-ups are announced only in groups that turned it on: .gset levelup on
 * Disable the whole feature with: .plugins disable levels
 */

export default {
    name: 'levels',
    version: '1.0.0',
    author: 'NEO BOT',
    description: 'XP and levels from chatting (announcements opt-in per group).',
    hooks: {
        async message({ sock, message }, api) {
            if (!message.text || message.text.startsWith(config.bot.prefix)) return;
            if (!api.allows(sock, message)) return;
            const result = gainMessageXp(senderOf(message), { name: message.pushName });
            if (!result?.levelUp || !message.isGroup || !getGroupOption(message.chat, 'levelup')) return;
            const tag = mentionOf(message);
            await sock
                .sendMessage(message.chat, { text: box('LEVEL UP', [`⬆️ ${tag.text} reached level ${result.levelUp}!`, `Title: ${titleFor(result.levelUp)}`]), mentions: [tag.jid] })
                .catch(() => {});
        }
    }
};
