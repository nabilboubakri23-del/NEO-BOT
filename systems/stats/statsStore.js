import docStore from '../database/docStore.js';

/**
 * Usage statistics: lifetime counters (saved) and since-start counters (memory).
 */

const NAME = 'stats';
let doc = null;
const session = { startedAt: Date.now(), messages: 0, commands: 0, errors: 0 };

export const loadStats = async () => {
    doc = await docStore.open(NAME, () => ({ messages: 0, commands: 0, errors: 0, perCommand: {} }));
    doc.perCommand ||= {};
    return doc;
};

export const countMessage = () => {
    session.messages += 1;
    if (doc) {
        doc.messages += 1;
        docStore.touch(NAME);
    }
};

export const countCommand = (name, { failed = false } = {}) => {
    session.commands += 1;
    if (failed) session.errors += 1;
    if (!doc) return;
    doc.commands += 1;
    if (failed) doc.errors += 1;
    doc.perCommand[name] = (doc.perCommand[name] || 0) + 1;
    docStore.touch(NAME);
};

export const getStats = () => ({
    session: { ...session },
    total: { messages: doc?.messages || 0, commands: doc?.commands || 0, errors: doc?.errors || 0 },
    top: Object.entries(doc?.perCommand || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
});
