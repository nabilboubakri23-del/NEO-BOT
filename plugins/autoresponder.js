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
import { sendListMenu } from '../systems/menus/interactiveMenu.js';
import { DEFAULT_OWNER_EMOJIS, detectMood, MOODS, moodEmoji, OWNER_EXCLUSIVE } from '../systems/automation/mood.js';
import { UsageError, UserError } from '../utils/errors.js';

/**
 * Auto-replies and auto-reactions. OFF everywhere until switched on.
 *
 *   .autoreact smart             react only when a mood is detected (laugh, love, sad, thanks...)
 *   .autoreact on | all          react to every message (mood → trigger word → random emoji)
 *   .autoreact words             react only to trigger words
 *   .autoreact owner             react only to messages from owners and above (owner+ to set)
 *   .autoreact off
 *   .autoreact global <mode|off> default for every chat without its own setting (owner+)
 *   .autoreact emojis 😂 🔥 ❤️ | reset   public emoji pool (owner+; owner-only emojis refused)
 *   .autoreact vip 👑 💎 | reset         owner-only pool (owner+); never used on anyone else
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
const smartLimiter = new NoticeLimiter(8_000, 2000); // "smart": per chat + sender

const EMPTY = () => ({ reply: { chats: {}, rules: {}, global: false }, react: { chats: {}, rules: {}, global: null, emojis: [], ownerEmojis: [] } });

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
    smart: '🧠 smart (reacts to the mood)',
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
    const reply = (lines) => (ctx.respond ? ctx.respond(lines) : message.reply(box(title, lines)));

    if (sub === 'status' || sub === 'menu' || sub === 'help') return reactPanel(sock, message, ctx, store);
    if (['on', 'all', 'smart', 'words', 'owner', 'off'].includes(sub)) {
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
        if (!['all', 'smart', 'words', 'owner', 'off'].includes(mode)) throw new UsageError(`${P}autoreact global smart|all|words|owner|off`);
        section.global = mode === 'off' ? null : mode;
        save();
        return reply([mode === 'off' ? '⏸️ Global default: OFF.' : `🌍 Global default: ${MODE_LABEL[mode]}.`, 'Chats with their own setting keep it.']);
    }
    if (sub === 'emojis' || sub === 'vip') {
        requireOwner(ctx, 'change the emoji pools');
        const field = sub === 'vip' ? 'ownerEmojis' : 'emojis';
        const notes = [];
        if (/^reset$/i.test(rest.trim())) section[field] = [];
        else {
            let list = parseEmojis(rest);
            if (sub === 'emojis') {
                const reserved = list.filter((e) => OWNER_EXCLUSIVE.has(e) || (section.ownerEmojis || []).includes(e));
                list = list.filter((e) => !reserved.includes(e));
                if (reserved.length) notes.push(`👑 Kept for owners only: ${reserved.join(' ')}`);
            }
            if (!list.length) throw new UsageError(`${P}autoreact ${sub} ${sub === 'vip' ? '👑 💎' : '😂 🔥 ❤️'}  |  ${P}autoreact ${sub} reset`);
            section[field] = list;
            if (sub === 'vip') section.emojis = section.emojis.filter((e) => !list.includes(e));
        }
        save();
        return reply([`🎨 Everyone: ${pool(store).join(' ')}`, `👑 Owners: ${ownerPool(store).join(' ')}`, ...notes]);
    }
    if (sub === 'list') return reply(listLines(section, 'emoji'));
    if (sub === 'add' || sub === 'del') {
        const lines = await rulesCommand(section, sub, rest, ctx, title, 'emoji');
        save();
        return reply(lines);
    }
    throw new UsageError(`${P}autoreact  (opens the panel)`);
}

async function replyCommand(sock, message, args, ctx) {
    const store = await open(ctx.api);
    const section = store.reply;
    const title = 'AUTO-REPLY';
    const save = () => ctx.api.store.touch(DOC);
    const sub = String(args[0] || 'status').toLowerCase();
    const rest = (ctx.argsText || '').replace(/^\s*\S+\s*/, '');
    const reply = (lines) => (ctx.respond ? ctx.respond(lines) : message.reply(box(title, lines)));
    const count = Object.keys(section.rules).length;
    if (sub === 'status' || sub === 'menu' || sub === 'help') return replyPanel(sock, message, ctx, store);
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
    throw new UsageError(`${P}autoreply  (opens the panel)`);
}

// ── Button panels ─────────────────────────────────────────────────────────

const row = (id, title, description = '') => ({ id, title: title.slice(0, 24), description: description.slice(0, 72) });
const mark = (on) => (on ? '● ' : '');

