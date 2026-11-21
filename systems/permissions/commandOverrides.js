import docStore from '../database/docStore.js';
import { rankName } from './ranks.js';

/**
 * Runtime permission changes made by the creator (".perm"), stored in the
 * "commandPerms" document. They win over the defaults written in command files.
 *
 *   overrides  { "<cmd>": "<rank>" }          minimum rank instead of the file's
 *   locked     { "<cmd>": true }              creator only
 *   allow      { "<cmd>": [{ number, lid }] } may use it whatever their rank
 *   deny       { "<cmd>": [{ number, lid }] } may never use it (wins over allow)
 *
 * Keys are canonical command names (aliases are resolved by the caller).
 */

const NAME = 'commandPerms';
let doc = null;

const digits = (value) => String(value || '').replace(/\D/g, '');

export const loadCommandOverrides = async () => {
    doc = await docStore.open(NAME, () => ({}));
    doc.overrides ||= {};
    doc.locked ||= {};
    doc.allow ||= {};
    doc.deny ||= {};
    return doc;
};

const ensure = () => {
    if (!doc) throw new Error('Command permissions not loaded.');
    return doc;
};
const save = () => docStore.touch(NAME);

export const getOverride = (command) => doc?.overrides?.[command] || null;
export const isLocked = (command) => Boolean(doc?.locked?.[command]);

export const setOverride = (command, rank) => {
    const name = rankName(rank);
    if (!name || name === 'banned') throw new Error(`Unknown rank "${rank}".`);
    ensure().overrides[command] = name;
    save();
    return name;
};

/** Removes the override, lock and every allow/deny entry of a command. */
export const resetCommand = (command) => {
    const d = ensure();
    const had = Boolean(d.overrides[command] || d.locked[command] || d.allow[command] || d.deny[command]);
    delete d.overrides[command];
    delete d.locked[command];
    delete d.allow[command];
    delete d.deny[command];
    save();
    return had;
};

export const setLocked = (command, locked) => {
    if (locked) ensure().locked[command] = true;
    else delete ensure().locked[command];
    save();
};

const matches = (entry, person) => {
    const number = digits(person.number ?? person.senderNumber);
    const lid = digits(person.lid ?? person.senderLid);
    return Boolean((number && entry.number === number) || (lid && entry.lid === lid));
};

const inList = (list, command, person) => (doc?.[list]?.[command] || []).some((e) => matches(e, person));

export const isAllowed = (command, person) => inList('allow', command, person);
export const isDenied = (command, person) => inList('deny', command, person);

/**
 * Adds a person to the allow or deny list of a command and removes them from the other one.
 * @param {'allow'|'deny'} list
 */
export const addException = (list, command, person) => {
    const d = ensure();
    const other = list === 'allow' ? 'deny' : 'allow';
    const entry = { number: digits(person.number), lid: digits(person.lid) };
    if (!entry.number && !entry.lid) throw new Error('No user given.');
    d[other][command] = (d[other][command] || []).filter((e) => !matches(e, person));
    if (!d[other][command].length) delete d[other][command];
    d[list][command] = [...(d[list][command] || []).filter((e) => !matches(e, person)), entry];
    save();
    return entry;
};

/** Removes a person from both lists of a command. Returns true when something was removed. */
export const clearException = (command, person) => {
    const d = ensure();
    let removed = false;
    for (const list of ['allow', 'deny']) {
        const before = d[list][command] || [];
        const after = before.filter((e) => !matches(e, person));
        removed ||= after.length !== before.length;
        if (after.length) d[list][command] = after;
        else delete d[list][command];
    }
    save();
    return removed;
};

/** Every command with a runtime change, for ".perm list". */
export const listOverrides = () => {
    const d = doc || { overrides: {}, locked: {}, allow: {}, deny: {} };
    const names = new Set([...Object.keys(d.overrides), ...Object.keys(d.locked), ...Object.keys(d.allow), ...Object.keys(d.deny)]);
    return [...names].sort().map((name) => ({
        name,
        rank: d.overrides[name] || null,
        locked: Boolean(d.locked[name]),
        allow: (d.allow[name] || []).map((e) => ({ ...e })),
        deny: (d.deny[name] || []).map((e) => ({ ...e }))
    }));
};
