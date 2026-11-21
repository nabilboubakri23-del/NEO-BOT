import path from 'node:path';
import { readFile } from 'node:fs/promises';
import config from '../config/config.js';
import commandHandler from '../core/commandHandler.js';
import { child } from '../core/logger.js';
import { sendButtons, sendListMenu } from '../systems/menus/interactiveMenu.js';
import * as ws from '../systems/devtools/workspace.js';
import { checkCommandModule, checkSyntax, isValidCommandName } from '../systems/devtools/codeValidator.js';
import { readCode } from '../systems/devtools/codeInput.js';
import { box } from '../utils/formatter.js';
import { describeError } from '../utils/errors.js';

/**
 * .dev — owner-only remote developer console.
 * Browse folders, read code, add / edit / delete commands and files,
 * restore backups and hot-reload commands, all from WhatsApp.
 */

const log = child('devtools');
const P = config.bot.prefix;
const CMD = `${P}dev`;
const COMMANDS_DIR = 'commands';
const PROTECTED_COMMANDS = new Set(['dev']);
const PAGE_CHARS = 3000;

const panel = (title, lines) => box(title, lines);
const code = (text) => '```' + text + '```';

// ── Helpers ────────────────────────────────────────────────────────────────

/** First line of the message, split into words (code lines are never parsed as args). */
const parseHeader = (text) => text.split('\n')[0].trim().split(/\s+/).slice(1);

const commandFile = (name) => `${COMMANDS_DIR}/${name}.js`;
const isCommandPath = (relative) => relative.startsWith(`${COMMANDS_DIR}${path.sep}`) && relative.endsWith('.js');

/** Accepts a command name ("ping") or a path ("commands/ping.js"). */
const resolveTarget = (input) => {
    if (!input) return null;
    const name = input.toLowerCase();
    const loaded = commandHandler.files.get(name) || commandHandler.files.get(commandHandler.aliases.get(name));
    if (loaded) return loaded;
    if (isValidCommandName(input) && !input.includes('.')) return commandFile(name);
    return input;
};

const formatSize = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Name / alias clash with a command living in another file. */
const findConflict = (info, ownFile) => {
    for (const key of [info.name, ...info.aliases]) {
        const owner = commandHandler.commands.has(key) ? key : commandHandler.aliases.get(key);
        if (owner && commandHandler.files.get(owner) !== ownFile) return `"${key}" is already used by ${P}${owner}.`;
    }
    return null;
};

const reloadSummary = async () => {
    const result = await commandHandler.reload();
    const lines = [`Commands: ${result.commands}`, `Interactions: ${result.interactions}`];
    if (result.failures.length) {
        lines.push('', 'Failed to load:');
        for (const f of result.failures) lines.push(`• ${f.file}: ${f.error}`);
    }
    return lines;
};

const needCode = (message, usage) =>
    message.reply(
        panel('DEV', [
            'No code found.',
            '',
            'Send the code in the same message,',
            'under the command line, or reply to',
            'a message / .js file that has the code.',
            '',
            `Usage: ${usage}`
        ])
    );

const TEMPLATE = (name) => `import config from '../config/config.js';
import { box } from '../utils/formatter.js';

export default {
    name: '${name}',
    aliases: [],
    category: 'general',
    description: 'Describe what ${name} does.',
    permissions: ['user'], // or ['owner']

    async execute(sock, message, args) {
        await message.reply(box(config.bot.name, ['Hello from ${name}!', \`Args: \${args.join(' ') || 'none'}\`]));
    }
};
`;

// ── Actions ────────────────────────────────────────────────────────────────

