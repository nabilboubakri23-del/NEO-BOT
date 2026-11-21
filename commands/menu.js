import config from '../config/config.js';
import connectionManager from '../core/connection.js';
import commandHandler from '../core/commandHandler.js';
import { sendButtons, sendListMenu } from '../systems/menus/interactiveMenu.js';
import { box, formatDuration } from '../utils/formatter.js';
import { getOwners } from '../systems/owners/ownerStore.js';

const { name: BOT, version, prefix, footer, website } = config.bot;

const MAIN_MENU = {
    title: BOT,
    body: box(BOT, [
        `Welcome to ${BOT}.`,
        '',
        footer,
        `Version: ${version}`,
        'Status: Online',
        '',
        'Select a category below.'
    ]),
    footer,
    buttonText: 'ORDERS',
    sections: [
        {
            title: 'MAIN SYSTEMS',
            rows: [
                { id: 'ai_center', title: 'AI CENTER', description: 'Artificial intelligence tools.' },
                { id: 'smart_tools', title: 'SMART TOOLS', description: 'Advanced utility tools.' },
                { id: 'media_lab', title: 'MEDIA LAB', description: 'Media processing tools.' }
            ]
        },
        {
            title: 'OTHER SYSTEMS',
            rows: [
                { id: 'knowledge', title: 'KNOWLEDGE', description: 'Knowledge and research.' },
                { id: 'automation', title: 'AUTOMATION', description: 'Automated operations.' },
                { id: 'system', title: 'SYSTEM', description: 'Bot information and settings.' }
            ]
        }
    ]
};

const ROWS = Object.fromEntries(MAIN_MENU.sections.flatMap((s) => s.rows).map((r) => [r.id, r]));

const comingSoon = (id) => async (sock, message) => {
    const row = ROWS[id];
    await message.reply(
        box(row.title, [row.description, '', `Selection: ${id}`, 'Status: Coming soon', '', `Type ${prefix}menu to go back.`])
    );
};

const sendSystemPanel = async (sock, message) => {
    const uptime = connectionManager.connectedAt ? formatDuration(Date.now() - connectionManager.connectedAt) : '0s';
    await sendButtons(
        sock,
        message.chat,
        {
            title: 'SYSTEM',
            body: box('SYSTEM', [
                `Bot: ${BOT}`,
                `Version: ${version}`,
                `Prefix: ${prefix}`,
                `Uptime: ${uptime}`,
                `Commands: ${commandHandler.commands.size}`
            ]),
            footer,
            buttons: [
                { type: 'reply', text: 'BOT INFO', id: 'bot_info' },
                { type: 'reply', text: 'HELP', id: 'help' },
                { type: 'reply', text: 'OWNER', id: 'owner' },
                { type: 'url', text: 'OPEN WEBSITE', url: website },
                { type: 'copy', text: 'COPY CODE', code: `${prefix}menu` }
            ]
        },
        { quoted: message.raw }
    );
};

const interactions = {
    ai_center: comingSoon('ai_center'),
    smart_tools: comingSoon('smart_tools'),
    media_lab: comingSoon('media_lab'),
    knowledge: comingSoon('knowledge'),
    automation: comingSoon('automation'),
    system: sendSystemPanel,

    bot_info: (sock, message) =>
        message.reply(box('BOT INFO', [`Name: ${BOT}`, `Version: ${version}`, 'Engine: Baileys v7 (raoltech v1.1.0)', 'Runtime: Node.js'])),
    help: (sock, message) =>
        message.reply(box('HELP', [`${prefix}menu  → Main interactive menu`, `${prefix}ping  → Response time`, '', `Tip: ${prefix}menu <category id>`])),
    owner: (sock, message) => {
        const main = getOwners().owner.number || config.owner.numbers[0];
        return message.reply(box('OWNER', main ? [`wa.me/${main}`] : ['Owner not configured.']));
    }
};

export default {
    name: 'menu',
    aliases: ['help', 'start'],
    category: 'general',
    description: 'Display the NEO BOT main interactive menu.',
    permissions: ['user'],
    interactions,

    async execute(sock, message, args) {
        // Text fallback navigation: ".menu system" works even without interactive support.
        const target = args[0]?.toLowerCase();
        if (target && interactions[target]) return interactions[target](sock, message);

        await sendListMenu(sock, message.chat, MAIN_MENU, {
            quoted: message.raw,
            fallbackText: `${MAIN_MENU.body}\n\n${MAIN_MENU.sections
                .flatMap((s) => s.rows)
                .map((r) => `• ${prefix}menu ${r.id}  (${r.title})`)
                .join('\n')}`
        });
    }
};
