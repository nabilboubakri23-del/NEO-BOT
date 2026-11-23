import { Carousel, prepareWAMessageMedia } from 'baileys';
import { child } from '../../core/logger.js';
import { describeError } from '../../utils/errors.js';

const log = child('carousel');

/**
 * Swipeable card carousels (interactiveMessage.carouselMessage).
 *
 * Why this helper exists: Baileys only attaches the <biz> stanza node when the
 * interactiveMessage has a top-level nativeFlowMessage. A carousel keeps its
 * buttons inside each card, so a plain relayMessage() sent it WITHOUT that node
 * and WhatsApp dropped it silently (the bot reacted ✅ but nothing appeared).
 * We always relay carousels with the native_flow biz node ourselves.
 */

export const MAX_CARDS = 10;

export const BIZ_NODE = {
    tag: 'biz',
    attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
};

/** Native-flow button helpers (cards carry raw native-flow buttons). */
export const cardButton = {
    reply: (text, id) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) }),
    url: (text, url) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url, merchant_url: url }) }),
    copy: (text, code) => ({ name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: text, copy_code: code }) })
};

/** Uploads a media buffer once for use as a card header. kind: 'image' | 'video'. */
export const uploadHeader = async (sock, kind, buffer) => {
    const media = await prepareWAMessageMedia({ [kind]: buffer }, { upload: sock.waUploadToServer });
    const key = kind === 'video' ? 'videoMessage' : 'imageMessage';
    if (!media?.[key]) throw new Error(`${kind} upload failed`);
    return { hasMediaAttachment: true, [key]: media[key] };
};

/**
 * Builds the carousel message (no network). cards: [{ header, body, footer?, buttons }]
 * where header comes from uploadHeader() (plus optional title).
 */
export const buildCarousel = (sock, jid, { body, footer = '', cards }, { quoted } = {}) => {
    if (!cards.length) throw new Error('Carousel needs at least one card');
    const builder = new Carousel(sock)
        .setBody(body)
        .setFooter(footer)
        .addCard(cards.slice(0, MAX_CARDS).map((card) => ({
            header: { title: card.title || '', ...card.header },
            body: { text: card.body },
            ...(card.footer ? { footer: { text: card.footer } } : {}),
            nativeFlowMessage: { buttons: card.buttons }
        })));
    return builder.build(jid, quoted ? { quoted, userJid: sock.user?.id } : { userJid: sock.user?.id });
};

/** Sends a carousel with the biz node. Throws on failure so callers can fall back. */
export const sendCarousel = async (sock, jid, content, options = {}) => {
    const msg = buildCarousel(sock, jid, content, options);
    try {
        await sock.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id, additionalNodes: [BIZ_NODE] });
    } catch (error) {
        log.warn(`Carousel relay failed: ${describeError(error)}`);
        throw error;
    }
    return msg;
};
