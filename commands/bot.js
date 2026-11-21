import config from '../config/config.js';
import { getChatSetting, setChatSetting } from '../systems/settings/settingsStore.js';
import { box, success } from '../utils/formatter.js';
import { UsageError } from '../utils/errors.js';

export default {
    name: 'bot',
    aliases: ['chatbot'],
    category: 'group',
    description: 'Turn the bot on or off in this chat (group admins).',
    usage: '<on|off|status>',
    examples: ['off', 'on'],
    permission: 'public',
    requires: ['groupAdmin'], // owners and the creator always pass
    allowWhenOff: true,
    minArgs: 1,

    async execute(sock, message, [value]) {
        const choice = String(value).toLowerCase();
        if (choice === 'status') {
            return message.reply(box(config.bot.name, [`Bot in this chat: ${getChatSetting(message.chat, 'enabled') ? 'ON' : 'OFF'}`]));
        }
        if (!['on', 'off'].includes(choice)) throw new UsageError();
        setChatSetting(message.chat, 'enabled', choice);
        await message.reply(
            success(config.bot.name, [
                choice === 'on' ? 'Bot is ON in this chat.' : 'Bot is OFF in this chat.',
                choice === 'off' ? `Admins can turn it back: ${config.bot.prefix}bot on` : null
            ])
        );
    }
};
