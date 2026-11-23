import { cardButton, uploadHeader } from '../../systems/menus/carousel.js';
import { buildMp4, fetchImage, formatDuration, previewVariant, videoFormats } from './.pinterest-media.js';
import { withTimeout } from '../../utils/async.js';

/**
 * Turns ranked Pinterest results into carousel cards.
 *   Images: the picture itself as the card header.
 *   Edits / videos: a short playable preview (lowest clear quality) as the header,
 *   so the user can watch it before downloading; falls back to the thumbnail.
 * Every card is prepared in parallel under one deadline; a card that cannot be
 * prepared in time is dropped instead of holding the whole carousel.
 */

const IMAGE_DEADLINE = 20_000;
const VIDEO_DEADLINE = 45_000;
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));

export const displayTitle = (pin) => pin.title || pin.alt || pin.description.split('\n')[0] || 'Untitled pin';

export const cardText = (result, formats) => {
    const { pin, type, editScore } = result;
    const lines = [`${type === 'image' ? '🖼️' : type === 'edit' ? '🎬' : '🎥'} *${displayTitle(pin).slice(0, 90)}*`];
    const by = [pin.author && `👤 ${pin.author}`, pin.board && `📌 ${pin.board}`].filter(Boolean).join(' • ');
    if (by) lines.push(by.slice(0, 90));
    if (type === 'image') {
        lines.push([`❤️ ${compact(pin.reactions)}`, pin.width ? `📐 ${pin.width}×${pin.height}` : ''].filter(Boolean).join(' • '));
    } else {
        const best = formats?.variants?.at(-1)?.label;
        lines.push([pin.video.duration ? `⏱️ ${formatDuration(pin.video.duration)}` : '', best ? `🎞️ up to ${best}` : '', `❤️ ${compact(pin.reactions)}`].filter(Boolean).join(' • '));
        if (type === 'edit') lines.push(`✨ Edit match ${Math.round(editScore * 100)}%`);
    }
    if (result.offTopic) lines.push('⚠️ Loosely related');
    return lines.join('\n');
};

const buttonsFor = (result, token, index) => {
    const { pin, type } = result;
    const id = (action) => `pinterest:${action}:${token}:${index}`;
    if (type === 'image') {
        return [cardButton.reply('⬇️ Download HD', id('get')), cardButton.copy('🔗 Copy link', pin.url), cardButton.reply('🔍 Similar', id('sim'))];
    }
    return [cardButton.reply('⬇️ Download', id('get')), cardButton.reply('🎵 Audio MP3', id('mp3')), cardButton.copy('🔗 Copy link', pin.url)];
};

const imageHeader = async (sock, pin) => uploadHeader(sock, 'image', await fetchImage(pin, { full: false }));

const videoHeader = async (sock, result, session) => {
    const { pin } = result;
    try {
        const formats = session.formats[pin.id] || (session.formats[pin.id] = await videoFormats(pin));
        const preview = await buildMp4(previewVariant(formats.variants), formats.audio, { maxBytes: PREVIEW_MAX_BYTES });
        return await uploadHeader(sock, 'video', preview);
    } catch {
        return imageHeader(sock, pin); // thumbnail when the preview cannot be built
    }
};

/**
 * Prepares cards for session.items[from .. from+count).
 * Returns { cards, indexes } for the ones that made it before the deadline.
 */
export const prepareCards = async (sock, session, from, count) => {
    const slice = session.items.slice(from, from + count);
    const deadline = session.mode === 'image' ? IMAGE_DEADLINE : VIDEO_DEADLINE;
    const ready = await Promise.all(slice.map(async (result, i) => {
        const index = from + i;
        try {
            const header = await withTimeout(result.type === 'image' ? imageHeader(sock, result.pin) : videoHeader(sock, result, session), deadline, 'card timeout');
            return { index, card: { title: '', header, body: cardText(result, session.formats[result.pin.id]), buttons: buttonsFor(result, session.token, index) } };
        } catch {
            return null;
        }
    }));
    const ok = ready.filter(Boolean);
    return { cards: ok.map((r) => r.card), indexes: ok.map((r) => r.index) };
};
