/**
 * Anti-duplicate guard.
 * WhatsApp can deliver the same message twice (reconnects, retries, multi-device
 * echoes). Each message id is processed once; the bot's own replies are never
 * processed at all.
 */

const LIMIT = 5000;
const seen = new Set();
const sentByBot = new Set();

const remember = (set, id) => {
    set.add(id);
    if (set.size > LIMIT) set.delete(set.values().next().value);
};

/** Returns true the second time the same id is seen. */
export const isDuplicate = (id) => {
    if (!id) return false;
    if (seen.has(id)) return true;
    remember(seen, id);
    return false;
};

/** Records a message id the bot sent, so its own replies never re-trigger commands. */
export const rememberOwnMessage = (id) => {
    if (id) remember(sentByBot, id);
};

export const isOwnMessage = (id) => Boolean(id) && sentByBot.has(id);
