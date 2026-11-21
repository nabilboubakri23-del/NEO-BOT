import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../config/config.js';
import { child } from './logger.js';
import { box } from '../utils/formatter.js';
import { describeError } from '../utils/errors.js';

const log = child('commands');

/**
 * Command engine.
 * Every file in /commands exports a default object:
 *   { name, aliases, category, description, permissions, execute(sock, message, args), interactions? }
 * `interactions` maps interactive selection ids → handler(sock, message).
 */
class CommandHandler {
    constructor() {
        this.commands = new Map();
        this.aliases = new Map();
        this.interactions = new Map();
    }

    async load(dir = path.join(config.rootDir, 'commands')) {
        this.commands.clear();
        this.aliases.clear();
        this.interactions.clear();

        const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.js'));
        for (const file of files) {
            try {
                const mod = (await import(pathToFileURL(path.join(dir, file)).href)).default;
                if (!mod?.name || typeof mod.execute !== 'function') {
                    log.warn({ file }, 'Skipped invalid command file.');
                    continue;
                }
                if (mod.enabled === false) continue;
                const name = mod.name.toLowerCase();
                this.commands.set(name, mod);
                for (const alias of mod.aliases || []) this.aliases.set(alias.toLowerCase(), name);
                for (const [id, handler] of Object.entries(mod.interactions || {})) {
                    if (this.interactions.has(id)) log.warn({ id }, 'Duplicate interaction id overwritten.');
                    this.interactions.set(id, { command: name, handler });
                }
            } catch (error) {
                log.error({ file }, `Failed to load command: ${describeError(error)}`);
            }
        }
        log.info({ commands: this.commands.size, interactions: this.interactions.size }, 'Commands loaded.');
    }

    get(name) {
        const key = name.toLowerCase();
        return this.commands.get(key) || this.commands.get(this.aliases.get(key));
    }

    isOwner(message) {
        return config.owner.numbers.includes(message.senderNumber);
    }

    canRun(command, message) {
        const perms = command.permissions || ['user'];
        if (perms.includes('owner')) return this.isOwner(message);
        return true;
    }

    async handleCommand(sock, message) {
        const body = message.text.slice(config.bot.prefix.length).trim();
        const [name, ...args] = body.split(/\s+/);
        if (!name) return;
        const command = this.get(name);
        if (!command) return;

        if (!this.canRun(command, message)) {
            log.warn({ command: command.name }, 'Permission denied.');
            return message.reply(box(config.bot.name, ['Access denied.', 'You are not allowed to use this command.']));
        }

        log.info({ command: command.name, group: message.isGroup }, 'Command received.');
        try {
            await command.execute(sock, message, args);
        } catch (error) {
            log.error({ command: command.name }, `Command failed: ${describeError(error)}`);
            await message.reply(box(config.bot.name, ['An error occurred while running this command.'])).catch(() => {});
        }
    }

    async handleSelection(sock, message) {
        const id = String(message.selectionId);

        // A selection id may itself be a command (e.g. ".ping").
        if (id.startsWith(config.bot.prefix)) {
            return this.handleCommand(sock, { ...message, text: id });
        }

        const entry = this.interactions.get(id);
        if (!entry) {
            log.warn({ id }, 'Unknown interactive selection.');
            return;
        }
        const command = this.get(entry.command);
        if (command && !this.canRun(command, message)) return;

        log.info({ selection: id }, 'Interactive selection received.');
        try {
            await entry.handler(sock, message);
        } catch (error) {
            log.error({ selection: id }, `Selection handler failed: ${describeError(error)}`);
        }
    }
}

const commandHandler = new CommandHandler();
export default commandHandler;
