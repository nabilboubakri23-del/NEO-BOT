import crypto from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../config/config.js';
import { child } from './logger.js';
import { parseCommand, suggest } from './commandParser.js';
import { box, usage } from '../utils/formatter.js';
import { describeError, UsageError } from '../utils/errors.js';
import { isOwner } from '../systems/owners/ownerStore.js';
import { canSee, checkPermissions, createAccess, validateAccessFields } from '../systems/permissions/permissions.js';
import { checkPolicy } from '../systems/permissions/policy.js';
import { cooldownFor, dailyLimitFor, isRateExempt } from '../systems/permissions/perks.js';
import { consumeDaily } from '../systems/permissions/dailyLimit.js';
import { badge } from '../systems/permissions/ranks.js';
import { checkCooldown, checkSpam } from '../systems/security/rateLimiter.js';
import { getSetting } from '../systems/settings/settingsStore.js';
import { trackMessage } from '../systems/users/userStore.js';
import { countCommand } from '../systems/stats/statsStore.js';
import events from './events.js';
import pluginManager from '../systems/plugins/pluginManager.js';

const log = child('commands');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Command Engine V2.
 *
 * Every file in /commands exports a default object (or an array of them):
 * {
 *   name: 'ping',                       required, a-z 0-9 _ -
 *   aliases: ['p'],
 *   category: 'system',                 groups commands in .help and .menu
 *   description: 'Measure response time.',
 *   usage: '<number> [reason]',          shown by .help and on wrong usage
 *   examples: ['212600000000 spam'],
 *   permission: 'premium',              minimum rank: creator | owner | moderator | vip | premium | user | public
 *   scope: 'group',                     optional: 'group' | 'private'
 *   requires: ['groupAdmin'],           optional: 'groupAdmin' | 'botAdmin'
 *                                       (see systems/permissions/permissions.js and ranks.js)
 *   cooldown: 5,                        seconds; default from settings
 *   minArgs: 1,                         fewer args → usage reply
 *   hidden: false,                      hide from .help / .menu
 *   allowWhenOff: false,                still works when the chat is switched off
 *   enabled: true,
 *   interactions: { id: handler },       exact interactive ids
 *   onSelect(sock, message, parts, ctx), ids "<name>:<a>:<b>" → parts ['a','b']
 *   async execute(sock, message, args, ctx)
 * }
 *
 * Pipeline: parse → find → policy → anti-spam → permission (override / lock / allow / deny / rank)
 *           → scope → requires → daily limit → cooldown (scaled by rank) → plugin veto → run → errors/stats.
 */
class CommandHandler {
    constructor() {
        this.commands = new Map();
        this.aliases = new Map();
        this.interactions = new Map();
        this.files = new Map(); // command name → file path relative to the project root
        this.failures = []; // { file, error } from the last load
        this.loadCount = 0;
    }

    get prefix() {
        return config.bot.prefix;
    }

    // ── Loading ──────────────────────────────────────────────────────────

    /** Returns a list of problems with a command definition (empty = valid). */
    static validate(mod) {
        const problems = [];
        if (!mod || typeof mod !== 'object') return ['No default export.'];
        if (typeof mod.name !== 'string' || !NAME_RE.test(mod.name.toLowerCase())) problems.push('Invalid or missing name.');
        if (typeof mod.execute !== 'function') problems.push('Missing execute().');
        if (mod.aliases !== undefined && !Array.isArray(mod.aliases)) problems.push('aliases must be an array.');
        problems.push(...validateAccessFields(mod));
        if (mod.cooldown !== undefined && !(Number.isFinite(mod.cooldown) && mod.cooldown >= 0)) problems.push('cooldown must be seconds (>= 0).');
        if (mod.minArgs !== undefined && !(Number.isInteger(mod.minArgs) && mod.minArgs >= 0)) problems.push('minArgs must be a whole number.');
        return problems;
    }

