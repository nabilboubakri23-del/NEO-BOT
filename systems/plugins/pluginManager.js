import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import events from '../../core/events.js';
import docStore from '../database/docStore.js';
import { describeError } from '../../utils/errors.js';
import { resolveRank } from '../permissions/resolveRank.js';
import { createAccess } from '../permissions/permissions.js';
import { checkPolicy } from '../permissions/policy.js';
import { atLeast } from '../permissions/ranks.js';

const log = child('plugins');
const NAME = 'plugins'; // document storing which plugins the owner disabled

/**
 * Plugin System.
 *
 * A plugin is a single .js file in /plugins that extends the bot without
 * touching the core, in the style of well-known bots (Levanter, Silva):
 *
 *   export default {
 *     name: 'welcome',                 required, unique, a-z 0-9 _ -
 *     version: '1.0.0',
 *     description: 'Greets new group members.',
 *     author: 'you',
 *     commands: [ { name, permission: 'premium', ... execute } ],   // optional command definitions
 *     hooks: { 'group:participants': fn },    // optional event listeners
 *     async onLoad(api) {}, async onUnload(api) {}   // optional lifecycle
 *   }
 *
 * The manager:
 *   - loads every plugin file, validating each one in isolation
 *   - registers a plugin's commands with the command handler (tagged by plugin)
 *   - subscribes a plugin's hooks to the event bus (tagged by plugin)
 *   - lets the owner enable / disable a plugin at runtime (persisted)
 *   - hot-reloads the whole folder, cleanly removing the previous versions
 *
 * One plugin crashing on load never stops the others, and unloading a plugin
 * removes exactly what it added (its commands and its hooks) and nothing else.
 */
class PluginManager {
    constructor() {
        this.dir = path.join(config.rootDir, 'plugins');
        this.plugins = new Map(); // name → { meta, file, hookOffs: [], commandNames: [] }
        this.failures = []; // { file, error } from the last load
        this.loadCount = 0;
        this.commandHandler = null;
        this.disabled = null; // Set of disabled plugin names (persisted)
    }

    /** Wires the command handler in (avoids an import cycle with the core). */
    attach(commandHandler) {
        this.commandHandler = commandHandler;
    }