const actions = {
    async panel(sock, message) {
        const uptime = Math.round(process.uptime());
        await sendListMenu(
            sock,
            message.chat,
            {
                title: 'DEV CONSOLE',
                body: panel('DEV CONSOLE', [
                    `Commands loaded: ${commandHandler.commands.size}`,
                    `Node: ${process.version}`,
                    `Uptime: ${uptime}s`,
                    '',
                    'Owner only. Pick a tool below,',
                    `or type ${CMD} help.`
                ]),
                footer: config.bot.footer,
                buttonText: 'TOOLS',
                sections: [
                    {
                        title: 'BROWSE',
                        rows: [
                            { id: `${CMD} cmds`, title: 'COMMANDS', description: 'All commands and their files.' },
                            { id: `${CMD} ls`, title: 'FILES', description: 'Browse the bot folders.' },
                            { id: `${CMD} tree`, title: 'PROJECT TREE', description: 'Full folder structure.' }
                        ]
                    },
                    {
                        title: 'BUILD',
                        rows: [
                            { id: `${CMD} template`, title: 'NEW COMMAND', description: 'Get a ready command template.' },
                            { id: `${CMD} reload`, title: 'RELOAD', description: 'Hot-reload all commands.' },
                            { id: `${CMD} help`, title: 'HELP', description: 'Every dev sub-command.' }
                        ]
                    }
                ]
            },
            { quoted: message.raw, fallbackText: helpText() }
        );
    },

    async help(sock, message) {
        await message.reply(helpText());
    },

    async cmds(sock, message) {
        const byCategory = new Map();
        for (const [name, cmd] of commandHandler.commands) {
            const cat = (cmd.category || 'general').toUpperCase();
            if (!byCategory.has(cat)) byCategory.set(cat, []);
            const perms = (cmd.permissions || ['user']).includes('owner') ? ' 🔒' : '';
            const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : '';
            byCategory.get(cat).push(`• ${P}${name}${aliases}${perms}`, `   ${commandHandler.files.get(name)}`);
        }
        const lines = [`Total: ${commandHandler.commands.size}`];
        for (const [cat, items] of [...byCategory].sort()) lines.push('', `[ ${cat} ]`, ...items);
        if (commandHandler.failures.length) {
            lines.push('', '[ FAILED ]', ...commandHandler.failures.map((f) => `• ${f.file}`));
        }
        lines.push('', `Read: ${CMD} cat <name>`);
        await message.reply(panel('COMMANDS', lines));
    },

    async ls(sock, message, [dir = '.']) {
        const list = await ws.listDir(dir);
        const lines = [`Path: /${list.path === '.' ? '' : list.path}`, ''];
        for (const d of list.dirs) lines.push(`📁 ${d}/`);
        for (const f of list.files) lines.push(`📄 ${f.name}  ${formatSize(f.size)}`);
        if (!list.dirs.length && !list.files.length) lines.push('(empty)');
        lines.push('', `Open: ${CMD} ls <folder>`, `Read: ${CMD} cat <file>`);
        await message.reply(panel('FILES', lines));
    },

    async tree(sock, message, [dir = '.']) {
        const lines = await ws.tree(dir, 3);
        await message.reply(panel('PROJECT TREE', lines.length ? lines : ['(empty)']));
    },

    async cat(sock, message, [target, pageArg]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} cat <file|command> [page]`]));
        const file = await ws.readText(resolveTarget(target));
        const numbered = file.content.split('\n').map((line, i) => `${String(i + 1).padStart(3)}| ${line}`);

        const pages = [];
        let current = [];
        let length = 0;
        for (const line of numbered) {
            if (length + line.length + 1 > PAGE_CHARS && current.length) {
                pages.push(current);
                current = [];
                length = 0;
            }
            current.push(line);
            length += line.length + 1;
        }
        pages.push(current);

        const page = Math.min(Math.max(Number.parseInt(pageArg, 10) || 1, 1), pages.length);
        const header = `📄 ${file.relative}  •  ${formatSize(file.size)}  •  page ${page}/${pages.length}`;
        await message.reply(`${header}\n${code(pages[page - 1].join('\n'))}`);

        if (pages.length > 1 && page < pages.length) {
            await message.reply(`Next: ${CMD} cat ${file.relative} ${page + 1}`);
        }
    },

    async get(sock, message, [target]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} get <file|command>`]));
        const file = await ws.readText(resolveTarget(target));
        await sock.sendMessage(
            message.chat,
            {
                document: Buffer.from(file.content, 'utf8'),
                fileName: path.basename(file.relative),
                mimetype: 'text/plain',
                caption: `📄 ${file.relative}`
            },
            { quoted: message.raw }
        );
    },

    async find(sock, message, args) {
        const query = args.join(' ');
        if (!query) return message.reply(panel('DEV', [`Usage: ${CMD} find <text>`]));
        const results = [];
        const walk = async (dir) => {
            const list = await ws.listDir(dir);
            for (const d of list.dirs) await walk(path.join(dir, d));
            for (const f of list.files) {
                if (results.length >= 25 || !/\.(m?js|json|md)$/.test(f.name) || f.size > ws.MAX_READ_BYTES) continue;
                const rel = path.join(dir, f.name);
                const content = await readFile(ws.resolveSafe(rel).absolute, 'utf8');
                content.split('\n').forEach((line, i) => {
                    if (results.length < 25 && line.includes(query)) results.push(`${rel}:${i + 1}  ${line.trim().slice(0, 60)}`);
                });
            }
        };
        await walk('.');
        await message.reply(panel(`FIND "${query}"`, results.length ? results : ['No matches.']));
    },

    async template(sock, message, [name = 'hello']) {
        const clean = isValidCommandName(name) ? name.toLowerCase() : 'hello';
        await message.reply(`${CMD} add ${clean}\n${TEMPLATE(clean)}`);
        await message.reply(panel('NEW COMMAND', ['Copy the message above, edit the code,', 'and send it back to create the command.']));
    },

    async add(sock, message, [name]) {
        if (!isValidCommandName(name)) {
            return message.reply(panel('DEV', [`Usage: ${CMD} add <name>`, '<code on the next lines>', '', 'Name: a-z, 0-9, _ or -']));
        }
        name = name.toLowerCase();
        const relative = commandFile(name);
        if (await ws.fileExists(relative)) {
            return message.reply(panel('DEV', [`${relative} already exists.`, `Use ${CMD} edit ${name} to replace it.`]));
        }
        const input = await readCode(sock, message);
        if (!input) return needCode(message, `${CMD} add ${name}`);

        const check = await checkCommandModule(ws.resolveSafe(relative).absolute, input.code);
        if (!check.ok) return message.reply(panel('REJECTED', ['Nothing was saved.', '', code(check.error)]));
        if (check.command.name !== name) {
            return message.reply(panel('REJECTED', [`The code says name: '${check.command.name}'`, `but you asked for "${name}".`]));
        }
        const conflict = findConflict(check.command, relative);
        if (conflict) return message.reply(panel('REJECTED', [conflict]));

        await ws.writeText(relative, input.code);
        log.warn({ file: relative }, 'Command added remotely.');
        const summary = await reloadSummary();
        await message.reply(panel('COMMAND ADDED', [`${P}${name} is live.`, `File: ${relative}`, `Source: ${input.source}`, '', ...summary]));
    },

    async edit(sock, message, [target]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} edit <file|command>`, '<new code on the next lines>']));
        const relative = ws.resolveSafe(resolveTarget(target)).relative;
        if (!(await ws.fileExists(relative))) {
            return message.reply(panel('DEV', [`Not found: ${relative}`, `New command: ${CMD} add <name>`, `New file: ${CMD} new <path>`]));
        }
        return writeChecked(sock, message, relative, 'FILE UPDATED');
    },

    async new(sock, message, [target]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} new <path>`, '<content on the next lines>']));
        const relative = ws.resolveSafe(target).relative;
        if (await ws.fileExists(relative)) return message.reply(panel('DEV', [`${relative} already exists.`, `Use ${CMD} edit to replace it.`]));
        return writeChecked(sock, message, relative, 'FILE CREATED');
    },

    async del(sock, message, [target, flag]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} del <command|file>`]));
        const relative = ws.resolveSafe(resolveTarget(target)).relative;
        const name = path.basename(relative, '.js');
        if (isCommandPath(relative) && PROTECTED_COMMANDS.has(name)) {
            return message.reply(panel('DEV', ['The dev console cannot delete itself.']));
        }
        if (!(await ws.fileExists(relative))) return message.reply(panel('DEV', [`Not found: ${relative}`]));

        if (flag !== '--yes') {
            const confirm = `${CMD} del ${relative} --yes`;
            return sendButtons(
                sock,
                message.chat,
                {
                    title: 'CONFIRM DELETE',
                    body: panel('CONFIRM DELETE', [`File: ${relative}`, '', 'It moves to the trash and can be', `restored with ${CMD} restore.`]),
                    footer: config.bot.footer,
                    buttons: [
                        { type: 'reply', text: 'DELETE', id: confirm },
                        { type: 'reply', text: 'CANCEL', id: `${CMD} cancel` }
                    ]
                },
                { quoted: message.raw, fallbackText: panel('CONFIRM DELETE', [`File: ${relative}`, '', 'To confirm, send:', confirm]) }
            );
        }

        await ws.trash(relative);
        log.warn({ file: relative }, 'File deleted remotely.');
        const lines = [`${relative} moved to trash.`, `Undo: ${CMD} restore ${relative}`];
        if (isCommandPath(relative)) lines.push('', ...(await reloadSummary()));
        await message.reply(panel('DELETED', lines));
    },

    async cancel(sock, message) {
        await message.reply(panel('DEV', ['Cancelled. Nothing changed.']));
    },

    async restore(sock, message, [target]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} restore <file|command>`]));
        const result = await ws.restore(resolveTarget(target));
        const lines = [`${result.relative} restored from ${result.from}.`];
        if (isCommandPath(result.relative)) lines.push('', ...(await reloadSummary()));
        else lines.push('', 'Restart the bot to apply core changes.');
        await message.reply(panel('RESTORED', lines));
    },

    async backups(sock, message, [target]) {
        if (!target) return message.reply(panel('DEV', [`Usage: ${CMD} backups <file|command>`]));
        const relative = ws.resolveSafe(resolveTarget(target)).relative;
        const list = await ws.listBackups(relative);
        const lines = list.length ? list.slice(0, 15).map((b) => `• ${b.split('@')[1]}`) : ['No backups yet.'];
        await message.reply(panel(`BACKUPS ${relative}`, [...lines, '', `Restore newest: ${CMD} restore ${relative}`]));
    },

    async reload(sock, message) {
        await message.reply(panel('RELOADED', await reloadSummary()));
    }
};

