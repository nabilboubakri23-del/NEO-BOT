import docStore from '../database/docStore.js';

/**
 * Audit log of permission changes: rank grants and revokes, expiries,
 * command overrides, locks, allow/deny exceptions, bans and owner changes.
 * Kept as a ring buffer of the last MAX entries in the "audit" document.
 *
 * Entry: { at, action, actor, target, detail }
 *   actor / target are short ids ("+2126...", "LID 123", "system", a command name)
 */

const NAME = 'audit';
const MAX = 200;
let doc = null;

export const loadAudit = async () => {
    doc = await docStore.open(NAME, () => ({ entries: [] }));
    doc.entries ||= [];
    return doc;
};

/** Short printable id of a person ({ number, lid } or a message). */
export const who = (person) => {
    if (!person) return 'system';
    const number = person.number ?? person.senderNumber;
    const lid = person.lid ?? person.senderLid;
    return (number && `+${number}`) || (lid && `LID ${lid}`) || 'unknown';
};

export const audit = ({ action, actor = null, target = '', detail = '' }) => {
    if (!doc) return null;
    const entry = { at: Date.now(), action, actor: typeof actor === 'string' ? actor : who(actor), target: typeof target === 'string' ? target : who(target), detail };
    doc.entries.push(entry);
    if (doc.entries.length > MAX) doc.entries.splice(0, doc.entries.length - MAX);
    docStore.touch(NAME);
    return entry;
};

/** Newest first. */
export const recentAudit = (limit = 10) => (doc?.entries || []).slice(-Math.max(1, limit)).reverse();
