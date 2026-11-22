import config from '../../config/config.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { getGroupConfig, GROUP_SCHEMA, setGroupOption } from '../../systems/moderation/groupConfig.js';
import { box, success } from '../../utils/formatter.js';
import { readinessLines } from '../../systems/moderation/readiness.js';
import { UsageError } from '../../utils/errors.js';

/**
 * Per-group moderation options (group admins):
 *   .gset                         current options (with quick buttons)
 *   .gset <option> <value>        e.g. .gset antilink warn · .gset warnlimit 5 · .gset adminonly on
 *   .antilink <off|delete|warn|kick> [invites|all]
 *   .antivcard <off|delete|warn|kick>
 * Enforcement needs the bot to be a group admin; admins and bot staff are never affected.
 */

const P = config.bot.prefix;

const show = (value) => (value === true ? 'on' : value === false ? 'off' : String(value));

const optionLines = (group) => {
    const cfg = getGroupConfig(group);
    return Object.entries(GROUP_SCHEMA).flatMap(([key, spec]) => [`${key}: ${show(cfg[key])}`, `   ${spec.description}`]);
};

const confirm = async (message, changes, sock) =>
    message.reply(success('GROUP OPTIONS', [...changes.map(({ key, value }) => `${key} → ${show(value)}`), ...(sock ? await readinessLines(sock, message) : [])]));

const base = {
    category: 'group',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin']
};

export const gset = {
    ...base,
    name: 'gset',
    aliases: ['groupset', 'gsettings'],
    description: 'Show or change this group\'s moderation options.',
    usage: '[option] [value]',
    examples: ['antilink warn', 'linkscope all', 'warnlimit 5', 'adminonly on'],
    async execute(sock, message, args) {
        if (!args.length) {
            const body = box('GROUP OPTIONS', [...optionLines(message.chat), '', `Change: ${P}gset <option> <value>`]);
            return sendButtons(
                sock,
                message.chat,
                {
                    title: config.bot.name,
                    body,
                    footer: config.bot.footer,
                    buttons: [
                        { type: 'reply', text: '🔗 Anti-link: warn', id: `${P}gset antilink warn` },
                        { type: 'reply', text: '📇 Anti-vCard: delete', id: `${P}gset antivcard delete` },
                        { type: 'reply', text: '🚫 All guards off', id: `${P}gset off` }
                    ]
                },
                { quoted: message.raw, fallbackText: body }
            );
        }
        if (args[0].toLowerCase() === 'off') {
            return confirm(message, [setGroupOption(message.chat, 'antilink', 'off'), setGroupOption(message.chat, 'antivcard', 'off')], sock);
        }
        if (args.length < 2) throw new UsageError(`Options: ${Object.keys(GROUP_SCHEMA).join(', ')}.`);
        await confirm(message, [setGroupOption(message.chat, args[0], args[1])], sock);
    }
};

export const antilink = {
    ...base,
    name: 'antilink',
    description: 'Delete, warn or kick for links (WhatsApp invites, or "all" links).',
    usage: '<off|delete|warn|kick> [invites|all]',
    examples: ['warn', 'kick all', 'off'],
    minArgs: 1,
    async execute(sock, message, args) {
        const changes = [setGroupOption(message.chat, 'antilink', args[0])];
        if (args[1]) changes.push(setGroupOption(message.chat, 'linkscope', args[1]));
        await confirm(message, changes, sock);
    }
};

export const antivcard = {
    ...base,
    name: 'antivcard',
    aliases: ['anticontact'],
    description: 'Delete, warn or kick for contact cards (vCards).',
    usage: '<off|delete|warn|kick>',
    minArgs: 1,
    async execute(sock, message, args) {
        await confirm(message, [setGroupOption(message.chat, 'antivcard', args[0])], sock);
    }
};

export default [gset, antilink, antivcard];
