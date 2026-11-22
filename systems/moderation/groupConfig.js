import docStore from '../database/docStore.js';
import { coerce } from '../settings/settingsStore.js';
import { UserError } from '../../utils/errors.js';

/**
 * Per-group moderation options, changed by group admins with ".gset".
 * Every key is declared in GROUP_SCHEMA (type, default, allowed values), so nothing
 * invalid is ever stored. Values equal to their default are not stored at all.
 */

const ACTIONS = ['off', 'delete', 'warn', 'kick'];

export const GROUP_SCHEMA = Object.freeze({
    antilink: { type: 'enum', values: ACTIONS, default: 'off', description: 'Links from members: off | delete | warn (delete + warning) | kick' },
    linkscope: { type: 'enum', values: ['invites', 'all'], default: 'all', description: 'Which links anti-link catches: invites = WhatsApp group/channel links, all = any URL' },
    antivcard: { type: 'enum', values: ACTIONS, default: 'off', description: 'Contact cards (vCards) from members: off | delete | warn | kick' },
    antibad: { type: 'enum', values: ACTIONS, default: 'off', description: 'Profanity (Arabic dialects, Arabizi, English): off | delete | warn | kick' },
    badlevel: { type: 'enum', values: ['normal', 'strict'], default: 'normal', description: 'normal = severe insults only, strict = also mild ones (حمار, stupid)' },
    antispam: { type: 'enum', values: ['off', 'delete', 'warn', 'mute', 'kick'], default: 'off', description: 'Flood, repeats, mass tags, crash texts: off | delete | warn | mute (escalating) | kick (after 2 strikes)' },
    spamlimit: { type: 'int', min: 4, max: 20, default: 7, description: 'Messages allowed per 10 seconds before it counts as flood' },
    exemptadmins: { type: 'bool', default: true, description: 'Group admins and bot staff skip protection (turn off to test it as an admin)' },
    warnlimit: { type: 'int', min: 2, max: 10, default: 3, description: 'Warnings before a member is removed' },
    adminonly: { type: 'bool', default: false, description: 'Only group admins (and bot staff) can use commands here' },
    levelup: { type: 'bool', default: false, description: 'Announce level-ups in this group' }
});

const NAME = 'groupConfig';
let doc = null;

export const loadGroupConfig = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const findKey = (key) => Object.keys(GROUP_SCHEMA).find((k) => k === String(key).toLowerCase());

/** One option of a group (default when never set). */
export const getGroupOption = (group, key) => {
    const value = doc?.[group]?.[key];
    return value === undefined ? GROUP_SCHEMA[key]?.default : value;
};

/** Every option of a group, defaults included. */
export const getGroupConfig = (group) => Object.fromEntries(Object.keys(GROUP_SCHEMA).map((k) => [k, getGroupOption(group, k)]));

export const setGroupOption = (group, key, raw) => {
    if (!doc) throw new Error('Group config not loaded.');
    const name = findKey(key);
    if (!name) throw new UserError(`Unknown option "${key}". Options: ${Object.keys(GROUP_SCHEMA).join(', ')}.`);
    const value = coerce(GROUP_SCHEMA[name], name, raw);
    const entry = { ...(doc[group] || {}), [name]: value };
    if (value === GROUP_SCHEMA[name].default) delete entry[name];
    if (Object.keys(entry).length) doc[group] = entry;
    else delete doc[group];
    docStore.touch(NAME);
    return { key: name, value };
};

/** True when any enforcement option is active (lets the message guard skip quiet groups fast). */
export const hasActiveGuards = (group) =>
    ['antilink', 'antivcard', 'antibad', 'antispam'].some((key) => getGroupOption(group, key) !== 'off');
