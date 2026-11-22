import docStore from '../database/docStore.js';
import { findPerson, personKey } from '../../utils/targets.js';

/**
 * Warnings per group and member: { "<group>": { "<personKey>": { number, lid, count, history: [...] } } }.
 * Only the store; what happens at the limit lives in actions.js.
 */

const NAME = 'warnings';
const MAX_HISTORY = 10;
let doc = null;

export const loadWarnings = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const groupOf = (group, create = false) => {
    if (!doc) throw new Error('Warnings not loaded.');
    if (create) doc[group] ||= {};
    return doc[group] || null;
};

/** Current warning count of a member (0 when none). */
export const warningCount = (group, who) => findPerson(groupOf(group), who)?.record.count || 0;

/** Adds one warning and returns the new count. */
export const addWarning = (group, who, { by = '', reason = '' } = {}) => {
    const members = groupOf(group, true);
    const found = findPerson(members, who);
    const record = found?.record || { number: who.number || '', lid: who.lid || '', count: 0, history: [] };
    if (!found) members[personKey(who)] = record;
    if (who.number && !record.number) record.number = who.number;
    if (who.lid && !record.lid) record.lid = who.lid;
    record.count += 1;
    record.history = [...(record.history || []), { by, reason, at: Date.now() }].slice(-MAX_HISTORY);
    docStore.touch(NAME);
    return record.count;
};

/** Removes `amount` warnings (default one) and returns the new count. */
export const removeWarning = (group, who, amount = 1) => {
    const members = groupOf(group);
    const found = findPerson(members, who);
    if (!found) return 0;
    found.record.count = Math.max(0, found.record.count - amount);
    found.record.history = (found.record.history || []).slice(0, found.record.count);
    if (!found.record.count) delete members[found.key];
    if (!Object.keys(members).length) delete doc[group];
    docStore.touch(NAME);
    return found.record.count;
};

/** Clears every warning of a member. */
export const clearWarnings = (group, who) => removeWarning(group, who, Infinity);

/** Members of a group with warnings, most warned first. */
export const listWarnings = (group) =>
    Object.values(groupOf(group) || {})
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count);

/** Last reasons given for a member's warnings. */
export const warningHistory = (group, who) => findPerson(groupOf(group), who)?.record.history || [];
