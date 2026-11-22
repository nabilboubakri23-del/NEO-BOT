import { jidNormalizedUser } from 'baileys';

/**
 * Who a command targets: a @mention, the author of the replied message,
 * or a typed number. LIDs are mapped to phone numbers when WhatsApp knows them.
 * @returns {Promise<{ number: string, lid: string } | null>}
 */
export const resolveUserTarget = async (sock, message, arg) => {
    const jid = message.mentions?.[0] || (arg && /\d{6,}/.test(arg) ? null : message.quoted?.sender);

    if (!jid) {
        const number = String(arg || '').replace(/\D/g, '');
        return number.length >= 6 ? { number, lid: '' } : null;
    }
    const normalized = jidNormalizedUser(jid);
    const user = normalized.split('@')[0];
    if (!normalized.endsWith('@lid')) return { number: user, lid: '' };

    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(normalized).catch(() => null);
    return { lid: user, number: pn ? jidNormalizedUser(pn).split('@')[0] : '' };
};

export const describeTarget = (t) => [t.number && `+${t.number}`, t.lid && `LID ${t.lid}`].filter(Boolean).join('  ') || 'unknown';

/** True when the first argument named the target itself (a number or "@mention"), so the rest are other args. */
export const isTargetArg = (arg) => /\d{6,}/.test(String(arg || '')) || String(arg || '').startsWith('@');

/** JID to act on for a target: the phone-number JID when known, otherwise the LID. */
export const targetJid = (t) => (t.number ? `${t.number}@s.whatsapp.net` : `${t.lid}@lid`);

/** The sender of a message as a target ({ number, lid }). */
export const senderOf = (message) => ({ number: message.senderNumber || '', lid: message.senderLid || '' });

/** Storage key for a person: the number when known, otherwise the LID (digits only). */
export const personKey = (who) => String(who?.number || who?.lid || '').replace(/\D/g, '');

/** True when a stored { number, lid } record is the same person as `who`. */
export const samePerson = (record, who) => {
    if (!record || !who) return false;
    const n = String(who.number || '');
    const l = String(who.lid || '');
    return Boolean((n && record.number === n) || (l && record.lid === l));
};

/** Finds the record of `who` in an object keyed by personKey (falls back to a scan by LID / number). */
export const findPerson = (map, who) => {
    if (!map) return null;
    const key = personKey(who);
    if (key && map[key]) return { key, record: map[key] };
    for (const [k, record] of Object.entries(map)) if (samePerson(record, who)) return { key: k, record };
    return null;
};

/** True when a JID (phone number or LID form) is the linked bot account itself. */
export const isSelf = (sock, jid) => {
    if (!jid) return false;
    const user = String(jid).split('@')[0].split(':')[0];
    const me = sock?.user || {};
    return [me.id, me.lid].filter(Boolean).some((j) => String(j).split('@')[0].split(':')[0] === user);
};
