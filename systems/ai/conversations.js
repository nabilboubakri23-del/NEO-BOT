/**
 * Short per-person conversation memory for the AI chat, in memory only:
 * the last few turns, forgotten after a period of silence.
 */

const MAX_TURNS = 6; // messages kept (user + assistant)
const TTL_MS = 10 * 60 * 1000;
const MAX_CONVERSATIONS = 300;

const conversations = new Map(); // key → { messages, at }

export const history = (key, now = Date.now()) => {
    const entry = conversations.get(key);
    if (!entry || now - entry.at > TTL_MS) {
        conversations.delete(key);
        return [];
    }
    return entry.messages;
};

export const remember = (key, userText, answer, now = Date.now()) => {
    const messages = [...history(key, now), { role: 'user', content: userText }, { role: 'assistant', content: answer }].slice(-MAX_TURNS);
    conversations.delete(key);
    conversations.set(key, { messages, at: now });
    if (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
};

export const forget = (key) => conversations.delete(key);
