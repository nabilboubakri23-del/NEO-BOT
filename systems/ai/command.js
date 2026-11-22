import config from '../../config/config.js';
import { chat, isAiEnabled } from './aiClient.js';
import { forget, history, remember } from './conversations.js';
import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { personKey, senderOf } from '../../utils/targets.js';

const MAX_INPUT = 2000;
const pending = new Set();

/** Reuse the existing command pipeline. Only the AI conversation changes per character. */
export const makeAiCommand = ({ name, aliases, label = 'AI', persona = '' }) => ({
    name,
    aliases,
    category: 'ai',
    description: persona ? `Chat with ${label} (fictional AI roleplay).` : 'Ask the AI anything (reply to a message to include it).',
    usage: '<question> | reset',
    examples: ['مرحبا', 'reset'],
    permission: 'public',
    cooldown: 10,
    async execute(sock, message, args, ctx) {
        const person = `${message.chat}|${personKey(senderOf(message))}`;
        const key = `${name}|${person}`;
        if (pending.has(person)) throw new UserError('Please wait for your current AI answer before sending another AI command.');
        if (args.length === 1 && args[0].toLowerCase() === 'reset' && !ctx.body?.trim()) {
            forget(key);
            return message.reply(box(label, ['🧹 Conversation forgotten.']));
        }
        if (!isAiEnabled()) throw new UserError('AI chat is not set up. The owner must set GROQ_API_KEY (Groq) or AI_API_KEY on the server.');
        const question = [ctx.argsText, ctx.body].filter(Boolean).join('\n').trim();
        if (!question) throw new UsageError();
        const quoted = message.quoted?.text ? `Message I am replying to:\n"""${message.quoted.text.slice(0, MAX_INPUT)}"""\n\n` : '';
        const prompt = `${quoted}${question}`.slice(0, MAX_INPUT * 2);
        pending.add(person);
        try {
            await sock.sendPresenceUpdate?.('composing', message.chat)?.catch(() => {});
            const answer = await chat([...history(key), { role: 'user', content: prompt }], { systemPrompt: persona });
            await message.reply(`🤖 ${answer}\n\n_${config.bot.name} ${label}_`);
            remember(key, prompt, answer);
        } finally {
            pending.delete(person);
        }
    }
});