async function reactPanel(sock, message, ctx, store, notice = []) {
    const section = store.react;
    const mode = reactModeFor(store, message.chat);
    const own = section.chats[message.chat];
    const isOwner = ctx.access.isOwner;
    const canSwitch = await canSwitchChat(message, ctx);
    const body = box('AUTO-REACT', [
        ...(notice.length ? [...notice, ''] : []),
        `Here: ${mode ? MODE_LABEL[mode] : 'OFF'}${own === undefined && mode ? ' (global)' : ''}`,
        `All chats: ${section.global ? MODE_LABEL[section.global] : 'OFF'}`,
        `Emojis: ${pool(store).join(' ')}`,
        ...(isOwner ? [`👑 Owner-only: ${ownerPool(store).join(' ')}`] : []),
        `Trigger words: ${Object.keys(section.rules).length}`,
        '',
        '🧠 Smart: reacts to the mood of a message',
        `   ${Object.values(MOODS).map((m) => m.label.split(' ')[0]).join(' ')}`,
        '   ههههه → 😂 · احبك → ❤️ · شكرا → 🙏 · مبروك → 🎉',
        '🌐 All: every message (mood first, else random)',
        '🔤 Words: only your trigger words',
        '👑 Owner: only owners and above, with owner-only emojis',
        '',
        'Owners can also type:',
        `${P}autoreact add hello | 👋 🔥`,
        `${P}autoreact emojis 😂 🔥 ❤️`,
        `${P}autoreact vip 👑 💎 ⚡`
    ]);
    const sections = [];
    if (canSwitch) {
        const rows = [
            row('autoreact:set:smart', `${mark(mode === 'smart' && own !== undefined)}🧠 Smart (mood)`, 'React only when a feeling is detected'),
            row('autoreact:set:all', `${mark(mode === 'all' && own !== undefined)}🌐 All messages`, 'React to every message in this chat'),
            row('autoreact:set:words', `${mark(mode === 'words' && own !== undefined)}🔤 Trigger words`, 'React only to the words you added'),
            ...(isOwner ? [row('autoreact:set:owner', `${mark(mode === 'owner' && own !== undefined)}👑 Owners only`, 'Only owners, with owner-only emojis')] : []),
            row('autoreact:set:off', `${mark(own === 'off')}⛔ Off here`, 'No reactions in this chat')
        ];
        sections.push({ title: 'THIS CHAT', rows });
    }
    if (isOwner) {
        const g = section.global;
        sections.push({
            title: 'ALL CHATS (OWNER)',
            rows: [
                row('autoreact:global:smart', `${mark(g === 'smart')}🌍 Smart everywhere`, 'Mood reactions in every chat'),
                row('autoreact:global:owner', `${mark(g === 'owner')}🌍 Owners everywhere`, 'React to owners in every chat'),
                row('autoreact:global:off', `${mark(!g)}🌍 Off`, 'Chats keep their own setting')
            ]
        });
    }
    sections.push({
        title: 'MORE',
        rows: [
            row('autoreact:list', '📋 Trigger words', 'Show the words and their emojis'),
            ...(isOwner ? [row('autoreact:emojis:reset', '🎨 Reset emojis', 'Back to the default public emojis')] : [])
        ]
    });
    return sendListMenu(
        sock,
        message.chat,
        { title: config.bot.name, body, footer: config.bot.footer || '', buttonText: 'OPTIONS', sections },
        { quoted: message.raw, fallbackText: `${body}\n\n${P}autoreact smart | on | words | owner | off\n${P}autoreact global smart | all | owner | off` }
    );
}

async function replyPanel(sock, message, ctx, store, notice = []) {
    const section = store.reply;
    const here = replyOnFor(store, message.chat);
    const own = section.chats[message.chat];
    const isOwner = ctx.access.isOwner;
    const canSwitch = await canSwitchChat(message, ctx);
    const count = Object.keys(section.rules).length;
    const body = box('AUTO-REPLY', [
        ...(notice.length ? [...notice, ''] : []),
        `Here: ${here ? 'ON' : 'OFF'}${own === undefined && here ? ' (global)' : ''} · All chats: ${section.global ? 'ON' : 'OFF'}`,
        `Triggers: ${count}`,
        ...(count ? [] : ['⚠️ No triggers yet, so nothing will be answered.']),
        '',
        'The bot answers a message that matches a trigger.',
        'hi → only the exact message "hi"',
        '*price → "price" anywhere in the message',
        'Several replies with | : one is picked at random',
        'In replies: {name} {number} {time} {date}',
        '',
        'Owners type:',
        `${P}autoreply add hi | Hello {name}! | Hey!`,
        `${P}autoreply add *price | Ask an admin 🙏`,
        `${P}autoreply del hi`
    ]);
    const sections = [];
    if (canSwitch) {
        sections.push({
            title: 'THIS CHAT',
            rows: [
                row('autoreply:set:on', `${mark(own === true)}✅ On here`, 'Answer triggers in this chat'),
                row('autoreply:set:off', `${mark(own === false)}⛔ Off here`, 'Never answer in this chat')
            ]
        });
    }
    if (isOwner) {
        sections.push({
            title: 'ALL CHATS (OWNER)',
            rows: [
                row('autoreply:global:on', `${mark(section.global)}🌍 On everywhere`, 'Default for every chat'),
                row('autoreply:global:off', `${mark(!section.global)}🌍 Off everywhere`, 'Chats keep their own setting')
            ]
        });
    }
    sections.push({ title: 'MORE', rows: [row('autoreply:list', '📋 Triggers', 'Show every trigger and its replies')] });
    return sendListMenu(
        sock,
        message.chat,
        { title: config.bot.name, body, footer: config.bot.footer || '', buttonText: 'OPTIONS', sections },
        { quoted: message.raw, fallbackText: `${body}\n\n${P}autoreply on | off\n${P}autoreply global on | off` }
    );
}

