import { readinessLines } from '../../systems/moderation/readiness.js';
import config from '../../config/config.js';
import { getGroupConfig, setGroupOption } from '../../systems/moderation/groupConfig.js';
import { addCustomWord, getCustomWords, removeCustomWord } from '../../systems/moderation/profanity/customWords.js';
import { builtinSize, checkText } from '../../systems/moderation/profanity/matcher.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError } from '../../utils/errors.js';

/**
 * Group protection (group admins):
 *   .antibad <off|delete|warn|kick> [normal|strict]
 *   .badword add|remove <word>      extra words for this group
 *   .badword allow|unallow <word>   accept a built-in word here (names, false hits)
 *   .badword list | test <text>
 *   .antispam <off|delete|warn|mute|kick> [messages per 10 s]
 *   .protect                         status of every guard
 * The guard itself runs in systems/moderation/guard.js; the bot must be group admin.
 */

const P = config.bot.prefix;
const base = { category: 'group', permission: 'public', scope: 'group', requires: ['groupAdmin'] };
const show = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));

export const antibad = {
    ...base,
    name: 'antibad',
    aliases: ['antiswear', 'antitoxic', 'antisab'],
    description: 'Block insults and profanity (Arabic dialects, Arabizi, English).',
    usage: '<off|delete|warn|kick> [normal|strict]',
    examples: ['warn', 'kick strict', 'off'],
    minArgs: 1,
    async execute(sock, message, args) {
        const changes = [setGroupOption(message.chat, 'antibad', args[0])];
        if (args[1]) changes.push(setGroupOption(message.chat, 'badlevel', args[1]));
        await message.reply(
            success('ANTI-PROFANITY', [...changes.map(({ key, value }) => `${key} → ${show(value)}`), '', `Built-in entries: ${builtinSize()}`, `Own words: ${P}badword add <word>`, ...(await readinessLines(sock, message))])
        );
    }
};

export const badword = {
    ...base,
    name: 'badword',
    aliases: ['badwords', 'bw'],
    description: 'Manage this group\'s own blocked and allowed words.',
    usage: '<add|remove|allow|unallow|list|test> [word]',
    examples: ['add word', 'allow nik', 'list', 'test some text'],
    minArgs: 1,
    async execute(sock, message, args) {
        const sub = args[0].toLowerCase();
        const value = args.slice(1).join(' ').trim();
        const group = message.chat;
        if (sub === 'list') {
            const { block, allow } = getCustomWords(group);
            return message.reply(
                box('GROUP WORDS', [`Blocked (${block.length}):`, ...(block.length ? block.map((w) => `• ${w}`) : ['—']), '', `Allowed (${allow.length}):`, ...(allow.length ? allow.map((w) => `• ${w}`) : ['—'])])
            );
        }
        if (!value) throw new UsageError('Give a word.');
        if (sub === 'test') {
            const cfg = getGroupConfig(group);
            const custom = getCustomWords(group);
            const verdict = checkText(value, { level: cfg.badlevel, custom: custom.block, allow: custom.allow });
            // Deleting the test message keeps the word out of the chat history.
            if (verdict.hit) sock.sendMessage(group, { delete: message.raw.key }).catch(() => {});
            return message.reply(box('TEST', [verdict.hit ? `🚫 Blocked (${verdict.severity}).` : '✅ Allowed.', `Level: ${cfg.badlevel}`]));
        }
        if (sub === 'add' || sub === 'allow') {
            const list = sub === 'add' ? 'block' : 'allow';
            const { entry, added } = addCustomWord(group, list, value);
            sock.sendMessage(group, { delete: message.raw.key }).catch(() => {});
            return message.reply(success('GROUP WORDS', [`${added ? 'Added to' : 'Already in'} ${list}: ${list === 'allow' ? entry : '•'.repeat(Math.min(entry.length, 8))}`]));
        }
        if (sub === 'remove' || sub === 'unallow') {
            const list = sub === 'remove' ? 'block' : 'allow';
            const removed = removeCustomWord(group, list, value);
            return message.reply(box('GROUP WORDS', [removed ? `Removed from ${list}.` : `Not in ${list}.`]));
        }
        throw new UsageError('Use add, remove, allow, unallow, list or test.');
    }
};

export const antispam = {
    ...base,
    name: 'antispam',
    aliases: ['antiflood'],
    description: 'Stop floods, repeated messages, mass tags and crash texts.',
    usage: '<off|delete|warn|mute|kick> [messages per 10 s]',
    examples: ['mute', 'kick 6', 'off'],
    minArgs: 1,
    async execute(sock, message, args) {
        const changes = [setGroupOption(message.chat, 'antispam', args[0])];
        if (args[1]) changes.push(setGroupOption(message.chat, 'spamlimit', args[1]));
        await message.reply(
            success('ANTI-SPAM', [
                ...changes.map(({ key, value }) => `${key} → ${show(value)}`),
                '',
                'mute: 1st strike delete, then 5 min, 30 min, 2 h',
                'kick: 1st strike delete, 2nd strike removed',
                ...(await readinessLines(sock, message))
            ])
        );
    }
};

export const protect = {
    ...base,
    name: 'protect',
    aliases: ['protection', 'guards'],
    description: 'Show every protection active in this group.',
    async execute(sock, message) {
        const c = getGroupConfig(message.chat);
        const words = getCustomWords(message.chat);
        await message.reply(
            box('PROTECTION', [
                `🔗 Anti-link: ${c.antilink} (${c.linkscope})`,
                `📇 Anti-vCard: ${c.antivcard}`,
                `🤬 Anti-profanity: ${c.antibad} (${c.badlevel}, +${words.block.length} own, ${words.allow.length} allowed)`,
                `🌊 Anti-spam: ${c.antispam} (${c.spamlimit} msgs / 10 s)`,
                `⚠️ Warn limit: ${c.warnlimit}`,
                `👮 Admin-only commands: ${show(c.adminonly)}`,
                `🛂 Admins exempt: ${show(c.exemptadmins)}`,
                ...(await readinessLines(sock, message))
            ])
        );
    }
};

export default [antibad, badword, antispam, protect];
