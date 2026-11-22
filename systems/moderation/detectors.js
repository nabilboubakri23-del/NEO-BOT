/**
 * Pure content checks used by the moderation guard. No I/O.
 */

const INVITE_RE = /(?:https?:\/\/)?(?:chat\.whatsapp\.com\/(?:invite\/)?[A-Za-z0-9_-]{8,}|(?:www\.)?whatsapp\.com\/channel\/[A-Za-z0-9_-]{8,}|wa\.me\/(?:invite|channel)\/[A-Za-z0-9_-]{8,})/i;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|me|ly|gg|co|xyz|app|link|info|biz|tv|site|online|store|shop|club|top|ru|tk)\b(?:\/[^\s]*)?/i;

/** WhatsApp group / channel invite link. */
export const hasInviteLink = (text) => INVITE_RE.test(String(text || ''));

/** Any web link (URL with a scheme, "www.", or a bare domain with a common TLD). */
export const hasAnyLink = (text) => URL_RE.test(String(text || ''));

/** Link check for a group's linkscope option. */
export const hasLink = (text, scope = 'invites') => (scope === 'all' ? hasAnyLink(text) || hasInviteLink(text) : hasInviteLink(text));

/** Contact card: a contact message, a contact list, or raw vCard text. */
export const hasVCard = (message) => {
    const type = message?.type;
    if (type === 'contactMessage' || type === 'contactsArrayMessage') return true;
    return /BEGIN:VCARD/i.test(String(message?.text || ''));
};
