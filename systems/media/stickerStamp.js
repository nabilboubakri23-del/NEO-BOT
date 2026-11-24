import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { generateWAMessageFromContent, prepareWAMessageMedia, proto } from 'baileys';
import docStore from '../database/docStore.js';
import { UserError } from '../../utils/errors.js';
import { defaultMeta, makeSticker } from './sticker.js';
import { isAnimatedWebp, isWebp } from './webpExif.js';

/**
 * Sticker stamps: a sticker placed ON a message (WhatsApp sticker annotation,
 * messageAssociation type STICKER_ANNOTATION = 11), not a separate sticker below it.
 *
 * Each user may save their own stamp sticker; everyone else uses the bot's.
 * The WebP bytes are stored (docStore, survives restarts and works on Render),
 * and the uploaded copy is reused for a few days, then uploaded again, so a stamp
 * never points at expired WhatsApp media (the problem with hardcoded media keys).
 *
 * Limits (anti-flood): one stamp per command, at most MAX_PER_MESSAGE stamps from
 * the bot on the same message, and undo only removes what the bot itself sent.
 */

const DOC = 'stickerStamps';
const MAX_WEBP_BYTES = 600 * 1024;
const MAX_USERS = 300;
const REUPLOAD_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
export const LIMITS = { user: 3, owner: 15 }; // stamps per command and per message
export const MAX_PER_MESSAGE = LIMITS.user;
const GAP_MS = 700; // pause between stamps of one command (rate limit)
const MAX_HISTORY = 2000;
const ANNOTATION = proto.MessageAssociation.AssociationType.STICKER_ANNOTATION;

const uploads = new Map(); // owner → { stickerMessage, at }
const history = []; // { id, chat, parentId, by, at } — the bot's stamps, newest last
let botWebp;

const open = () => docStore.open(DOC, () => ({ users: {} }));

const botSticker = async () => {
    if (!botWebp) {
        const dir = path.resolve('assets/thumbs');
        const file = (await readdir(dir)).find((f) => /\.jpe?g$/i.test(f));
        if (!file) throw new UserError('No default stamp available. Save one with .stamp set');
        botWebp = await makeSticker(await readFile(path.join(dir, file)), { kind: 'image' }, defaultMeta());
    }
    return botWebp;
};

/** The sender's saved stamp, or null when they use the bot's. */
export const savedStamp = async (owner) => {
    const doc = await open();
    const entry = doc.users[owner];
    return entry ? { webp: Buffer.from(entry.webp, 'base64'), animated: entry.animated, savedAt: entry.savedAt } : null;
};

export const saveStamp = async (owner, webp) => {
    if (!isWebp(webp)) throw new UserError('That sticker could not be read.');
    if (webp.length > MAX_WEBP_BYTES) throw new UserError(`That sticker is too heavy for a stamp (max ${Math.round(MAX_WEBP_BYTES / 1024)} KB).`);
    const doc = await open();
    if (!doc.users[owner] && Object.keys(doc.users).length >= MAX_USERS) throw new UserError('Too many saved stamps on this bot. Use the default one.');
    doc.users[owner] = { webp: webp.toString('base64'), animated: isAnimatedWebp(webp), savedAt: new Date().toISOString() };
    uploads.delete(owner);
    await docStore.saveNow(DOC);
};

export const resetStamp = async (owner) => {
    const doc = await open();
    const had = Boolean(doc.users[owner]);
    delete doc.users[owner];
    uploads.delete(owner);
    if (had) await docStore.saveNow(DOC);
    return had;
};

/** Uploaded stickerMessage for an owner (their stamp or the bot's), reused while fresh. */
const stickerMessageFor = async (sock, owner) => {
    const cached = uploads.get(owner);
    if (cached && Date.now() - cached.at < REUPLOAD_AFTER_MS) return cached.stickerMessage;
    const saved = await savedStamp(owner);
    const webp = saved?.webp || await botSticker();
    const media = await prepareWAMessageMedia({ sticker: webp, width: 512, height: 512 }, { upload: sock.waUploadToServer, mediaUploadTimeoutMs: 20_000 });
    if (!media?.stickerMessage) throw new Error('Sticker upload failed');
    media.stickerMessage.isAnimated = isAnimatedWebp(webp);
    uploads.set(owner, { stickerMessage: media.stickerMessage, at: Date.now() });
    if (uploads.size > MAX_USERS + 1) uploads.delete(uploads.keys().next().value);
    return media.stickerMessage;
};

export const stampsOn = (chat, parentId) => history.filter((h) => h.chat === chat && h.parentId === parentId);

/** The message content of one stamp (no network). */
export const buildStamp = (stickerMessage, parentKey, index = 0) => ({
    stickerMessage: { ...stickerMessage, stickerSentTs: Date.now() },
    messageContextInfo: { messageAssociation: { associationType: ANNOTATION, parentMessageKey: parentKey, messageIndex: index } }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Puts `count` of the owner's stamps on the message with key `parentKey`.
 * `limit` is the sender's cap (LIMITS.user or LIMITS.owner): per command and per message.
 * @returns {Promise<{ sent: number, capped: boolean }>}
 */
export const sendStamps = async (sock, chat, parentKey, owner, { count = 1, limit = LIMITS.user, gapMs = GAP_MS } = {}) => {
    if (!parentKey?.id) throw new UserError('Reply to the message you want to stamp.');
    const already = stampsOn(chat, parentKey.id).length;
    const room = Math.max(0, limit - already);
    if (!room) throw new UserError(`That message already has ${already} stamps from the bot (max ${limit}).`);
    const wanted = Math.max(1, Math.floor(count) || 1);
    const amount = Math.min(wanted, limit, room);
    const stickerMessage = await stickerMessageFor(sock, owner);
    let sent = 0;
    for (let k = 0; k < amount; k++) {
        if (k) await sleep(gapMs);
        const built = generateWAMessageFromContent(chat, buildStamp(stickerMessage, parentKey, already + k), { userJid: sock.user?.id });
        await sock.relayMessage(chat, built.message, { messageId: built.key.id });
        history.push({ id: built.key.id, chat, parentId: parentKey.id, by: owner, at: Date.now() });
        sent++;
    }
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    return { sent, capped: amount < wanted };
};

export const sendStamp = async (sock, chat, parentKey, owner) => {
    await sendStamps(sock, chat, parentKey, owner, { count: 1 });
    return history.at(-1).id;
};

/**
 * Deletes the bot's stamps placed by `owner` (all of them when `owner` is null, for admins),
 * on one message (parentId) or the newest `count` in the chat.
 */
export const undoStamps = async (sock, chat, { parentId = null, owner = null, count = 1 } = {}) => {
    const mine = history.filter((h) => h.chat === chat && (!parentId || h.parentId === parentId) && (!owner || h.by === owner));
    const targets = parentId ? mine : mine.slice(-Math.max(1, count));
    let removed = 0;
    for (const item of targets) {
        try {
            await sock.sendMessage(chat, { delete: { remoteJid: chat, id: item.id, fromMe: true } });
            history.splice(history.indexOf(item), 1);
            removed++;
        } catch { /* already gone or too old */ }
    }
    return { found: targets.length, removed };
};

export const _test = { history, uploads };