    async load(dir = path.join(config.rootDir, 'commands')) {
        const commands = new Map();
        const aliases = new Map();
        const interactions = new Map();
        const files = new Map();
        const failures = [];
        // ESM caches modules by URL: a version query forces fresh code on every reload.
        const version = ++this.loadCount;

        const list = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.js') && !path.basename(f).startsWith('.')).sort();
        for (const file of list) {
            try {
                const exported = (await import(`${pathToFileURL(path.join(dir, file)).href}?v=${version}`)).default;
                // A file may export one command or an array of related commands.
                for (const mod of Array.isArray(exported) ? exported : [exported]) {
                    const problems = CommandHandler.validate(mod);
                    if (problems.length) {
                        failures.push({ file, error: problems.join(' ') });
                        log.warn({ file, problems }, 'Skipped invalid command.');
                        continue;
                    }
                    if (mod.enabled === false) continue;
                    // Commands kept in a category folder (commands/<category>/x.js) default to that category.
                    const folder = path.dirname(file).split(path.sep)[0];
                    if (!mod.category && folder && folder !== '.') mod.category = folder.toLowerCase();
                    const name = mod.name.toLowerCase();
                    if (commands.has(name)) {
                        failures.push({ file, error: `Duplicate command name "${name}" (already in ${files.get(name)}).` });
                        continue;
                    }
                    commands.set(name, mod);
                    files.set(name, path.relative(config.rootDir, path.join(dir, file)));
                    for (const [id, handler] of Object.entries(mod.interactions || {})) {
                        if (interactions.has(id)) log.warn({ id }, 'Duplicate interaction id overwritten.');
                        interactions.set(id, { command: name, handler });
                    }
                }
            } catch (error) {
                failures.push({ file, error: describeError(error) });
                log.error({ file }, `Failed to load command: ${describeError(error)}`);
            }
        }
        // Commands contributed by active plugins (core commands win on name clashes).
        for (const mod of pluginManager.pluginCommands()) {
            const source = `plugins/${mod.plugin}`;
            const problems = CommandHandler.validate(mod);
            if (problems.length) {
                failures.push({ file: source, error: `${mod?.name || '?'}: ${problems.join(' ')}` });
                continue;
            }
            if (mod.enabled === false) continue;
            const name = mod.name.toLowerCase();
            if (commands.has(name)) {
                failures.push({ file: source, error: `Duplicate command name "${name}" (already in ${files.get(name)}).` });
                continue;
            }
            commands.set(name, mod);
            files.set(name, source);
            for (const [id, handler] of Object.entries(mod.interactions || {})) interactions.set(id, { command: name, handler });
        }

        // Aliases after all names, so an alias can never hide a real command name.
        for (const [name, mod] of commands) {
            for (const raw of mod.aliases || []) {
                const alias = String(raw).toLowerCase();
                if (commands.has(alias) || aliases.has(alias)) {
                    log.warn({ alias, name }, 'Alias already taken; ignored.');
                    continue;
                }
                aliases.set(alias, name);
            }
        }

        // Swap in one step: a failed reload never leaves a half-empty registry.
        this.commands = commands;
        this.aliases = aliases;
        this.interactions = interactions;
        this.files = files;
        this.failures = failures;
        log.info({ commands: commands.size, interactions: interactions.size, failures: failures.length }, 'Commands loaded.');
        return { commands: commands.size, interactions: interactions.size, failures };
    }

    /** Re-imports every command file without restarting the bot. */
    reload() {
        return this.load();
    }

    // ── Registry queries ─────────────────────────────────────────────────

    get(name) {
        const key = String(name || '').toLowerCase();
        return this.commands.get(key) || this.commands.get(this.aliases.get(key));
    }

    /** Commands the sender may use by rank (hidden, locked and denied ones left out). */
    visible(access) {
        return [...this.commands.values()].filter((c) => canSee(c, access));
    }

    /** Map category → commands, for help and menus. */
    byCategory(access) {
        const map = new Map();
        for (const command of this.visible(access)) {
            const category = (command.category || 'general').toLowerCase();
            if (!map.has(category)) map.set(category, []);
            map.get(category).push(command);
        }
        for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
        return map;
    }

    isOwner(message) {
        // Main owner, owners in data/owners.json, OWNER_NUMBERS, or the linked account itself.
        return isOwner(message);
    }

    // ── Entry points ─────────────────────────────────────────────────────

