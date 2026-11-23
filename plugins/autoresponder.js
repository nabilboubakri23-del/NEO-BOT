import config from '../config/config.js';
import { NoticeLimiter } from '../systems/security/noticeLimiter.js';
import {
    DEFAULT_EMOJIS,
    fillPlaceholders,
    findReaction,
    findReply,
    normalizeTrigger,
    parseEmojis,
    parseRule,
    reactMode
} from '../systems/automation/responders.js';
import { box } from '../utils/formatter.js';
import { UsageError, UserError } from '../utils/errors.js';

/**
 * Auto-replies and auto-reactions. OFF everywhere until switched on.
 *
 *   .autoreact on | all          react to every message in this chat (trigger words pick the emoji)
 *   .autoreact words             react only to trigger words
 *   .autoreact owner             react only to messages from owners and above (owner+ to set)
 *   .autoreact off
 *   .autoreact global <mode|off> default for every chat without its own setting (owner+)
 *   .autoreact emojis 😂 🔥 ❤️ | reset   emoji pool for "all"/"owner" (owner+)
 *   .autoreact add <word> | <emoji> [| emoji] · del <word> · list   (owner+)
 *
 *   .autoreply on|off · global on|off (owner+) · add <trigger> | <reply> [| reply] · del · list
 *       "*word" as trigger = anywhere in the message; replies may use {name} {number} {time} {date}
 *
 * Group admins switch their own group; only owners change triggers, global defaults and owner mode.
 * Every action is rate-limited per chat and per sender, so it can never flood a group.
 * The linked account's own messages get reactions in "all"/"owner" mode, never auto-replies.
 */

const P = config.bot.prefix;
const DOC = 'rules';
const MAX_RULES = 100;
const TIME_ZONE = process.env.BOT_TIMEZONE || 'Africa/Casablanca';

const replyLimiter = new NoticeLimiter(15_000, 1000); // per chat + trigger
const wordLimiter = new NoticeLimiter(15_000, 1000); // per chat + emoji + sender
const senderLimiter = new NoticeLimiter(20_000, 2000); // "all": one reaction per sender per 20 s
const chatLimiter = new NoticeLimiter(3_000, 1000); // "all": at most one reaction per chat per 3 s
const ownerLimiter = new NoticeLimiter(2_000, 500); // "owner": per chat + sender

const EMPTY = () => ({ reply: { chats: {}, rules: {}, global: false }, react: { chats: {}, rules: {}, global: null, emojis: [] } });

const open = async (api) => {
    const doc = await api.store.open(DOC, EMPTY);
    // Documents written by v1.4 lack the newer fields.
    const fresh = EMPTY();
    for (const kind of ['reply', 'react']) doc[kind] = { ...fresh[kind], ...(doc[kind] || {}) };
    return doc;
};

/** Effective auto-react mode in a chat: its own setting, else the global default. */
export const reactModeFor = (store, chat) => {
    const own = store.react.chats[chat];
    if (own === 'off' || own === false) return null;
    return reactMode(own) || reactMode(store.react.global);
};

const replyOnFor = (store, chat) => {
    const own = store.reply.chats[chat];
    if (own === false || own === 'off') return false;
    return own === true || Boolean(store.reply.global);
};

const MODE_LABEL = {
    all: '🌐 every message',
    words: '🔤 trigger words only',
    owner: '👑 owners and above only'
};

const canSwitchChat = async (message, ctx) => {
    if (ctx.access.isOwner) return true;
    if (!message.isGroup) return false; // private chats: owners only
    return ctx.access.isAdmin();
};

const requireOwner = (ctx, what) => {
    if (!ctx.access.isOwner) throw new UserError(`Only owners can ${what}.`);
};

const rulesCommand = async (section, sub, rest, ctx, title, valueName) => {
    requireOwner(ctx, 'change triggers');
    if (sub === 'del') {
        const trigger = normalizeTrigger(rest);
        if (!section.rules[trigger]) throw new UserError(`No trigger "${trigger}".`);
        delete section.rules[trigger];
        return [`🗑️ Removed: ${trigger}`];
    }
    const { trigger, values } = parseRule(rest);
    if (!trigger || !values.length) throw new UsageError(`add <trigger> | <${valueName}>`);
    if (!section.rules[trigger] && Object.keys(section.rules).length >= MAX_RULES) throw new UserError(`At most ${MAX_RULES} triggers.`);
    section.rules[trigger] = valueName === 'emoji' ? parseEmojis(values.join(' ')) : values.map((v) => v.slice(0, 500));
    if (!section.rules[trigger].length) throw new UserError('Give at least one emoji.');
    return [`✅ ${trigger} → ${section.rules[trigger].join(' / ')}`];
};

