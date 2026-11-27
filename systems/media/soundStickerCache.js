import { normalizeMessageContent, proto } from 'baileys';
import events from '../../core/events.js';
import docStore from '../database/docStore.js';
import { child } from '../../core/logger.js';

/**
 * Remembers the sound of every sound sticker the bot sends or sees, from anyone,
 * by message id, plus the latest one per chat.
 *
 * WhatsApp's reply copy (contextInfo.quotedMessage) may drop the embedded audio
 * of a sound sticker, so a command replying to one could not find it. Lookups
 * fall back to this cache by the replied message id.
 *
 * Kept in memory and saved to docStore (doc "soundStickers"), so it survives
 * restarts and redeploys. Only the media pointer is stored (no audio bytes):
 * bounded to MAX_ENTRIES, 7 days.
 */

const log = child('sound-sticker-cache');
const MAX_ENTRIES = 500;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOC = 'soundStickers';
const TAG = 'system:sound-sticker-cache';
const entries = new Map(); // id → { key, audio, at }
const latest = new Map();  // chat jid → id
let doc = null;

const toPlain = (audio) => proto.Message.AudioMessage.toObject(proto.Message.AudioMessage.fromObject(audio), { bytes: String, longs: Number });
const fromPlain = (audio) => proto.Message.AudioMessage.fromObject(audio);
const plainKey = (key) => ({ remoteJid: key.remoteJid, id: key.id, fromMe: Boolean(key.fromMe), ...(key.participant ? { participant: key.participant } : {}) });

const save = () => {
    if (!doc) return;
    doc.entries = [...entries.entries()].map(([id, e]) => ({ id, key: plainKey(e.key), audio: toPlain(e.audio), at: e.at }));
    doc.latest = Object.fromEntries(latest);
    docStore.touch(DOC);
};

/** Loads the saved cache once (called at start-up; safe to call again). */
export const loadSounds = async () => {
    if (doc) return;
    try {
        doc = await docStore.open(DOC, () => ({ entries: [], latest: {} }));
        const now = Date.now();
        for (const e of doc.entries || []) {
            if (!e?.id || now - e.at > TTL_MS || entries.has(e.id)) continue;
            try { entries.set(e.id, { key: e.key, audio: fromPlain(e.audio), at: e.at }); } catch { /* skip bad row */ }
        }
        for (const [chat, id] of Object.entries(doc.latest || {})) if (entries.has(id)) latest.set(chat, id);
    } catch (error) {
        log.warn(`Could not load saved sound stickers: ${error?.message}`);
    }
};

export const rememberSound = (key, audio) => {
    if (!key?.id || !audio?.mediaKey) return;
    entries.delete(key.id);
    entries.set(key.id, { key, audio, at: Date.now() });
    if (key.remoteJid) latest.set(key.remoteJid, key.id);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    try { save(); } catch (error) { log.warn(`Could not save sound sticker: ${error?.message}`); }
};

const fresh = (id) => {
    const entry = id ? entries.get(id) : null;
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) { entries.delete(id); return null; }
    return { key: entry.key, audio: entry.audio };
};

/** @returns {{ key: object, audio: object } | null} */
export const recallSound = (id) => fresh(id);

/** Latest sound sticker seen in a chat (from anyone), or null. */
export const latestSound = (chat) => fresh(latest.get(chat));

export const clearSounds = () => { entries.clear(); latest.clear(); };

/** Sticker content inside any wrapper (ephemeral, view once, edited, lottie/animated). */
export const stickerOf = (content) => {
    let c = normalizeMessageContent(content);
    for (let i = 0; i < 3 && c?.lottieStickerMessage?.message; i++) c = normalizeMessageContent(c.lottieStickerMessage.message);
    return c?.stickerMessage || null;
};

const seen = ({ message: m }) => {
    const audio = stickerOf(m?.raw?.message)?.audioMessage;
    if (audio) rememberSound(m.raw.key, audio);
    const quoted = stickerOf(m?.quoted?.message)?.audioMessage;
    if (quoted && m.quoted.key?.id && !entries.has(m.quoted.key.id)) rememberSound(m.quoted.key, quoted);
};

/**
 * Every upsert of every type (live, offline catch-up, history append), straight from
 * the socket: no plugin barrier, age limit or filter can make the cache miss one.
 */
const watched = new WeakSet();
export const recordUpsert = ({ messages } = {}) => {
    for (const raw of messages || []) {
        try {
            const audio = stickerOf(raw?.message)?.audioMessage;
            if (audio && raw.key?.id && !entries.has(raw.key.id)) rememberSound(raw.key, audio);
        } catch { /* never break the socket */ }
    }
};
const watch = ({ sock }) => {
    loadSounds();
    if (!sock?.ev || watched.has(sock)) return;
    watched.add(sock);
    sock.ev.on('messages.upsert', recordUpsert);
};

events.offTag(TAG);
events.on('message', seen, { tag: TAG });
events.on('message:self', seen, { tag: TAG });
events.on('connection:open', watch, { tag: TAG });