/** A tap in a panel: run the action, then show the panel again with the result on top. */
const onPanelSelect = (kind) => async (sock, message, parts, ctx) => {
    const [action, value] = parts;
    const args = action === 'set' ? [value] : action === 'list' ? ['list'] : [action, value].filter(Boolean);
    const run = kind === 'react' ? reactCommand : replyCommand;
    let result = [];
    const inner = { ...ctx, argsText: args.join(' '), respond: (lines) => (result = lines) };
    await run(sock, message, args, inner);
    if (action === 'list') return message.reply(box(kind === 'react' ? 'AUTO-REACT' : 'AUTO-REPLY', result));
    const store = await open(ctx.api);
    return kind === 'react' ? reactPanel(sock, message, ctx, store, result) : replyPanel(sock, message, ctx, store, result);
};

const command = (kind, description, execute) => ({
    name: `auto${kind}`,
    category: 'automation',
    description,
    usage: kind === 'react' ? '[smart|on|words|owner|off|global|emojis|vip|add|del|list]' : '[on|off|global|add <trigger> | <reply>|del|list]',
    permission: 'public',
    cooldown: 1, // panel taps come in quick succession
    execute,
    onSelect: onPanelSelect(kind)
});

const hasContent = (message) => Boolean(message.text || message.mediaType);
const randomOf = (list) => list[Math.floor(Math.random() * list.length)];
const isReserved = (store, emoji) => OWNER_EXCLUSIVE.has(emoji) || (store.react.ownerEmojis || []).includes(emoji);
/** Public pool: never contains an owner-only emoji. */
const pool = (store) => {
    const list = (store.react.emojis?.length ? store.react.emojis : DEFAULT_EMOJIS).filter((e) => !isReserved(store, e));
    return list.length ? list : DEFAULT_EMOJIS;
};
const ownerPool = (store) => (store.react.ownerEmojis?.length ? store.react.ownerEmojis : DEFAULT_OWNER_EMOJIS);

/**
 * Emoji to react with, or null (also applies the rate limits).
 * Order: the message's mood → an owner's trigger word → a random emoji (only in "all"/"owner").
 * Owners get owner-only emojis; nobody else ever does.
 */
export const chooseReaction = (store, mode, message, { isOwnerSender }) => {
    const text = message.text || '';
    const sender = message.senderNumber || message.sender;
    const mood = text ? detectMood(text) : null;
    let word = findReaction(store.react.rules, text);
    if (word && !isOwnerSender && isReserved(store, word)) word = null;
    const fromMood = mood ? moodEmoji(mood.mood, { owner: isOwnerSender }) : null;
    const fallback = () => (isOwnerSender ? randomOf(ownerPool(store)) : randomOf(pool(store)));

    if (mode === 'words') return word && wordLimiter.allow(`${message.chat}|${word}|${sender}`) ? word : null;
    if (mode === 'smart') {
        const emoji = word || fromMood;
        return emoji && smartLimiter.allow(`${message.chat}|${sender}`) ? emoji : null;
    }
    if (mode === 'owner') {
        if (!isOwnerSender) return null;
        return ownerLimiter.allow(`${message.chat}|${sender}`) ? fromMood || word || fallback() : null;
    }
    if (mode === 'all') {
        if (!senderLimiter.allow(`${message.chat}|${sender}`)) return null;
        if (!chatLimiter.allow(message.chat)) return null;
        return fromMood || word || fallback();
    }
    return null;
};

export default {
    name: 'autoresponder',
    version: '2.2.0',
    author: 'NEO BOT',
    description: 'Auto-replies and mood-aware auto-reactions (smart, every message, trigger words, owners only), off by default.',
    commands: [
        command('reply', 'Automatic replies to messages (off by default).', replyCommand),
        command('react', 'Mood-aware emoji reactions: smart, every message, trigger words, or owners only.', reactCommand)
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
            if (!['owner', 'all', 'smart'].includes(mode)) return;
            const emoji = chooseReaction(store, mode, message, { isOwnerSender: true });
            if (emoji) message.react(emoji).catch((e) => api.logger.debug(`react failed: ${e?.message}`));
        }
    }
};
