import config from '../../config/config.js';
import commandHandler from '../../core/commandHandler.js';
import { CATEGORIES, categoryOf } from '../../systems/menus/menuLayout.js';
import { canSee, describeAccess, rankBadge } from '../../systems/permissions/permissions.js';
import { cooldownFor } from '../../systems/permissions/perks.js';
import { badge } from '../../systems/permissions/ranks.js';
import { box, usage } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';

/**
 * .help — generated from the command registry, never written by hand.
 * New command files show up here automatically.
 */

const P = config.bot.prefix;

const overview = (access) => {
    const byKey = new Map();
    for (const command of commandHandler.visible(access)) {
        const key = categoryOf(command.category).key;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(command);
    }
    const lines = [];
    for (const category of CATEGORIES) {
        const list = byKey.get(category.key);
        if (!list?.length) continue;
        lines.push(`[ ${category.title} ]`);
        for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) {
            const mark = rankBadge(c);
            lines.push(`• ${P}${c.name}${c.usage ? ` ${c.usage}` : ''}${mark ? `  ${mark}` : ''}`);
        }
        lines.push('');
    }
    lines.push(`Your rank: ${badge(access.rank.name)}`, `Details: ${P}help <command>`, `Menu: ${P}menu`, `Ranks: ${P}rank list`);
    return box('HELP', lines);
};

const details = (command, access) => {
    const info = describeAccess(command);
    return [
        usage(command, P),
        box(command.name.toUpperCase(), [
            `Category: ${categoryOf(command.category).title}`,
            `Aliases: ${command.aliases?.length ? command.aliases.map((a) => P + a).join(', ') : 'none'}`,
            `Permission: ${info.permission}`,
            info.scope ? `Where: ${info.scope}` : null,
            info.requires.length ? `Requires: ${info.requires.join(', ')}` : null,
            `Cooldown for you: ${access.isCreator ? 0 : cooldownFor(command, access.rank)}s`
        ])
    ].join('\n\n');
};

const showCommand = (message, name, access) => {
    const command = commandHandler.get(name.replace(new RegExp(`^\\${P}`), ''));
    if (!command || !canSee(command, access)) throw new UserError(`No command named "${name}".`);
    return message.reply(details(command, access));
};

export default {
    name: 'help',
    aliases: ['h', 'commands', 'cmds'],
    category: 'system',
    description: 'List commands, or show how to use one.',
    usage: '[command]',
    examples: ['', 'ping'],
    permission: 'public',
    cooldown: 2,

    onSelect(sock, message, [what, name], ctx) {
        if (what === 'cmd' && name) return showCommand(message, name, ctx.access);
        return message.reply(overview(ctx.access));
    },

    async execute(sock, message, args, ctx) {
        if (args[0]) return showCommand(message, args[0], ctx.access);
        await message.reply(overview(ctx.access));
    }
};
