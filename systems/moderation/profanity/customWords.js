import docStore from '../../database/docStore.js';
import { UserError } from '../../../utils/errors.js';
import { normalizeCustom } from './matcher.js';

/**
 * Per-group word lists managed by group admins:
 *   block: extra words/phrases to catch
 *   allow: built-in words this group accepts (false positives, names)
 * Stored normalized, so "كُسّ", "كـس" and "كس" are one entry.
 * { "<group>": { block: [], allow: [] } }
 */

const NAME = 'badwords';
const MAX_WORDS = 200;
let doc = null;

export const loadCustomWords = async () => {
    doc = await docStore.open(NAME, () => ({}));
    return doc;
};

const ensure = (group) => {
    if (!doc) throw new Error('Custom words not loaded.');
    doc[group] ||= { block: [], allow: [] };
    return doc[group];
};

/** Lists of a group (empty arrays when none). */
export const getCustomWords = (group) => ({ block: doc?.[group]?.block || [], allow: doc?.[group]?.allow || [] });

/** Adds a word to "block" or "allow". Returns the normalized entry. */
export const addCustomWord = (group, list, input) => {
    const entry = normalizeCustom(input);
    if (!entry || entry.length < 2) throw new UserError('Give a word of at least 2 letters.');
    if (entry.length > 60) throw new UserError('Too long (60 letters max).');
    const lists = ensure(group);
    if (lists[list].includes(entry)) return { entry, added: false };
    if (lists[list].length >= MAX_WORDS) throw new UserError(`List full (${MAX_WORDS} entries).`);
    lists[list].push(entry);
    const other = list === 'block' ? 'allow' : 'block';
    lists[other] = lists[other].filter((w) => w !== entry);
    docStore.touch(NAME);
    return { entry, added: true };
};

export const removeCustomWord = (group, list, input) => {
    const entry = normalizeCustom(input);
    const lists = ensure(group);
    const before = lists[list].length;
    lists[list] = lists[list].filter((w) => w !== entry);
    if (!lists.block.length && !lists.allow.length) delete doc[group];
    docStore.touch(NAME);
    return before !== (doc[group]?.[list]?.length ?? 0);
};
