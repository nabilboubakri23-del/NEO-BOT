import { downloadMediaMessage, normalizeMessageContent } from 'baileys';
import { MAX_WRITE_BYTES } from './workspace.js';

/**
 * Reads the code a remote edit should apply, from (in order):
 *   1. the lines after the command line in the same message,
 *   2. a .js / text document attached to the message,
 *   3. the message the command replies to (its text or its document).
 * Markdown code fences (```js ... ```) are stripped.
 */

const stripFences = (text) => {
    const trimmed = text.replace(/^\s*\n/, '').replace(/\s+$/, '');
    const fenced = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
    return (fenced ? fenced[1] : trimmed) + '\n';
};

const textOf = (content) =>
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.documentMessage?.caption ||
    '';

const downloadDocument = async (sock, key, content) => {
    const doc = content?.documentMessage || content?.documentWithCaptionMessage?.message?.documentMessage;
    if (!doc) return null;
    if (Number(doc.fileLength || 0) > MAX_WRITE_BYTES) throw new Error('Attached file is too large.');
    const buffer = await downloadMediaMessage({ key, message: { documentMessage: doc } }, 'buffer', {}, {
        reuploadRequest: sock.updateMediaMessage
    });
    return buffer.toString('utf8');
};

/** Returns { code, source } or null when the message carries no code. */
export const readCode = async (sock, message) => {
    const inline = message.text.split('\n').slice(1).join('\n');
    if (inline.trim()) return { code: stripFences(inline), source: 'message' };

    const content = normalizeMessageContent(message.raw.message);
    const attached = await downloadDocument(sock, message.raw.key, content);
    if (attached?.trim()) return { code: stripFences(attached), source: 'attached file' };

    const context = content?.extendedTextMessage?.contextInfo || content?.documentMessage?.contextInfo;
    const quoted = normalizeMessageContent(context?.quotedMessage);
    if (quoted) {
        const key = { remoteJid: message.chat, id: context.stanzaId, participant: context.participant, fromMe: false };
        const quotedDoc = await downloadDocument(sock, key, quoted);
        if (quotedDoc?.trim()) return { code: stripFences(quotedDoc), source: 'replied file' };
        const quotedText = textOf(quoted);
        if (quotedText.trim()) return { code: stripFences(quotedText), source: 'replied message' };
    }
    return null;
};