const listLines = (section, valueName) => {
    const rules = Object.entries(section.rules);
    return rules.length ? rules.map(([t, v]) => `• ${t} → ${v.join(' / ')}`) : ['No triggers yet.', `add <trigger> | <${valueName}>`];
};

async function reactCommand(sock, message, args, ctx) {
    const store = await open(ctx.api);
    const section = store.react;
    const title = 'AUTO-REACT';
    const save = () => ctx.api.store.touch(DOC);
    const sub = String(args[0] || 'status').toLowerCase();
    const rest = (ctx.argsText || '').replace(/^\s*\S+\s*/, '');
    const reply = (lines) => message.reply(box(title, lines));

    if (['on', 'all', 'words', 'owner', 'off'].includes(sub)) {
        const mode = sub === 'on' ? 'all' : sub;
        if (mode === 'owner') requireOwner(ctx, 'use owner mode');
        else if (!(await canSwitchChat(message, ctx))) throw new UserError(message.isGroup ? 'Group admins only.' : 'Owners only in private chats.');
        section.chats[message.chat] = mode;
        save();
        const lines = [mode === 'off' ? '⏸️ OFF in this chat.' : `✅ ON here: ${MODE_LABEL[mode]}.`];
        if (mode === 'words' && !Object.keys(section.rules).length) lines.push('⚠️ No trigger words yet, so nothing will happen.', `Owner: ${P}autoreact add hello | 👋`);
        return reply(lines);
    }
    if (sub === 'global') {
        requireOwner(ctx, 'set the global default');
        const value = String(args[1] || '').toLowerCase();
        const mode = value === 'on' ? 'all' : value;
        if (!['all', 'words', 'owner', 'off'].includes(mode)) throw new UsageError(`${P}autoreact global all|words|owner|off`);
        section.global = mode === 'off' ? null : mode;
        save();
        return reply([mode === 'off' ? '⏸️ Global default: OFF.' : `🌍 Global default: ${MODE_LABEL[mode]}.`, 'Chats with their own setting keep it.']);
    }
    if (sub === 'emojis') {
        requireOwner(ctx, 'change the emoji pool');
        if (/^reset$/i.test(rest.trim())) section.emojis = [];
        else {
            const list = parseEmojis(rest);
            if (!list.length) throw new UsageError(`${P}autoreact emojis 😂 🔥 ❤️  |  ${P}autoreact emojis reset`);
            section.emojis = list;
        }
        save();
        return reply([`🎨 Pool: ${(section.emojis.length ? section.emojis : DEFAULT_EMOJIS).join(' ')}`]);
    }
    if (sub === 'list') return reply(listLines(section, 'emoji'));
    if (sub === 'add' || sub === 'del') {
        const lines = await rulesCommand(section, sub, rest, ctx, title, 'emoji');
        save();
        return reply(lines);
    }
    const mode = reactModeFor(store, message.chat);
    const own = section.chats[message.chat];
    return reply([
        `Here: ${mode ? MODE_LABEL[mode] : 'OFF'}${own === undefined && mode ? ' (global)' : ''}`,
        `Global: ${section.global ? MODE_LABEL[section.global] : 'OFF'}`,
        `Triggers: ${Object.keys(section.rules).length} · Pool: ${(section.emojis.length ? section.emojis : DEFAULT_EMOJIS).join(' ')}`,
        '',
        `${P}autoreact on|words|owner|off`,
        `${P}autoreact global <mode|off> · emojis · add · del · list`
    ]);
}

async function replyCommand(sock, message, args, ctx) {
    const store = await open(ctx.api);
    const section = store.reply;
    const title = 'AUTO-REPLY';
    const save = () => ctx.api.store.touch(DOC);
    const sub = String(args[0] || 'status').toLowerCase();
    const rest = (ctx.argsText || '').replace(/^\s*\S+\s*/, '');
    const reply = (lines) => message.reply(box(title, lines));
    const count = Object.keys(section.rules).length;
    const noRules = ['⚠️ No triggers yet, so nothing will happen.', `Owner: ${P}autoreply add hi | Hello {name}!`];

    if (sub === 'on' || sub === 'off') {
        if (!(await canSwitchChat(message, ctx))) throw new UserError(message.isGroup ? 'Group admins only.' : 'Owners only in private chats.');
        section.chats[message.chat] = sub === 'on';
        save();
        return reply([sub === 'on' ? '✅ ON in this chat.' : '⏸️ OFF in this chat.', ...(sub === 'on' && !count ? noRules : [`${count} trigger(s) defined.`])]);
    }
    if (sub === 'global') {
        requireOwner(ctx, 'set the global default');
        const value = String(args[1] || '').toLowerCase();
        if (!['on', 'off'].includes(value)) throw new UsageError(`${P}autoreply global on|off`);
        section.global = value === 'on';
        save();
        return reply([`🌍 Global default: ${value.toUpperCase()}.`, 'Chats switched off on their own stay off.', ...(value === 'on' && !count ? noRules : [])]);
    }
    if (sub === 'list') return reply(listLines(section, 'reply'));
    if (sub === 'add' || sub === 'del') {
        const lines = await rulesCommand(section, sub, rest, ctx, title, 'reply');
        save();
        return reply(lines);
    }
    return reply([
        `Here: ${replyOnFor(store, message.chat) ? 'ON' : 'OFF'} · Global: ${section.global ? 'ON' : 'OFF'}`,
        `Triggers: ${count}`,
        '',
        `${P}autoreply on|off · global on|off`,
        `${P}autoreply add <trigger> | <reply> [| reply]`,
        '"*word" = anywhere in the message · {name} {number} {time} {date}',
        `${P}autoreply del <trigger> · list`
    ]);
}

