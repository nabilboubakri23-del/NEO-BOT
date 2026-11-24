import docStore from '../database/docStore.js';
import { personKey } from '../../utils/targets.js';

/**
 * Per-group bot lists, changed by ".antibot":
 *   bots:  senders flagged automatically or added by an admin → every message removed
 *   allow: bots the admins want to keep (never touched)
 * { "<group>": { bots: { "<key>": { jid, reason, at, by } }, allow: { "<key>": { jid, at } } } }
 */

const NAME = 'knownBots';
const MAX_PER_GROUP = 200;
let doc = null;

export const loadKnownBots = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const group = (g) => {
    if (!doc) throw new Error('Known bots not loaded.');
    doc[g] ||= { bots: {}, allow: {} };
    return doc[g];
};

const save = () => docStore.touch(NAME);

export const isKnownBot = (g, who) => Boolean(doc?.[g]?.bots?.[personKey(who)]);
export const isAllowedBot = (g, who) => Boolean(doc?.[g]?.allow?.[personKey(who)]);

export const flagBot = (g, who, { jid = '', reason = '', by = 'auto' } = {}) => {
    const key = personKey(who);
    if (!key) return false;
    const entry = group(g);
    if (entry.allow[key]) return false;
    if (!entry.bots[key] && Object.keys(entry.bots).length >= MAX_PER_GROUP) delete entry.bots[Object.keys(entry.bots)[0]];
    const isNew = !entry.bots[key];
    entry.bots[key] = { jid, reason, at: new Date().toISOString(), by };
    save();
    return isNew;
};

export const allowBot = (g, who, jid = '') => {
    const key = personKey(who);
    const entry = group(g);
    delete entry.bots[key];
    entry.allow[key] = { jid, at: new Date().toISOString() };
    save();
};

/** Removes a person from both lists. */
export const forgetBot = (g, who) => {
    const key = personKey(who);
    const entry = group(g);
    const had = Boolean(entry.bots[key] || entry.allow[key]);
    delete entry.bots[key];
    delete entry.allow[key];
    save();
    return had;
};

export const listBots = (g) => {
    const entry = doc?.[g] || { bots: {}, allow: {} };
    return { bots: Object.entries(entry.bots), allow: Object.entries(entry.allow) };
};

export const clearBots = (g) => {
    if (!doc?.[g]) return 0;
    const n = Object.keys(doc[g].bots).length;
    doc[g].bots = {};
    save();
    return n;
};
