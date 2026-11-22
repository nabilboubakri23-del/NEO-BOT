import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { sendButtons, sendListMenu } from '../../systems/menus/interactiveMenu.js';
import { audit } from '../../systems/permissions/auditLog.js';
import { allowedScopes, choicesFor, findSetting, readSetting, resolveSetting, SCOPES, show, visibleSettings, writeSetting } from '../../systems/settings/registry.js';
import { resetSetting, SCHEMA } from '../../systems/settings/settingsStore.js';
import { box, success } from '../../utils/formatter.js';
import { readinessLines } from '../../systems/moderation/readiness.js';
import { UsageError, UserError } from '../../utils/errors.js';

/**
 * One settings panel for everyone, driven by buttons and by permission:
 *   owners       🤖 Bot (global switches: bot on/off, anti-ban, mode, typing...)
 *   group admins 💬 This chat (bot on/off here) + 🛡️ Group protection
 *   others       no access
 *
 * Buttons:  .settings → pick a section → pick a setting → On / Off (or a value).
 * Text:     .settings on <key> · .settings off <key> · .settings set <key> <value>
 *           .settings info <key> · .settings reset <key|all> (owners)
 * Every change re-checks permission server-side and is written to the audit log.
 */

const log = child('settings');
const P = config.bot.prefix;
const ID = 'settings';
const ROWS_PER_SECTION = 8;

const typeHint = (spec) => (spec.type === 'bool' ? 'on | off' : spec.type === 'enum' ? spec.values.join(' | ') : `${spec.min}-${spec.max}`);

const textOverview = (scopes) =>
    box('SETTINGS', [
        ...scopes.flatMap((s) => [s.title, ...s.items.map((i) => `• ${i.key}: ${show(i.value)}`), '']),
        `${P}settings on|off <key>`,
        `${P}settings set <key> <value>`,
        `${P}settings info <key>`
    ]);

const noAccess = (message) => message.reply(box('SETTINGS', ['🔒 No settings you can change here.', message.isGroup ? 'Group settings are for group admins.' : 'Bot settings are for bot owners.']));

/** Home: sections the sender may use (skipped when only one). */
const home = async (sock, message, access) => {
    const scopes = await visibleSettings(message, access);
    if (!scopes.length) return noAccess(message);
    if (scopes.length === 1) return scopePage(sock, message, access, scopes[0].scope);
    const body = box('SETTINGS', [...scopes.map((s) => `${s.title}: ${s.items.length} options`), '', 'Pick a section.']);
    return sendButtons(
        sock,
        message.chat,
        { title: config.bot.name, body, footer: config.bot.footer, buttons: scopes.map((s) => ({ type: 'reply', text: s.title, id: `${ID}:scope:${s.scope}` })) },
        { quoted: message.raw, fallbackText: textOverview(scopes) }
    );
};

/** One section as a list: each row = a setting with its current value. */
const scopePage = async (sock, message, access, scope) => {
    const scopes = await visibleSettings(message, access);
    const page = scopes.find((s) => s.scope === scope);
    if (!page) throw new UserError('You cannot change these settings here.');
    const rows = page.items.map((i) => ({ id: `${ID}:open:${scope}:${i.key}`, title: `${i.key}: ${show(i.value)}`, description: i.spec.description.slice(0, 70) }));
    const sections = [];
    for (let n = 0; n < rows.length; n += ROWS_PER_SECTION) {
        sections.push({ title: sections.length ? `${page.title} (more)` : page.title, rows: rows.slice(n, n + ROWS_PER_SECTION) });
    }
    if (scopes.length > 1) sections.push({ title: 'NAVIGATION', rows: [{ id: `${ID}:home`, title: '↩️ All sections', description: 'Back to the settings home.' }] });
    const body = box(page.title.toUpperCase(), [...page.items.map((i) => `• ${i.key}: ${show(i.value)}`), '', 'Open the list and pick one to change it.']);
    return sendListMenu(
        sock,
        message.chat,
        { title: config.bot.name, body, footer: config.bot.footer, buttonText: 'CHANGE', sections },
        { quoted: message.raw, fallbackText: textOverview([page]) }
    );
};

/** One setting: On/Off buttons for switches, a list of values otherwise. */
const settingPage = async (sock, message, access, scope, key) => {
    const found = findSetting(scope, key);
    if (!found) throw new UserError('Unknown setting.');
    if (!(await allowedScopes(message, access))[scope]) throw new UserError('You cannot change this setting.');
    const value = readSetting(scope, found.key, message.chat);
    const lines = [found.spec.description, '', `Now: ${show(value)}`, `Default: ${show(found.spec.default)}`];
    const set = (v) => `${ID}:set:${scope}:${found.key}:${v}`;
    if (found.spec.type === 'bool') {
        return sendButtons(
            sock,
            message.chat,
            {
                title: config.bot.name,
                body: box(found.key.toUpperCase(), lines),
                footer: config.bot.footer,
                buttons: [
                    { type: 'reply', text: '✅ Turn ON', id: set('on') },
                    { type: 'reply', text: '⛔ Turn OFF', id: set('off') },
                    { type: 'reply', text: '↩️ Back', id: `${ID}:scope:${scope}` }
                ]
            },
            { quoted: message.raw, fallbackText: box(found.key.toUpperCase(), [...lines, '', `${P}settings on ${found.key}`, `${P}settings off ${found.key}`]) }
        );
    }
    const rows = choicesFor(found.spec).map((v) => ({ id: set(v), title: `${String(v) === String(value) ? '● ' : ''}${v}`, description: String(v) === String(found.spec.default) ? 'default' : '' }));
    return sendListMenu(
        sock,
        message.chat,
        {
            title: config.bot.name,
            body: box(found.key.toUpperCase(), [...lines, '', `Allowed: ${typeHint(found.spec)}`, `Any value: ${P}settings set ${found.key} <value>`]),
            footer: config.bot.footer,
            buttonText: 'CHOOSE',
            sections: [
                { title: found.key, rows: rows.slice(0, ROWS_PER_SECTION) },
                { title: 'NAVIGATION', rows: [{ id: `${ID}:scope:${scope}`, title: '↩️ Back', description: SCOPES[scope].title }] }
            ]
        },
        { quoted: message.raw }
    );
};

