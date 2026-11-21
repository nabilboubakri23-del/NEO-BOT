import config from '../config/config.js';
import commandHandler from '../core/commandHandler.js';
import { CATEGORIES, categoryOf } from '../systems/menus/menuLayout.js';
import { requirementsOf } from '../systems/permissions/permissions.js';
import { getSetting } from '../systems/settings/settingsStore.js';
import { box, usage } from '../utils/formatter.js';
import { UserError } from '../utils/errors.js';

/**
 * .help — generated from the command registry, never written by hand.
 * New command files show up here automatically.
 */

const P = config.bot.prefix;

const PERMISSION_LABELS = { owner: 'Owners', mainOwner: 'Main owner', admin: 'Group admins', botAdmin: 'Bot must be admin', group: 'Groups only', private: 'Private chat only' };

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
        for (const c of list.sort((a, b) => a.name.localeCompare(b.name))) lines.push(`• ${P}${c.name}${c.usage ? ` ${c.usage}` : ''}`);
        lines.push('');
    }
    lines.push(`Details: ${P}help <command>`, `Menu: ${P}menu`);
    return box('HELP', lines);
};

const details = (command) => {
    const perms = requirementsOf(command).map((p) => PERMISSION_LABELS[p] || p);
    const cooldown = command.cooldown ?? getSetting('cooldown');
    return [
        usage(command, P),
        box(command.name.toUpperCase(), [
            `Category: ${categoryOf(command.category).title}`,
            `Aliases: ${command.aliases?.length ? command.aliases.map((a) => P + a).join(', ') : 'none'}`,
            `Access: ${perms.length ? perms.join(', ') : 'Everyone'}`,
            `Cooldown: ${cooldown}s`
        ])
    ].join('\n\n');
};

const showCommand = (message, name, access) => {
    const command = commandHandler.get(name.replace(new RegExp(`^\\${P}`), ''));
    if (!command || command.hidden || (!access.isOwner && requirementsOf(command).some((p) => p === 'owner' || p === 'mainOwner'))) {
        throw new UserError(`No command named "${name}".`);
    }
    return message.reply(details(command));
};

export default {
    name: 'help',
    aliases: ['h', 'commands', 'cmds'],
    category: 'system',
    description: 'List commands, or show how to use one.',
    usage: '[command]',
    examples: ['', 'ping'],
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
