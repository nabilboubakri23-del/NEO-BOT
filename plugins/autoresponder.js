import config from '../config/config.js';
import { NoticeLimiter } from '../systems/security/noticeLimiter.js';
import { findReaction, findReply, normalizeTrigger, parseRule } from '../systems/automation/responders.js';
import { box } from '../utils/formatter.js';
import { UsageError, UserError } from '../utils/errors.js';

/**
 * Auto-replies and auto-reactions, OFF in every chat until switched on there.
 *   .autoreply on|off                       this chat (group admins / owners)
 *   .autoreply add <trigger> | <reply> [| another reply]   owners
 *   .autoreply del <trigger> · .autoreply list
 *   .autoreact on|off · add <trigger> | <emoji> [| emoji] · del · list   (same rules)
 * Replies fire on an exact message; reactions on a word or phrase inside it.
 * Each trigger answers at most once per 15 s per chat, so it can never flood a group.
 */

const P = config.bot.prefix;
const DOC = 'rules'; // { reply: { chats: {}, rules: {} }, react: { chats: {}, rules: {} } }
const MAX_RULES = 100;
const limiter = new NoticeLimiter(15_000, 1000);

const open = (api) => api.store.open(DOC, () => ({ reply: { chats: {}, rules: {} }, react: { chats: {}, rules: {} } }));

const manage = (kind) => async (sock, message, args, ctx) => {
    const store = await open(ctx.api);
    const section = store[kind];
    const title = kind === 'reply' ? 'AUTO-REPLY' : 'AUTO-REACT';
    const sub = String(args[0] || 'status').toLowerCase();
    const save = () => ctx.api.store.touch(DOC);

    if (['on', 'off'].includes(sub)) {
        if (message.isGroup && !ctx.access.isOwner && !(await ctx.access.isAdmin())) throw new UserError('Group admins only.');
        if (sub === 'on') section.chats[message.chat] = true;
        else delete section.chats[message.chat];
        save();
        return message.reply(box(title, [`${sub === 'on' ? '✅ ON' : '⏸️ OFF'} in this chat.`, `${Object.keys(section.rules).length} trigger(s) defined.`]));
    }
    if (sub === 'list') {
        const rules = Object.entries(section.rules);
        return message.reply(box(title, rules.length ? rules.map(([t, v]) => `• ${t} → ${v.join(' / ')}`) : ['No triggers yet.', `${P}auto${kind} add <trigger> | <${kind === 'reply' ? 'reply' : 'emoji'}>`]));
    }
    if (sub === 'add' || sub === 'del') {
        if (!ctx.access.isOwner) throw new UserError('Only owners can change triggers.');
        const rest = (ctx.argsText || '').replace(/^\s*\S+\s*/, '');
        if (sub === 'del') {
            const trigger = normalizeTrigger(rest);
            if (!section.rules[trigger]) throw new UserError(`No trigger "${trigger}".`);
            delete section.rules[trigger];
            save();
            return message.reply(box(title, [`🗑️ Removed: ${trigger}`]));
        }
        const { trigger, values } = parseRule(rest);
        if (!trigger || !values.length) throw new UsageError(`${P}auto${kind} add <trigger> | <${kind === 'reply' ? 'reply' : 'emoji'}>`);
        if (!section.rules[trigger] && Object.keys(section.rules).length >= MAX_RULES) throw new UserError(`At most ${MAX_RULES} triggers.`);
        section.rules[trigger] = values.map((v) => v.slice(0, 500));
        save();
        return message.reply(box(title, [`✅ ${trigger} → ${section.rules[trigger].join(' / ')}`]));
    }
    return message.reply(box(title, [`Here: ${section.chats[message.chat] ? 'ON' : 'OFF'}`, `Triggers: ${Object.keys(section.rules).length}`, '', `${P}auto${kind} on|off|list|add|del`]));
};

const command = (kind, description) => ({
    name: `auto${kind}`,
    category: 'automation',
    description,
    usage: 'on|off|list|add <trigger> | <value>|del <trigger>',
    permission: 'public',
    cooldown: 3,
    execute: manage(kind)
});

export default {
    name: 'autoresponder',
    version: '1.0.0',
    author: 'NEO BOT',
    description: 'Owner-defined auto-replies and auto-reactions, off by default per chat.',
    commands: [command('reply', 'Automatic replies to exact messages (off by default).'), command('react', 'Automatic emoji reactions to words (off by default).')],
    hooks: {
        async message({ sock, message }, api) {
            if (!message.text || message.text.startsWith(P)) return;
            const store = await open(api);
            const replyOn = store.reply.chats[message.chat];
            const reactOn = store.react.chats[message.chat];
            if (!replyOn && !reactOn) return;
            if (!api.allows(sock, message)) return;
            if (reactOn) {
                const emoji = findReaction(store.react.rules, message.text);
                if (emoji && limiter.allow(`${message.chat}|react|${emoji}|${message.senderNumber}`)) await message.react(emoji).catch(() => {});
            }
            if (replyOn) {
                const reply = findReply(store.reply.rules, message.text);
                if (reply && limiter.allow(`${message.chat}|reply|${normalizeTrigger(message.text)}`)) await message.reply(reply).catch(() => {});
            }
        }
    }
};