/** Validates then writes a file; command files are hot-reloaded. */
const writeChecked = async (sock, message, relative, title) => {
    const input = await readCode(sock, message);
    if (!input) return needCode(message, `${CMD} ${title === 'FILE CREATED' ? 'new' : 'edit'} ${relative}`);
    const absolute = ws.resolveSafe(relative).absolute;

    if (isCommandPath(relative)) {
        const check = await checkCommandModule(absolute, input.code);
        if (!check.ok) return message.reply(panel('REJECTED', ['Nothing was saved.', '', code(check.error)]));
        const current = commandHandler.files.get(path.basename(relative, '.js'));
        if (PROTECTED_COMMANDS.has(path.basename(relative, '.js')) && check.command.name !== 'dev') {
            return message.reply(panel('REJECTED', ['The dev console must keep name: \'dev\'.']));
        }
        const conflict = findConflict(check.command, current || relative);
        if (conflict) return message.reply(panel('REJECTED', [conflict]));
    } else {
        const check = await checkSyntax(absolute, input.code);
        if (!check.ok) return message.reply(panel('REJECTED', ['Nothing was saved.', '', code(check.error)]));
    }

    const result = await ws.writeText(relative, input.code);
    log.warn({ file: relative }, 'File written remotely.');
    const lines = [`File: ${relative}`, `Source: ${input.source}`, result.backupName ? 'Previous version backed up.' : 'New file.'];
    if (isCommandPath(relative)) lines.push('', ...(await reloadSummary()));
    else if (/\.(m?js|json)$/.test(relative)) lines.push('', 'Restart the bot to apply core changes.');
    await message.reply(panel(title, lines));
};

