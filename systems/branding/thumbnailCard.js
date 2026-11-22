import fs from 'node:fs';
import path from 'node:path';
import config from '../../config/config.js';

/**
 * Small preview card (externalAdReply) shown above bot messages:
 * a random picture + the bot name + a random line.
 *
 * Pictures: every .jpg/.jpeg/.png in assets/thumbs/ (keep them small, ~300x300, < 50 KB),
 * plus optional THUMB_URLS (comma separated https links) downloaded once at startup.
 * Lines: THUMB_LINES (separated by "|") or the defaults below.
 */

const THUMB_DIR = path.join(config.rootDir, 'assets', 'thumbs');
const MAX_BYTES = 200 * 1024;

const DEFAULT_LINES = [
    'Silence speaks louder.',
    'Stay quiet, move smart.',
    'Not everyone will understand.',
    'Built different.',
    'Lost in thought.',
    'Calm mind, strong soul.',
    'Some nights hit different.',
    'Fast. Simple. Reliable.'
];

const lines = (process.env.THUMB_LINES || '')
    .split('|')
    .map((l) => l.trim())
    .filter(Boolean);

const thumbs = [];

const loadLocal = () => {
    try {
        for (const file of fs.readdirSync(THUMB_DIR)) {
            if (!/\.(jpe?g|png)$/i.test(file)) continue;
            const buf = fs.readFileSync(path.join(THUMB_DIR, file));
            if (buf.length && buf.length <= MAX_BYTES) thumbs.push(buf);
        }
    } catch {
        /* no thumbs folder → card disabled until URLs load */
    }
};

const loadRemote = async () => {
    const urls = (process.env.THUMB_URLS || '')
        .split(',')
        .map((u) => u.trim())
        .filter((u) => u.startsWith('https://'));
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length && buf.length <= MAX_BYTES) thumbs.push(buf);
        } catch {
            /* skip broken link */
        }
    }
};

loadLocal();
export const ready = loadRemote();

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export const thumbCount = () => thumbs.length;

/** A random picture buffer, or null. */
export const randomThumb = () => (thumbs.length ? pick(thumbs) : null);

/** Returns an externalAdReply object, or null when there is no picture. */
export const randomCard = () => {
    if (!thumbs.length) return null;
    return {
        title: config.channel.name,
        body: pick(lines.length ? lines : DEFAULT_LINES),
        mediaType: 1,
        thumbnail: pick(thumbs),
        sourceUrl: process.env.CHANNEL_URL || config.bot.website,
        renderLargerThumbnail: false,
        showAdAttribution: false
    };
};
