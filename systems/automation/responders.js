/**
 * Matching rules for auto-replies and auto-reactions. Pure, no I/O.
 *   reply:  the whole message equals the trigger (case-insensitive) → one of the replies
 *           a trigger written "*word" matches the word or phrase anywhere in the message
 *   react:  the trigger appears as a whole word or phrase → one of the emojis
 */

export const normalizeTrigger = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pick = (list, random) => list[Math.floor(random() * list.length)];

/** True when `phrase` appears in `body` as a whole word or phrase (any script). */
export const containsPhrase = (body, phrase) =>
    Boolean(phrase) && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(phrase)}($|[^\\p{L}\\p{N}])`, 'u').test(body);

/** Reply for a message, or null. `rules` = { trigger: [reply, ...] }; exact triggers win over "*contains" ones. */
export const findReply = (rules, text, random = Math.random) => {
    const body = normalizeTrigger(text);
    if (!body) return null;
    const exact = rules?.[body];
    if (exact?.length) return pick(exact, random);
    for (const [trigger, replies] of Object.entries(rules || {})) {
        if (!trigger.startsWith('*') || !replies?.length) continue;
        if (containsPhrase(body, trigger.slice(1).trim())) return pick(replies, random);
    }
    return null;
};

/** Emoji for a message, or null. `rules` = { trigger: [emoji, ...] } (first matching trigger wins). */
export const findReaction = (rules, text, random = Math.random) => {
    const body = normalizeTrigger(text);
    if (!body) return null;
    for (const [trigger, emojis] of Object.entries(rules || {})) {
        if (emojis?.length && containsPhrase(body, trigger.replace(/^\*/, '').trim())) return pick(emojis, random);
    }
    return null;
};

/** Splits "trigger | reply one | reply two" into { trigger, values }. */
export const parseRule = (text) => {
    const [trigger, ...values] = String(text || '').split('|').map((s) => s.trim());
    return { trigger: normalizeTrigger(trigger), values: values.filter(Boolean) };
};

/** Fills {name} {number} {time} {date} in a reply. */
export const fillPlaceholders = (template, { name = '', number = '', now = new Date(), timeZone } = {}) => {
    const opts = timeZone ? { timeZone } : {};
    const values = {
        name: name || number || 'there',
        number,
        time: now.toLocaleTimeString('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' }),
        date: now.toLocaleDateString('en-GB', opts)
    };
    return String(template).replace(/\{(name|number|time|date)\}/gi, (_, key) => values[key.toLowerCase()]);
};

/** Auto-react modes. `true` is the v1.4 "on" and means trigger words only. */
export const REACT_MODES = Object.freeze(['smart', 'words', 'all', 'owner']);
export const reactMode = (value) => (value === true ? 'words' : REACT_MODES.includes(value) ? value : null);

/** Splits "😂 🔥, ❤️" into a clean emoji list (max 20, each up to 8 chars). */
export const parseEmojis = (text) =>
    [...new Set(String(text || '').split(/[\s,|]+/).map((s) => s.trim()).filter((s) => s && s.length <= 8 && !/[\p{L}\p{N}]/u.test(s)))].slice(0, 20);

export const DEFAULT_EMOJIS = Object.freeze(['❤️', '🔥', '😂', '👍', '😮', '💯', '👏', '✨']);
