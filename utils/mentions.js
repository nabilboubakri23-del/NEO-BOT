import { targetJid } from './targets.js';

/**
 * Mentions: WhatsApp highlights "@<user>" in the text when the same JID is in `mentions`.
 * Each helper returns { jid, text } so both always match.
 */

export const mentionJid = (jid) => ({ jid, text: `@${String(jid).split('@')[0].split(':')[0]}` });

/** The sender of a message, as addressed in that chat (LID or phone number). */
export const mentionOf = (message) => mentionJid(message.raw?.key?.participant || message.sender);

/** A target { number, lid } from utils/targets.js. */
export const mentionTarget = (target) => mentionJid(targetJid(target));