    async #loadDisabled() {
        const doc = await docStore.open(NAME, () => ({ disabled: [] }));
        this.disabled = new Set(doc.disabled || []);
        this._doc = doc;
    }

    #persistDisabled() {
        if (!this._doc) return;
        this._doc.disabled = [...this.disabled];
        docStore.touch(NAME);
    }

    /** The API object handed to each plugin's hooks, commands (ctx.api) and lifecycle. */
    api(name) {
        return {
            config,
            logger: child(`plugin:${name}`),
            events,
            // Read-only rank lookups: ranks.of(message) → { name, level, emoji, label, ... }
            ranks: {
                of: (message) => resolveRank(message),
                atLeast: (message, rank) => atLeast(resolveRank(message).name, rank)
            },
            // Would the bot answer this sender here (not banned, bot mode, chat switched on)?
            // Hooks that reply to plain messages (games, auto-replies) should check it first.
            allows: (sock, message) => checkPolicy(message, createAccess(sock, message)).ok,
            store: {
                open: (docName, defaults) => docStore.open(`plugin.${name}.${docName}`, defaults),
                touch: (docName) => docStore.touch(`plugin.${name}.${docName}`)
            }
        };
    }

    static validate(meta) {
        const problems = [];
        if (!meta || typeof meta !== 'object') return ['No default export.'];
        if (typeof meta.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(meta.name.toLowerCase())) problems.push('Invalid or missing name.');
        if (meta.commands !== undefined && !Array.isArray(meta.commands)) problems.push('commands must be an array.');
        if (meta.hooks !== undefined && (typeof meta.hooks !== 'object' || meta.hooks === null)) problems.push('hooks must be an object.');
        return problems;
    }

    /** Loads (or reloads) every plugin file. Safe to call at any time. */
    async load() {
        if (!this.disabled) await this.#loadDisabled();
        await this.unloadAll(); // clean slate: remove previous commands and hooks
        await mkdir(this.dir, { recursive: true }).catch(() => {});

        const failures = [];
        const version = ++this.loadCount;
        const files = existsSync(this.dir)
            ? (await readdir(this.dir, { recursive: true })).filter((f) => f.endsWith('.js') && !path.basename(f).startsWith('.') && !path.basename(f).startsWith('_')).sort()
            : [];

        for (const file of files) {
            try {
                const meta = (await import(`${pathToFileURL(path.join(this.dir, file)).href}?v=${version}`)).default;
                const problems = PluginManager.validate(meta);
                if (problems.length) {
                    failures.push({ file, error: problems.join(' ') });
                    continue;
                }
                const name = meta.name.toLowerCase();
                if (this.plugins.has(name)) {
                    failures.push({ file, error: `Duplicate plugin name "${name}".` });
                    continue;
                }
                if (meta.enabled === false || this.disabled.has(name)) {
                    this.plugins.set(name, { meta, file, hookOffs: [], commandNames: [], active: false });
                    continue;
                }
                await this.#activate(name, meta, file);
            } catch (error) {
                failures.push({ file, error: describeError(error) });
                log.error({ file }, `Failed to load plugin: ${describeError(error)}`);
            }
        }

        this.failures = failures;
        const active = [...this.plugins.values()].filter((p) => p.active).length;
        log.info({ plugins: this.plugins.size, active, failures: failures.length }, 'Plugins loaded.');
        await events.emit('plugins:reloaded', { loaded: active, failed: failures.length });
        if (this.commandHandler) await this.commandHandler.reload();
        return { plugins: this.plugins.size, active, failures };
    }

    /** Registers one plugin's commands and hooks. */
    async #activate(name, meta, file) {
        const record = { meta, file, hookOffs: [], commandNames: [], active: true };

        for (const command of meta.commands || []) {
            if (command && typeof command.name === 'string') {
                command.plugin = name; // marks ownership so unload removes exactly these
                record.commandNames.push(command.name.toLowerCase());
            }
        }
        for (const [event, fn] of Object.entries(meta.hooks || {})) {
            record.hookOffs.push(events.on(event, (payload) => fn(payload, this.api(name)), { tag: `plugin:${name}` }));
        }
        this.plugins.set(name, record);
        if (typeof meta.onLoad === 'function') await meta.onLoad(this.api(name));
        log.info({ plugin: name, commands: record.commandNames.length, hooks: record.hookOffs.length }, 'Plugin activated.');
    }

    /** Commands contributed by active plugins, for the command handler to merge in. */
    pluginCommands() {
        const out = [];
        for (const record of this.plugins.values()) {
            if (record.active) out.push(...(record.meta.commands || []));
        }
        return out;
    }

    async #deactivate(name) {
        const record = this.plugins.get(name);
        if (!record || !record.active) return;
        record.hookOffs.forEach((off) => off());
        events.offTag(`plugin:${name}`);
        if (typeof record.meta.onUnload === 'function') await record.meta.onUnload(this.api(name)).catch((e) => log.error(`onUnload failed: ${describeError(e)}`));
        record.active = false;
        record.hookOffs = [];
        record.commandNames = [];
    }

    async unloadAll() {
        for (const name of this.plugins.keys()) await this.#deactivate(name);
        this.plugins.clear();
    }

    async enable(name) {
        name = String(name).toLowerCase();
        this.disabled.delete(name);
        this.#persistDisabled();
        await this.load();
        return this.plugins.get(name)?.active ?? false;
    }

    async disable(name) {
        name = String(name).toLowerCase();
        if (!this.plugins.has(name)) return false;
        this.disabled.add(name);
        this.#persistDisabled();
        await this.load();
        return true;
    }

    /**
     * Patterns that let remote code reach outside the bot. Installing a plugin
     * that uses any of them needs an explicit --force from the owner.
     */
    static DANGEROUS = [
        { re: /child_process|execSync|spawnSync|\bexec\s*\(/, why: 'runs shell commands' },
        { re: /\beval\s*\(|new\s+Function\s*\(/, why: 'evaluates code at runtime' },
        { re: /\brm\s+-rf|fs\.(rm|rmdir|unlink)|rimraf/, why: 'deletes files' },
        { re: /process\.env\b/, why: 'reads secrets from the environment' },
        { re: /\.env\b|owners\.json|SESSION_ENCRYPTION_KEY|MONGODB_URI/, why: 'touches credentials or session data' }
    ];

    static scan(code) {
        return PluginManager.DANGEROUS.filter((p) => p.re.test(code)).map((p) => p.why);
    }

    /** Downloads a plugin from an https URL, scans it, saves it and loads it. */
    async install(url, { force = false } = {}) {
        if (!/^https:\/\//i.test(url)) throw new Error('Only https URLs are allowed.');
        await mkdir(this.dir, { recursive: true });

        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
        const code = await res.text();
        if (code.length > 256 * 1024) throw new Error('Plugin file is too large (over 256 KB).');
        if (!/export\s+default/.test(code)) throw new Error('Not a plugin: no default export found.');

        const risks = PluginManager.scan(code);
        if (risks.length && !force) {
            throw new Error(`This plugin ${risks.join(', ')}. Review it, then add --force to install anyway.`);
        }

        const base = (url.split('/').pop() || 'plugin.js').split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '');
        const fileName = base.endsWith('.js') ? base : `${base}.js`;
        const target = path.join(this.dir, fileName);
        if (!target.startsWith(this.dir + path.sep)) throw new Error('Invalid plugin file name.');

        // Validate the module in isolation before trusting it.
        const tmp = `${target}.installing`;
        const { writeFile, rename, unlink } = await import('node:fs/promises');
        await writeFile(tmp, code, 'utf8');
        try {
            const meta = (await import(`${pathToFileURL(tmp).href}?v=${Date.now()}`)).default;
            const problems = PluginManager.validate(meta);
            if (problems.length) throw new Error(problems.join(' '));
            await rename(tmp, target);
            await this.load();
            return { name: meta.name.toLowerCase(), file: fileName, risks };
        } catch (error) {
            await unlink(tmp).catch(() => {});
            throw error;
        }
    }

    /** Removes an installed plugin file and unloads it. */
    async remove(name) {
        name = String(name).toLowerCase();
        const record = this.plugins.get(name);
        if (!record) throw new Error(`No plugin named "${name}".`);
        const file = path.join(this.dir, record.file);
        if (!file.startsWith(this.dir + path.sep)) throw new Error('Invalid plugin path.');
        await this.#deactivate(name);
        const { unlink } = await import('node:fs/promises');
        await unlink(file).catch(() => {});
        this.disabled.delete(name);
        this.#persistDisabled();
        await this.load();
        return true;
    }

    list() {
        return [...this.plugins.entries()].map(([name, r]) => ({
            name,
            version: r.meta.version || '1.0.0',
            description: r.meta.description || '',
            author: r.meta.author || '',
            active: r.active,
            commands: (r.meta.commands || []).map((c) => c.name),
            hooks: Object.keys(r.meta.hooks || {})
        }));
    }
}

const pluginManager = new PluginManager();
export default pluginManager;
export { PluginManager };
