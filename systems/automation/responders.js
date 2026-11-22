/**
 * Matching rules for auto-replies and auto-reactions. Pure, no I/O.
 *   reply:  the whole message equals the trigger (case-insensitive) → one of the replies
 *   react:  the trigger appears as a whole word or phrase → one of the emojis
 */

export const normalizeTrigger = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reply for a message, or null. `rules` = { trigger: [reply, ...] } */
export const findReply = (rules, text, random = Math.random) => {
    const options = rules?.[normalizeTrigger(text)];
    return options?.length ? options[Math.floor(random() * options.length)] : null;
};

/** Emoji for a message, or null. `rules` = { trigger: [emoji, ...] } (first matching trigger wins). */
export const findReaction = (rules, text, random = Math.random) => {
    const body = normalizeTrigger(text);
    if (!body) return null;
    for (const [trigger, emojis] of Object.entries(rules || {})) {
        if (!emojis?.length) continue;
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${escape(trigger)}($|[^\\p{L}\\p{N}])`, 'u').test(body)) return emojis[Math.floor(random() * emojis.length)];
    }
    return null;
};

/** Splits "trigger | reply one | reply two" into { trigger, values }. */
export const parseRule = (text) => {
    const [trigger, ...values] = String(text || '').split('|').map((s) => s.trim());
    return { trigger: normalizeTrigger(trigger), values: values.filter(Boolean) };
};
