import docStore from '../database/docStore.js';
import { findPerson, personKey } from '../../utils/targets.js';

/**
 * Muted members per group: the guard deletes their messages while the mute lasts.
 * { "<group>": { "<personKey>": { number, lid, until (0 = until unmuted), by } } }
 */

const NAME = 'mutes';
let doc = null;

export const loadMutes = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const ensure = () => {
    if (!doc) throw new Error('Mutes not loaded.');
    return doc;
};

const expired = (record, now) => record.until && record.until <= now;

/** Mutes a member; `ms` = 0 means until unmuted. Returns the stored record. */
export const muteMember = (group, who, { ms = 0, by = '', now = Date.now() } = {}) => {
    const groups = ensure();
    groups[group] ||= {};
    const found = findPerson(groups[group], who);
    const record = { number: who.number || found?.record.number || '', lid: who.lid || found?.record.lid || '', until: ms ? now + ms : 0, by };
    if (found) delete groups[group][found.key];
    groups[group][personKey(who)] = record;
    docStore.touch(NAME);
    return record;
};

/** Unmutes a member. Returns false when they were not muted. */
export const unmuteMember = (group, who) => {
    const members = ensure()[group];
    const found = findPerson(members, who);
    if (!found) return false;
    delete members[found.key];
    if (!Object.keys(members).length) delete doc[group];
    docStore.touch(NAME);
    return true;
};

/** The active mute of a member, or null. Expired mutes are removed on the way. */
export const activeMute = (group, who, now = Date.now()) => {
    const members = doc?.[group];
    if (!members) return null;
    const found = findPerson(members, who);
    if (!found) return null;
    if (expired(found.record, now)) {
        unmuteMember(group, who);
        return null;
    }
    return found.record;
};

/** Active mutes of a group. */
export const listMutes = (group, now = Date.now()) => Object.values(doc?.[group] || {}).filter((r) => !expired(r, now));

/** True when a group has any mute stored (fast path for the guard). */
export const hasMutes = (group) => Boolean(doc?.[group] && Object.keys(doc[group]).length);