/** Applies a change (permission checked inside writeSetting) and confirms with buttons. */
const apply = async (sock, message, access, scope, key, raw) => {
    const { key: name, value } = await writeSetting(scope, key, raw, { message, access });
    audit({ action: 'settings:set', actor: message, target: `${scope}.${name}`, detail: String(value) });
    log.warn({ scope, key: name, value, chat: scope === 'bot' ? undefined : message.chat }, 'Setting changed.');
    const body = success('SETTINGS', [`${SCOPES[scope].title}`, `${name} → ${show(value)}`, ...(scope === 'group' ? await readinessLines(sock, message) : [])]);
    const buttons = [{ type: 'reply', text: '⚙️ Settings', id: `${ID}:scope:${scope}` }];
    if (typeof value === 'boolean') buttons.unshift({ type: 'reply', text: value ? '⛔ Turn OFF' : '✅ Turn ON', id: `${ID}:set:${scope}:${name}:${value ? 'off' : 'on'}` });
    return sendButtons(sock, message.chat, { title: config.bot.name, body, footer: config.bot.footer, buttons }, { quoted: message.raw, fallbackText: body });
};

/** Text form: finds the key in a scope the sender may use. */
const applyText = async (sock, message, access, key, raw) => {
    if (!key) throw new UsageError('Give a setting name.');
    const allowed = await allowedScopes(message, access);
    const found = resolveSetting(key, allowed);
    if (!found) {
        const exists = ['group', 'chat', 'bot'].some((s) => findSetting(s, key));
        throw new UserError(exists ? 'You cannot change this setting here.' : `Unknown setting "${key}".`);
    }
    return apply(sock, message, access, found.scope, found.key, raw);
};

export default {
    name: 'settings',
    aliases: ['setting', 'config', 'set', 'إعدادات', 'اعدادات'],
    category: 'system',
    description: 'Settings with buttons: bot, this chat and group protection (by permission).',
    usage: '[on|off <key> | set <key> <value> | info <key> | reset <key|all>]',
    examples: ['', 'off typing', 'on antiban', 'set antibad warn', 'set mode groups'],
    permission: 'public', // what each person sees and changes is decided per setting
    allowWhenOff: true, // admins can switch a muted chat back on
    cooldown: 1, // buttons are tapped in quick succession

    async onSelect(sock, message, [action, scope, key, value], ctx) {
        const { access } = ctx;
        if (action === 'home') return home(sock, message, access);
        if (action === 'scope' && SCOPES[scope]) return scopePage(sock, message, access, scope);
        if (action === 'open' && SCOPES[scope]) return settingPage(sock, message, access, scope, key);
        if (action === 'set' && SCOPES[scope] && key && value !== undefined) return apply(sock, message, access, scope, key, value);
        return home(sock, message, access);
    },

    async execute(sock, message, args, ctx) {
        const { access } = ctx;
        let [sub, key, ...rest] = args;
        sub = (sub || '').toLowerCase();
        // ".set typing off" works like ".settings set typing off".
        if (ctx.usedName === 'set' && sub && !['set', 'on', 'off', 'reset', 'info'].includes(sub)) [sub, key, rest] = ['set', args[0], args.slice(1)];

        if (!sub) return home(sock, message, access);
        if (sub === 'on' || sub === 'off') return applyText(sock, message, access, key, sub);
        if (sub === 'set') {
            if (!key || !rest.length) throw new UsageError('Give a key and a value.');
            return applyText(sock, message, access, key, rest.join(' '));
        }
        if (sub === 'info') {
            const found = resolveSetting(key, await allowedScopes(message, access));
            if (!found) throw new UserError('Unknown setting, or not yours to change here.');
            return settingPage(sock, message, access, found.scope, found.key);
        }
        if (sub === 'reset') {
            if (!access.atLeast('owner')) throw new UserError('Only bot owners can reset bot settings.');
            if (!key) throw new UsageError('Give a key, or "all".');
            const name = resetSetting(key);
            audit({ action: 'settings:reset', actor: message, target: `bot.${name}` });
            return message.reply(success('SETTINGS', [name === 'all' ? 'All bot settings back to default.' : `${name} → ${show(SCHEMA[name].default)} (default)`]));
        }
        // ".settings typing off" without "set".
        if (key !== undefined) return applyText(sock, message, access, sub, [key, ...rest].join(' '));
        throw new UsageError();
    }
};
