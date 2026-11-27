import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { convert } from '../../systems/media/ffmpeg.js';
import { extractPost, fetchExtracted, EXTRACTOR_HOSTS } from './.extractor.js';
import { requireVerifiedExtractor } from './.verification.js';
import { downloadFile, sendFile, MAX_MEDIA_BYTES } from './.lib.js';

/**
 * Instagram / Facebook posts through yt-dlp: reels, videos, photo posts and carousels
 * (up to 10 items, sent in order), or the audio only as MP3.
 */

const LABEL = { instagram: 'INSTAGRAM', facebook: 'FACEBOOK' };
const MAX_POST_BYTES = 150 * 1024 * 1024;
const GAP_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = new Set();

/** Words that ask for audio only. */
export const AUDIO_WORDS = /^(mp3|audio|صوت|اغنية|أغنية)$/i;

/** Caption for the first item: who posted, a short caption, how many items. */
export const postCaption = (platform, post, sent = post.items.length) => box(LABEL[platform], [
    post.uploader && `👤 ${post.uploader}`,
    post.caption && `📝 ${post.caption.length > 160 ? `${post.caption.slice(0, 157)}…` : post.caption}`,
    post.items.length > 1 && `🖼️ ${sent} items${post.total > post.items.length ? ` (first ${post.items.length} of ${post.total})` : ''}`,
    '✅ Done.'
].filter(Boolean));

const toMp3 = (buffer) => convert(buffer, { inExt: 'mp4', outExt: 'mp3', args: (i, o) => ['-i', i, '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', o], timeoutMs: 120_000 });

export const downloadPost = async (sock, message, url, platform, { audio = false } = {}) => {
    const user = message.sender || message.chat;
    if (busy.has(user)) throw new UserError('⏳ Your previous download is still running.');
    busy.add(user);
    try {
        await requireVerifiedExtractor(platform);
        await message.react?.('⏳');
        const post = await extractPost(url, platform, { audio });
        if (audio) {
            const video = post.items.find((i) => i.type === 'video');
            const file = await fetchExtracted({ ...video, audio: false }, platform);
            const mp3 = await toMp3(file.buffer);
            await sendFile(sock, message, { kind: 'audio', buffer: mp3, mimetype: 'audio/mpeg', fileName: `${(post.uploader || platform).replace(/[^\w.-]+/g, '_')}.mp3` });
            await message.react?.('✅');
            return;
        }
        let total = 0; let sent = 0;
        for (const item of post.items) {
            const caption = sent === 0 ? postCaption(platform, post) : '';
            let file;
            if (item.type === 'image') {
                const img = await downloadFile(item.url, { allowHosts: EXTRACTOR_HOSTS[platform], maxBytes: 15 * 1024 * 1024, expect: ['image'] });
                file = { buffer: img.buffer, kind: 'image' };
            } else {
                file = await fetchExtracted(item, platform);
            }
            total += file.buffer.length;
            if (total > MAX_POST_BYTES) break;
            await sendFile(sock, message, { kind: file.kind, buffer: file.buffer, caption });
            sent++;
            if (sent < post.items.length) await sleep(GAP_MS);
        }
        if (!sent) throw new UserError('⚠️ The post was too large to send.');
        await message.react?.('✅');
    } catch (error) {
        await message.react?.('❌');
        throw error;
    } finally {
        busy.delete(user);
    }
};

/** ".ig mp3 <link>" / ".ig <link>" → { audio, link }. */
export const parseArgs = (args) => {
    const words = [...args];
    const audio = AUDIO_WORDS.test(words[0] || '') || AUDIO_WORDS.test(words[words.length - 1] || '');
    const link = words.find((w) => /^https?:\/\//i.test(w)) || '';
    return { audio, link };
};
