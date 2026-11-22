import { CHAT_SCHEMA, SCHEMA, getChatSetting, getSetting, setChatSetting, setSetting } from './settingsStore.js';
import { GROUP_SCHEMA, getGroupOption, setGroupOption } from '../moderation/groupConfig.js';
import { UserError } from '../../utils/errors.js';

/**
 * One view over every switch the bot has, grouped by scope, each with who may change it.
 * Used by ".settings" (text and buttons). Permission is checked on EVERY change,
 * not only when the menu is shown, so a forged or forwarded button id cannot bypass it.
 *
 * Scopes:
 *   bot   global settings           → Owner rank and above
 *   chat  this chat (bot on/off)    → group admins in groups, owners anywhere
 *   group group protection options → group admins or Moderator rank and above (groups only)
 */

export const SCOPES = Object.freeze({
    bot: { title: '🤖 Bot', schema: SCHEMA },
    chat: { title: '💬 This chat', schema: CHAT_SCHEMA },
    group: { title: '🛡️ Group protection', schema: GROUP_SCHEMA }
});

/** Settings only the creator may touch (they can lock everyone else out). */
const CREATOR_ONLY = new Set(); // e.g. 'bot.mode' to keep a key for the creator alone

const ORDER = ['group', 'chat', 'bot'];

/** What the sender may change here: { bot, chat, group } booleans. */
export const allowedScopes = async (message, access) => {
    const owner = access.atLeast('owner');
    const groupAdmin = message.isGroup ? await access.isAdmin() : false;
    return {
        bot: owner,
        chat: owner || groupAdmin,
        group: message.isGroup && (groupAdmin || access.atLeast('moderator'))
    };
};

/** True when this key needs more than its scope (e.g. creator-only). */
const keyAllowed = (scope, key, access) => !CREATOR_ONLY.has(`${scope}.${key}`) || access.isCreator || access.atLeast('creator');

export const findSetting = (scope, key) => {
    const schema = SCOPES[scope]?.schema;
    if (!schema) return null;
    const name = Object.keys(schema).find((k) => k.toLowerCase() === String(key).toLowerCase());
    return name ? { scope, key: name, spec: schema[name] } : null;
};

/** Finds a key in any scope the sender may use (group first, then chat, then bot). */
export const resolveSetting = (key, allowed) => {
    for (const scope of ORDER) {
        if (!allowed[scope]) continue;
        const found = findSetting(scope, key);
        if (found) return found;
    }
    return null;
};

export const readSetting = (scope, key, chat) => {
    if (scope === 'bot') return getSetting(key);
    if (scope === 'chat') return getChatSetting(chat, key);
    return getGroupOption(chat, key);
};

/** Checks permission, then writes. Throws UserError when not allowed. */
export const writeSetting = async (scope, key, raw, { message, access }) => {
    const allowed = await allowedScopes(message, access);
    const found = findSetting(scope, key);
    if (!found) throw new UserError(`Unknown setting "${key}".`);
    if (!allowed[scope]) throw new UserError(scope === 'bot' ? 'Only bot owners can change bot settings.' : scope === 'group' ? 'Only group admins can change this (in a group).' : 'Only group admins can change this.');
    if (!keyAllowed(scope, found.key, access)) throw new UserError(`Only the creator can change ${found.key}.`);
    if (scope === 'bot') return setSetting(found.key, raw);
    if (scope === 'chat') return setChatSetting(message.chat, found.key, raw);
    return setGroupOption(message.chat, found.key, raw);
};

/** Every setting the sender may see, by scope. */
export const visibleSettings = async (message, access) => {
    const allowed = await allowedScopes(message, access);
    return ORDER.filter((s) => allowed[s]).map((scope) => ({
        scope,
        title: SCOPES[scope].title,
        items: Object.entries(SCOPES[scope].schema)
            .filter(([key]) => keyAllowed(scope, key, access))
            .map(([key, spec]) => ({ key, spec, value: readSetting(scope, key, message.chat) }))
    }));
};

export const show = (v) => (v === true ? 'ON ✅' : v === false ? 'OFF ⛔' : String(v));

/** Choices offered as buttons / rows for one setting. */
export const choicesFor = (spec) => {
    if (spec.type === 'bool') return ['on', 'off'];
    if (spec.type === 'enum') return [...spec.values];
    const picks = new Set([spec.min, spec.default, spec.max]);
    const span = spec.max - spec.min;
    for (const f of [0.25, 0.5]) picks.add(Math.round(spec.min + span * f));
    return [...picks].sort((a, b) => a - b).map(String);
};