const helpText = () =>
    panel('DEV HELP', [
        '[ BROWSE ]',
        `${CMD}  → console panel`,
        `${CMD} cmds  → all commands`,
        `${CMD} ls [folder]  → list a folder`,
        `${CMD} tree [folder]  → folder tree`,
        `${CMD} cat <file|cmd> [page]  → read code`,
        `${CMD} get <file|cmd>  → download file`,
        `${CMD} find <text>  → search the code`,
        '',
        '[ BUILD ]',
        `${CMD} template [name]  → command template`,
        `${CMD} add <name>  + code  → new command`,
        `${CMD} edit <file|cmd>  + code  → replace`,
        `${CMD} new <path>  + code  → new file`,
        `${CMD} del <file|cmd>  → delete (trash)`,
        `${CMD} restore <file|cmd>  → undo`,
        `${CMD} backups <file|cmd>  → versions`,
        `${CMD} reload  → hot-reload commands`,
        '',
        'Code goes on the lines under the command,',
        'in a .js file sent with the command as caption,',
        'or in a message you reply to.',
        'Every change is checked before saving.'
    ]);

const ALIASES = { list: 'ls', dir: 'ls', read: 'cat', view: 'cat', show: 'cat', download: 'get', rm: 'del', delete: 'del', remove: 'del', create: 'new', undo: 'restore', search: 'find', commands: 'cmds' };

export default {
    name: 'dev',
    aliases: ['devtools', 'console'],
    category: 'owner',
    description: 'Remote developer console: browse, read, add, edit and delete code from WhatsApp.',
    permissions: ['owner'],
    enabled: config.devtools.enabled,

    async execute(sock, message) {
        const [rawSub, ...args] = parseHeader(message.text);
        const sub = (rawSub || 'panel').toLowerCase();
        const action = actions[ALIASES[sub] || sub];
        if (!action) return message.reply(helpText());
        try {
            await action(sock, message, args);
        } catch (error) {
            await message.reply(panel('DEV ERROR', [describeError(error).replace(/^\w*Error: /, '')]));
        }
    }
};
