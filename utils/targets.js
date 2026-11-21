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