    async handleCommand(sock, message) {
        const parsed = parseCommand(message.text, this.prefix);
        if (!parsed?.name) return;
        const command = this.get(parsed.name);
        const access = createAccess(sock, message);

        if (!command) return this.#unknown(message, parsed.name, access);

        const ctx = { ...parsed, prefix: this.prefix, command, usedName: parsed.name, access, source: 'text', api: command.plugin ? pluginManager.api(command.plugin) : null };
        return this.#run(sock, message, command, ctx, () => {
            if (command.minArgs && parsed.args.length < command.minArgs) throw new UsageError();
            return command.execute(sock, message, parsed.args, ctx);
        });
    }

    async handleSelection(sock, message) {
        const id = String(message.selectionId);

        // A selection id may itself be a command (e.g. ".ping").
        if (id.startsWith(this.prefix)) return this.handleCommand(sock, { ...message, text: id });

        const access = createAccess(sock, message);
        const exact = this.interactions.get(id);
        if (exact) {
            const command = this.get(exact.command);
            const ctx = { name: command.name, args: [], flags: {}, prefix: this.prefix, command, access, source: 'selection', selectionId: id, api: command.plugin ? pluginManager.api(command.plugin) : null };
            return this.#run(sock, message, command, ctx, () => exact.handler(sock, message, ctx));
        }

        // Namespaced ids: "help:cmd:ping" → command "help", parts ["cmd", "ping"].
        const [head, ...parts] = id.split(':');
        const command = parts.length ? this.get(head) : null;
        if (command?.onSelect) {
            const ctx = { name: command.name, args: parts, flags: {}, prefix: this.prefix, command, access, source: 'selection', selectionId: id, api: command.plugin ? pluginManager.api(command.plugin) : null };
            return this.#run(sock, message, command, ctx, () => command.onSelect(sock, message, parts, ctx));
        }
        log.warn({ id }, 'Unknown interactive selection.');
    }

    // ── Pipeline ─────────────────────────────────────────────────────────

    async #unknown(message, name, access) {
        if (!getSetting('suggest') || message.fromMe) return;
        if (!checkPolicy(message, access).ok) return;
        const names = this.visible(access).flatMap((c) => [c.name, ...(c.aliases || [])]);
        const guess = suggest(name, names);
        // Only answer when there is a close match: other bots may share the prefix.
        if (guess) await message.reply(box(config.bot.name, [`Unknown command: ${this.prefix}${name}`, `Did you mean ${this.prefix}${guess}?`])).catch(() => {});
    }

    async #run(sock, message, command, ctx, executor) {
        const { access } = ctx;
        const policy = checkPolicy(message, access, command);
        if (!policy.ok) {
            log.debug({ command: command.name, reason: policy.reason }, 'Blocked by policy.');
            return;
        }

        const userKey = message.senderNumber || message.senderLid || message.sender;
        const exempt = access.isCreator || isRateExempt(access.rank);

        // Anti-spam first, so even "access denied" answers can never be used to flood a chat.
        if (!exempt && getSetting('antiSpam')) {
            const spam = checkSpam(userKey, getSetting('spamLimit'));
            if (!spam.ok) {
                if (spam.notify) await message.reply(box(config.bot.name, ['🚫 Too many commands.', `You are muted for ${Math.ceil(spam.remainingMs / 1000)}s.`])).catch(() => {});
                return;
            }
        }

        const permission = await checkPermissions(command, message, access);
        if (!permission.ok) {
            log.warn({ command: command.name, requirement: permission.requirement, rank: access.rank.name }, 'Permission denied.');
            if (permission.silent) return;
            return message.reply(box(config.bot.name, ['⛔ Access denied.', permission.reason])).catch(() => {});
        }

        if (!access.isCreator && ctx.source === 'text') {
            const seconds = cooldownFor(command, access.rank);
            const cd = checkCooldown(userKey, command.name, seconds);
            if (!cd.ok) {
                if (cd.notify) await message.reply(box(config.bot.name, [`⏳ Please wait ${Math.ceil(cd.remainingMs / 1000)}s`, `before using ${this.prefix}${command.name} again.`])).catch(() => {});
                return;
            }
            const limit = dailyLimitFor(access.rank);
            const daily = consumeDaily(userKey, limit);
            if (!daily.ok) {
                if (daily.notify) {
                    await message
                        .reply(box(config.bot.name, [`📊 Daily limit reached (${limit} commands).`, 'It resets at 00:00 UTC.', `${badge('premium')} and above have no limit.`]))
                        .catch(() => {});
                }
                return;
            }
        }

        // Plugins may veto a command (e.g. an anti-link or maintenance plugin).
        if (!(await events.barrier('command:before', { sock, message, command, ctx }))) {
            log.debug({ command: command.name }, 'Blocked by a plugin hook.');
            return;
        }

        trackMessage(message, { command: command.name });
        const typing = getSetting('typing') && ctx.source === 'text';
        if (typing) sock.sendPresenceUpdate?.('composing', message.chat).catch(() => {});

        const started = Date.now();
        let failed = false;
        try {
            await executor();
        } catch (error) {
            if (error?.code === 'SEND_DROPPED') return; // anti-ban held the reply back on purpose
            failed = !error?.expose;
            if (failed) events.emit('command:error', { sock, message, command, error });
            await this.#replyError(message, command, error, access);
        } finally {
            if (typing) sock.sendPresenceUpdate?.('paused', message.chat).catch(() => {});
            countCommand(command.name, { failed });
            events.emit('command:after', { sock, message, command, ctx, ok: !failed, ms: Date.now() - started });
            log.info({ command: command.name, source: ctx.source, group: message.isGroup, ms: Date.now() - started, ok: !failed }, 'Command handled.');
        }
    }

    /** Central error handler: clean messages for users, details for owners and logs. */
    async #replyError(message, command, error, access) {
        let text;
        if (error instanceof UsageError) {
            text = usage(command, this.prefix, error.message);
        } else if (error?.expose) {
            text = box(command.name.toUpperCase(), [`⚠️ ${error.message}`]);
        } else {
            const ref = crypto.randomBytes(3).toString('hex').toUpperCase();
            log.error({ command: command.name, ref }, `Command failed: ${describeError(error)}`);
            text = box(config.bot.name, [
                '❌ Something went wrong.',
                `Command: ${this.prefix}${command.name}`,
                `Ref: ${ref}`,
                ...(access.isOwner ? ['', describeError(error).slice(0, 300)] : [])
            ]);
        }
        await message.reply(text).catch(() => {});
    }
}

export { CommandHandler };
const commandHandler = new CommandHandler();
export default commandHandler;