const command = (kind, description, execute) => ({
    name: `auto${kind}`,
    category: 'automation',
    description,
    usage: kind === 'react' ? 'on|words|owner|off|global|emojis|add|del|list' : 'on|off|global|add <trigger> | <reply>|del|list',
    permission: 'public',
    cooldown: 3,
    execute
});

const hasContent = (message) => Boolean(message.text || message.mediaType);
const pool = (store) => (store.react.emojis?.length ? store.react.emojis : DEFAULT_EMOJIS);
const randomOf = (list) => list[Math.floor(Math.random() * list.length)];

/** Emoji to react with, or null (also applies the rate limits). */
export const chooseReaction = (store, mode, message, { isOwnerSender }) => {
    const text = message.text || '';
    const word = findReaction(store.react.rules, text);
    const sender = message.senderNumber || message.sender;
    if (mode === 'words') return word && wordLimiter.allow(`${message.chat}|${word}|${sender}`) ? word : null;
    if (mode === 'owner') {
        if (!isOwnerSender) return null;
        return ownerLimiter.allow(`${message.chat}|${sender}`) ? word || randomOf(pool(store)) : null;
    }
    if (mode === 'all') {
        if (!senderLimiter.allow(`${message.chat}|${sender}`)) return null;
        if (!chatLimiter.allow(message.chat)) return null;
        return word || randomOf(pool(store));
    }
    return null;
};

export default {
    name: 'autoresponder',
    version: '2.0.0',
    author: 'NEO BOT',
    description: 'Auto-replies and auto-reactions (every message, trigger words, or owners only), off by default.',
    commands: [
        command('reply', 'Automatic replies to messages (off by default).', replyCommand),
        command('react', 'Automatic emoji reactions: every message, trigger words, or owners only.', reactCommand)
    ],
    hooks: {
        async message({ sock, message }, api) {
            if (!hasContent(message) || message.text.startsWith(P)) return;
            const store = await open(api);
            const mode = reactModeFor(store, message.chat);
            const replyOn = replyOnFor(store, message.chat) && message.text;
            if (!mode && !replyOn) return;
            const isOwnerSender = api.ranks.atLeast(message, 'owner');
            if (!isOwnerSender && !api.allows(sock, message)) return;

            if (mode) {
                const emoji = chooseReaction(store, mode, message, { isOwnerSender });
                if (emoji) message.react(emoji).catch((e) => api.logger.debug(`react failed: ${e?.message}`));
            }
            if (replyOn) {
                const template = findReply(store.reply.rules, message.text);
                if (template && replyLimiter.allow(`${message.chat}|${normalizeTrigger(message.text)}`)) {
                    let text = template;
                    try {
                        text = fillPlaceholders(template, { name: message.pushName, number: message.senderNumber, timeZone: TIME_ZONE });
                    } catch {
                        text = fillPlaceholders(template, { name: message.pushName, number: message.senderNumber });
                    }
                    message.reply(text).catch((e) => api.logger.debug(`auto-reply failed: ${e?.message}`));
                }
            }
        },
        // The linked account's own (non-command) messages: reactions only, never replies.
        async 'message:self'({ message }, api) {
            if (!hasContent(message) || message.text.startsWith(P)) return;
            const store = await open(api);
            const mode = reactModeFor(store, message.chat);
            if (mode !== 'owner' && mode !== 'all') return;
            const emoji = chooseReaction(store, mode, message, { isOwnerSender: true });
            if (emoji) message.react(emoji).catch((e) => api.logger.debug(`react failed: ${e?.message}`));
        }
    }
};
