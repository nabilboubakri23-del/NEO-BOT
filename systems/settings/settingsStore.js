import docStore from '../database/docStore.js';
import { UserError } from '../../utils/errors.js';

/**
 * Bot settings that can be changed from WhatsApp (".settings"), no code edits.
 * Global settings apply everywhere; chat settings apply to one chat (group or private).
 * Every key is declared in SCHEMA with its type, default and allowed values,
 * so nothing invalid can ever be stored.
 */

const MODES = ['public', 'private', 'groups', 'inbox'];

export const SCHEMA = Object.freeze({
    mode: { type: 'enum', values: MODES, default: 'public', description: 'public = everyone, private = owners and creator only, groups = groups only, inbox = private chats only' },
    autoRead: { type: 'bool', default: false, description: 'Mark incoming messages as read' },
    typing: { type: 'bool', default: true, description: 'Show "typing..." while a command runs' },
    channelForward: { type: 'bool', default: true, description: 'Show bot messages as forwarded from the bot channel' },
    thumbnailCard: { type: 'bool', default: true, description: 'Show a random picture card above bot text messages' },
    cooldown: { type: 'int', min: 0, max: 300, default: 3, description: 'Default seconds between uses of the same command' },
    antiSpam: { type: 'bool', default: true, description: 'Mute users who flood commands' },
    spamLimit: { type: 'int', min: 2, max: 50, default: 6, description: 'Commands allowed per 10 seconds before muting' },
    suggest: { type: 'bool', default: true, description: 'Reply "did you mean" for mistyped commands' },
    dailyLimit: { type: 'int', min: 0, max: 100000, default: 100, description: 'Commands per day for the User rank (0 = unlimited; Premium and above are unlimited)' }
});

export const CHAT_SCHEMA = Object.freeze({
    enabled: { type: 'bool', default: true, description: 'Bot answers in this chat' }
});

const NAME = 'settings';
let doc = null;

export const loadSettings = async () => {
    doc = await docStore.open(NAME, () => ({ global: {}, chats: {} }));
    doc.global ||= {};
    doc.chats ||= {};
    return doc;
};

const ensure = () => {
    if (!doc) throw new Error('Settings not loaded.');
    return doc;
};

/** Validates and converts a raw text value against one schema entry (shared by every typed store). */
export const coerce = (spec, key, raw) => {
    const value = String(raw).trim().toLowerCase();
    switch (spec.type) {
        case 'bool':
            if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(value)) return true;
            if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(value)) return false;
            throw new UserError(`${key} must be on or off.`);
        case 'int': {
            const n = Number(value);
            if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new UserError(`${key} must be a whole number from ${spec.min} to ${spec.max}.`);
            return n;
        }
        case 'enum':
            if (!spec.values.includes(value)) throw new UserError(`${key} must be one of: ${spec.values.join(', ')}.`);
            return value;
        default:
            throw new UserError(`Unsupported setting type for ${key}.`);
    }
};

const findKey = (schema, key) => Object.keys(schema).find((k) => k.toLowerCase() === String(key).toLowerCase());

/** Current value of a global setting (default when never set). */
export const getSetting = (key) => {
    const value = doc?.global?.[key];
    return value === undefined ? SCHEMA[key]?.default : value;
};

export const getAllSettings = () => Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, getSetting(k)]));

export const setSetting = (key, raw) => {
    const name = findKey(SCHEMA, key);
    if (!name) throw new UserError(`Unknown setting "${key}".`);
    const value = coerce(SCHEMA[name], name, raw);
    ensure().global[name] = value;
    docStore.touch(NAME);
    return { key: name, value };
};

export const resetSetting = (key) => {
    if (key === 'all') {
        ensure().global = {};
        docStore.touch(NAME);
        return 'all';
    }
    const name = findKey(SCHEMA, key);
    if (!name) throw new UserError(`Unknown setting "${key}".`);
    delete ensure().global[name];
    docStore.touch(NAME);
    return name;
};

export const getChatSetting = (chat, key) => {
    const value = doc?.chats?.[chat]?.[key];
    return value === undefined ? CHAT_SCHEMA[key]?.default : value;
};

export const setChatSetting = (chat, key, raw) => {
    const name = findKey(CHAT_SCHEMA, key);
    if (!name) throw new UserError(`Unknown chat setting "${key}".`);
    const value = coerce(CHAT_SCHEMA[name], name, raw);
    const chats = ensure().chats;
    chats[chat] = { ...(chats[chat] || {}), [name]: value };
    // Keep the document small: drop values equal to their default.
    if (value === CHAT_SCHEMA[name].default) delete chats[chat][name];
    if (!Object.keys(chats[chat]).length) delete chats[chat];
    docStore.touch(NAME);
    return { key: name, value };
};
