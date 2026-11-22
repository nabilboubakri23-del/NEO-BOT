import { Button } from 'baileys';
import { child } from '../../core/logger.js';
import { describeError } from '../../utils/errors.js';
import { randomThumb } from '../branding/thumbnailCard.js';
import { getSetting } from '../settings/settingsStore.js';

const log = child('menus');

/**
 * Interactive Menu System.
 * Builds REAL WhatsApp native-flow interactive messages using the
 * MessageBuilder (Button) shipped with raoltech/baileys v1.1.0.
 * If WhatsApp rejects a message, a plain-text fallback is sent instead.
 */

const sendOptions = (sock, quoted) => (quoted ? { quoted, userJid: sock.user?.id } : {});

/**
 * Builds the message with the Button builder, then relays it ourselves.
 * Button.send() attaches its own <biz> node while relayMessage() of this
 * library already appends the correct <biz> node for native-flow messages,
 * so the stanza ended up with two <biz> nodes and WhatsApp dropped it silently.
 */
const cardEnabled = () => {
    try {
        return getSetting('thumbnailCard');
    } catch {
        return true;
    }
};

const relayBuilt = async (sock, builder, jid, quoted) => {
    // WhatsApp does not draw preview cards on button messages, so the picture goes in the header.
    const thumb = !builder._data && sock.waUploadToServer && cardEnabled() ? randomThumb() : null;
    let msg;
    if (thumb) {
        try {
            builder.setImage(thumb);
            msg = await builder.build(jid, sendOptions(sock, quoted));
        } catch (error) {
            log.warn(`Menu picture failed, sending without it: ${describeError(error)}`);
            builder._data = null;
        }
    }
    msg = msg || (await builder.build(jid, sendOptions(sock, quoted)));
    await sock.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
    return msg;
};

/**
 * Sends a single_select list (e.g. the ORDERS menu).
 * @param {object} sock
 * @param {string} jid
 * @param {{ title: string, body: string, footer?: string, buttonText: string,
 *           sections: { title: string, rows: { id: string, title: string, description?: string }[] }[] }} menu
 * @param {{ quoted?: object, fallbackText?: string }} [options]
 */
export const sendListMenu = async (sock, jid, menu, { quoted, fallbackText } = {}) => {
    try {
        const builder = new Button(sock)
            .setTitle(menu.title)
            .setBody(menu.body)
            .setFooter(menu.footer || '')
            .addSelection(menu.buttonText);

        for (const section of menu.sections) {
            builder.makeSection(section.title);
            for (const row of section.rows) {
                builder.makeRow('', row.title, row.description || '', row.id);
            }
        }
        return await relayBuilt(sock, builder, jid, quoted);
    } catch (error) {
        log.error(`Interactive list failed, sending text fallback: ${describeError(error)}`);
        return sock.sendMessage(jid, { text: fallbackText || listFallback(menu) }, quoted ? { quoted } : {});
    }
};

/**
 * Sends native-flow buttons. Supported button types:
 *   { type: 'reply', text, id }     → quick_reply
 *   { type: 'url',   text, url }    → cta_url
 *   { type: 'copy',  text, code }   → cta_copy
 */
export const sendButtons = async (sock, jid, message, { quoted, fallbackText } = {}) => {
    try {
        const builder = new Button(sock)
            .setTitle(message.title || '')
            .setBody(message.body)
            .setFooter(message.footer || '');

        for (const button of message.buttons) {
            if (button.type === 'reply') builder.addReply(button.text, button.id);
            else if (button.type === 'url') builder.addUrl(button.text, button.url);
            else if (button.type === 'copy') builder.addCopy(button.text, button.code);
            else throw new Error(`Unsupported button type: ${button.type}`);
        }
        return await relayBuilt(sock, builder, jid, quoted);
    } catch (error) {
        log.error(`Interactive buttons failed, sending text fallback: ${describeError(error)}`);
        return sock.sendMessage(jid, { text: fallbackText || buttonsFallback(message) }, quoted ? { quoted } : {});
    }
};

export const listFallback = (menu) =>
    [
        `*${menu.title}*`,
        menu.body,
        '',
        ...menu.sections.flatMap((section) => [
            `*${section.title}*`,
            ...section.rows.map((row) => `• ${row.title} → ${row.id}`),
            ''
        ]),
        menu.footer || ''
    ].join('\n');

export const buttonsFallback = (message) =>
    [
        message.title ? `*${message.title}*` : '',
        message.body,
        '',
        ...message.buttons.map((b) =>
            b.type === 'url' ? `• ${b.text}: ${b.url}` : b.type === 'copy' ? `• ${b.text}: ${b.code}` : `• ${b.text}`
        ),
        message.footer || ''
    ].join('\n');
