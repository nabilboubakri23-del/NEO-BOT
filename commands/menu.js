import config from '../config/config.js';
import connectionManager from '../core/connection.js';
import commandHandler from '../core/commandHandler.js';
import { sendButtons, sendListMenu } from '../systems/menus/interactiveMenu.js';
import { CATEGORIES, categoryOf, findCategory } from '../systems/menus/menuLayout.js';
import { accessSpec, effectiveRank, rankBadge } from '../systems/permissions/permissions.js';
import { levelOf } from '../systems/permissions/ranks.js';
import { box, formatDuration } from '../utils/formatter.js';
import { getOwners } from '../systems/owners/ownerStore.js';

/**
 * .menu — multi-level interactive menu built from the command registry.
 *
 *   Main list (categories) ──► category list (its commands) ──► runs the command
 *          ▲                              │
 *          └────────── BACK ◄─────────────┘
 *
 * Selection ids:  menu:main · menu:cat:<key> · menu:panel · .<command>
 */

const { name: BOT, version, prefix: P, footer, website } = config.bot;

/** Commands of each category key that the sender may see. */
const grouped = (access) => {
    const map = new Map(CATEGORIES.map((c) => [c.key, []]));
    for (const command of commandHandler.visible(access)) map.get(categoryOf(command.category).key).push(command);
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
};

/**
 * Owner-only categories show for owners, and for anyone who unlocked one of their
 * commands by rank (e.g. a moderator and .ban). Commands open to everyone there
 * (".owner claim") do not make the panel appear for plain users.
 */
const shown = (access, groups = grouped(access)) =>
    CATEGORIES.filter((c) => !c.ownerOnly || access.isOwner || groups.get(c.key).some((cmd) => levelOf(effectiveRank(cmd).rank) > levelOf('user')));

const sendMain = async (sock, message, ctx) => {
    const groups = grouped(ctx.access);
    const categories = shown(ctx.access, groups);
    const sections = [];
    for (const category of categories) {
        let section = sections.find((s) => s.title === category.section);
        if (!section) sections.push((section = { title: category.section, rows: [] }));
        const count = groups.get(category.key).length;
        section.rows.push({
            id: `menu:cat:${category.key}`,
            title: category.title,
            description: count ? `${count} command${count > 1 ? 's' : ''} · ${category.description}` : `Coming soon · ${category.description}`
        });
    }
    const rank = ctx.access.rank;
    const body = box(BOT, [`Hello ${message.pushName || 'there'} 👋`, '', footer, `Version: ${version}`, `Your rank: ${rank.emoji} ${rank.label}`, 'Status: Online', '', 'Tap ORDERS and pick a category.']);

    await sendListMenu(sock, message.chat, { title: BOT, body, footer, buttonText: 'ORDERS', sections }, {
        quoted: message.raw,
        fallbackText: [body, '', ...categories.map((c) => `• ${P}menu ${c.key}  (${c.title})`)].join('\n')
    });
};

const sendCategory = async (sock, message, ctx, key) => {
    const category = findCategory(key);
    const groups = grouped(ctx.access);
    if (!category || !shown(ctx.access, groups).includes(category)) return sendMain(sock, message, ctx);
    const commands = groups.get(category.key);

    const rows = commands.map((c) => ({
        // Commands that need arguments open their help card instead of running empty.
        id: c.minArgs ? `help:cmd:${c.name}` : `${P}${c.name}`,
        title: `${P}${c.name}${rankBadge(c) ? ` ${rankBadge(c)}` : ''}`,
        description: (c.description || '').slice(0, 70) + (accessSpec(c).requires.includes('groupAdmin') ? ' (admins)' : '')
    }));
    const body = box(category.title, [
        category.description,
        '',
        commands.length ? `${commands.length} command${commands.length > 1 ? 's' : ''} available.` : 'Coming soon. No commands yet.',
        commands.length ? 'Tap OPEN to choose one.' : 'Tap OPEN to go back.'
    ]);
    const sections = [];
    if (rows.length) sections.push({ title: category.title, rows: rows.slice(0, 8) });
    sections.push({
        title: 'NAVIGATION',
        rows: [
            { id: 'menu:main', title: '⬅ BACK', description: 'Return to the main menu.' },
            ...(category.key === 'system' ? [{ id: 'menu:panel', title: 'BOT PANEL', description: 'Uptime, links and quick actions.' }] : [])
        ]
    });

    await sendListMenu(sock, message.chat, { title: category.title, body, footer, buttonText: 'OPEN', sections }, {
        quoted: message.raw,
        fallbackText: [body, '', ...commands.map((c) => `• ${P}${c.name}${c.usage ? ` ${c.usage}` : ''}  ${c.description || ''}`), '', `${P}menu  → back`].join('\n')
    });
};

const sendPanel = async (sock, message) => {
    const uptime = connectionManager.connectedAt ? formatDuration(Date.now() - connectionManager.connectedAt) : '0s';
    await sendButtons(
        sock,
        message.chat,
        {
            title: 'SYSTEM',
            body: box('SYSTEM', [`Bot: ${BOT}`, `Version: ${version}`, `Prefix: ${P}`, `Uptime: ${uptime}`, `Commands: ${commandHandler.commands.size}`]),
            footer,
            buttons: [
                { type: 'reply', text: 'STATS', id: `${P}stats` },
                { type: 'reply', text: 'HELP', id: `${P}help` },
                { type: 'reply', text: 'OWNER', id: 'menu:owner' },
                { type: 'url', text: 'OPEN WEBSITE', url: website },
                { type: 'copy', text: 'COPY CODE', code: `${P}menu` }
            ]
        },
        { quoted: message.raw }
    );
};

const showOwner = (message) => {
    const main = getOwners().owner.number || config.owner.numbers[0];
    return message.reply(box('OWNER', main ? [`wa.me/${main}`] : ['Owner not configured.']));
};

const route = (sock, message, ctx, parts) => {
    const [what, arg] = parts;
    if (what === 'cat') return sendCategory(sock, message, ctx, arg);
    if (what === 'panel') return sendPanel(sock, message);
    if (what === 'owner') return showOwner(message);
    return sendMain(sock, message, ctx);
};

export default {
    name: 'menu',
    aliases: ['start', 'list'],
    category: 'system',
    description: 'Interactive menu with every category and command.',
    usage: '[category]',
    examples: ['', 'system', 'panel'],
    permission: 'public',
    cooldown: 2,

    onSelect: (sock, message, parts, ctx) => route(sock, message, ctx, parts),

    async execute(sock, message, args, ctx) {
        // Text navigation works even where interactive messages do not render.
        const target = args[0]?.toLowerCase();
        if (!target) return sendMain(sock, message, ctx);
        if (target === 'panel' || target === 'owner') return route(sock, message, ctx, [target]);
        return sendCategory(sock, message, ctx, target);
    }
};
