import events from '../../core/events.js';

/**
 * Remembers the sound of recent sound stickers by message id.
 *
 * WhatsApp's reply copy (contextInfo.quotedMessage) may drop the embedded
 * audio of a sound sticker, so a command replying to one could not find it.
 * Every sound sticker the bot sends or sees is remembered here, and lookups
 * fall back to it by the replied message id.
 *
 * In memory only (bounded, 24 h): after a restart, older stickers fall back to
 * whatever the reply copy carries.
 */

const MAX_ENTRIES = 1000;
const TTL_MS = 24 * 60 * 60 * 1000;
const TAG = 'system:sound-sticker-cache';
const entries = new Map(); // id → { key, audio, at }

export const rememberSound = (key, audio) => {
    if (!key?.id || !audio) return;
    entries.delete(key.id);
    entries.set(key.id, { key, audio, at: Date.now() });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
};

/** @returns {{ key: object, audio: object } | null} */
export const recallSound = (id) => {
    const entry = id ? entries.get(id) : null;
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) { entries.delete(id); return null; }
    return { key: entry.key, audio: entry.audio };
};

export const clearSounds = () => entries.clear();

const seen = ({ message: m }) => {
    const content = m?.raw?.message;
    const audio = content?.stickerMessage?.audioMessage
        || content?.viewOnceMessage?.message?.stickerMessage?.audioMessage
        || content?.ephemeralMessage?.message?.stickerMessage?.audioMessage;
    if (audio) rememberSound(m.raw.key, audio);
    const quoted = m?.quoted?.message?.stickerMessage?.audioMessage;
    if (quoted && m.quoted.key?.id && !entries.has(m.quoted.key.id)) rememberSound(m.quoted.key, quoted);
};

events.offTag(TAG);
events.on('message', seen, { tag: TAG });
events.on('message:self', seen, { tag: TAG });
