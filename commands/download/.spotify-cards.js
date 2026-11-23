import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Carousel, prepareWAMessageMedia } from 'baileys';
import { downloadFile } from './.lib.js';
import { withTimeout } from './.spotify-core.js';

/**
 * Spotify result cards: a swipeable carousel, one card per track with its cover.
 * Covers are fetched and uploaded in parallel under one deadline; a missing or
 * slow cover is replaced by a local picture so the carousel never waits forever.
 */

const COVER_DEADLINE_MS = 12_000;
const THUMBS = path.resolve('assets/thumbs');
let fallbackCover;

const localCover = async () => {
    if (fallbackCover !== undefined) return fallbackCover;
    try {
        const file = (await readdir(THUMBS)).find((f) => /\.jpe?g$/i.test(f));
        fallbackCover = file ? await readFile(path.join(THUMBS, file)) : null;
    } catch { fallbackCover = null; }
    return fallbackCover;
};

export const cardText = (t) => [
    `🎵 ${t.title}`,
    `👤 ${t.artist || 'Unknown artist'}`,
    t.album ? `💿 ${t.album}` : null,
    t.duration ? `⏱️ ${t.duration}` : null
].filter(Boolean).join('\n');

export const spotifyCarousel = (sock, session, images) => new Carousel(sock)
    .setBody(`*Spotify results* (${session.tracks.length})\nSwipe the cards and tap *Download* on the right song.\nResults expire in 5 minutes.`)
    .setFooter('NEO BOT • Spotify')
    .addCard(session.tracks.map((t, i) => ({
        header: { title: t.title, hasMediaAttachment: true, imageMessage: images[i] },
        body: { text: cardText(t) },
        nativeFlowMessage: {
            buttons: [
                { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '⬇️ Download', id: `spotify:pick:${session.token}:${i}` }) },
                { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📄 As file', id: `spotify:file:${session.token}:${i}` }) },
                { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '✖️ Cancel', id: `spotify:cancel:${session.token}` }) }
            ]
        }
    })));

const coverFor = async (track) => {
    if (track.cover) {
        try {
            const file = await downloadFile(track.cover, { allowHosts: ['i.scdn.co'], maxBytes: 1024 * 1024, expect: ['image'] });
            return file.buffer;
        } catch { /* use the local picture */ }
    }
    return localCover();
};

const uploadAll = async (sock, tracks) => Promise.all(tracks.map(async (track) => {
    const buffer = await coverFor(track);
    if (!buffer) throw new Error('No cover available');
    const media = await prepareWAMessageMedia({ image: buffer }, { upload: sock.waUploadToServer });
    if (!media?.imageMessage) throw new Error('Cover upload failed');
    return media.imageMessage;
}));

export const sendSpotifyCarousel = async (sock, message, session) => {
    const images = await withTimeout(uploadAll(sock, session.tracks), COVER_DEADLINE_MS, 'Cover upload timed out');
    if (session.cancelled) throw new Error('Session cancelled');
    const msg = spotifyCarousel(sock, session, images).build(message.chat, { quoted: message.raw, userJid: sock.user?.id });
    // Relay directly (same reason as the menu helper: avoid a duplicate <biz> node).
    await sock.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
    return msg;
};
