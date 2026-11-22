import config from '../config/config.js';
import { chat, isAiEnabled } from '../systems/ai/aiClient.js';
import { forget, history, remember } from '../systems/ai/conversations.js';
import { box } from '../utils/formatter.js';
import { UsageError, UserError } from '../utils/errors.js';
import { personKey, senderOf } from '../utils/targets.js';

/**
 * .ai <question> — chat with an AI (OpenAI-compatible API; the owner sets AI_API_KEY).
 * Replying to a message adds its text as context. It remembers your last few turns
 * for 10 minutes; ".ai reset" forgets them.
 */

const MAX_INPUT = 2000;

export default {
    name: 'ai',
    aliases: ['ask', 'gpt'],
    category: 'ai',
    description: 'Ask the AI anything (reply to a message to include it).',
    usage: '<question> | reset',
    examples: ['explain black holes simply', 'reset'],
    permission: 'public',
    cooldown: 10,

    async execute(sock, message, args, ctx) {
        const key = `${message.chat}|${personKey(senderOf(message))}`;
        if (args.length === 1 && args[0].toLowerCase() === 'reset') {
            forget(key);
            return message.reply(box('AI', ['🧹 Conversation forgotten.']));
        }
        if (!isAiEnabled()) throw new UserError('AI chat is not set up. The owner must set AI_API_KEY on the server.');
        const question = [ctx.argsText, ctx.body].filter(Boolean).join('\n').trim();
        if (!question) throw new UsageError();
        const quoted = message.quoted?.text ? `Message I am replying to:\n"""${message.quoted.text.slice(0, MAX_INPUT)}"""\n\n` : '';
        const prompt = `${quoted}${question}`.slice(0, MAX_INPUT * 2);
        sock.sendPresenceUpdate?.('composing', message.chat).catch(() => {});
        const answer = await chat([...history(key), { role: 'user', content: prompt }]);
        remember(key, prompt, answer);
        await message.reply(`🤖 ${answer}\n\n_${config.bot.name} AI_`);
    }
};
