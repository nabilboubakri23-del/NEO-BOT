import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '../../utils/errors.js';
import { runFfmpeg } from '../../systems/media/ffmpeg.js';
import { downloadFile, fetchText, MAX_MEDIA_BYTES } from './.lib.js';

/**
 * Pinterest media: images and HLS videos.
 *
 * Pinterest serves videos only as HLS with separate video and audio tracks
 * (CMAF byte-range files). We read the playlists ourselves, download only the
 * files they name from *.pinimg.com (SSRF-guarded), and let ffmpeg mux them
 * from local files with stream copy (no re-encode, ~20 ms). ffmpeg never
 * touches the network.
 */

const MEDIA_HOSTS = ['pinimg.com'];
const MAX_FILES = 400;

const resolveUri = (uri, base) => {
    const url = new URL(uri, base);
    if (url.protocol !== 'https:' || !/(^|\.)pinimg\.com$/i.test(url.hostname)) throw new UserError('Pinterest gave an unexpected video address.');
    return url.href;
};

const attr = (line, name) => line.match(new RegExp(`${name}=("([^"]*)"|[^,]*)`))?.[2] ?? line.match(new RegExp(`${name}=([^,]*)`))?.[1];

/** Master playlist → { variants: [{ width, height, bandwidth, uri, label }], audio } (sorted by height). */
export const parseMaster = (text, baseUrl) => {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
    let audio = null;
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line) && !audio) {
            const uri = attr(line, 'URI');
            if (uri) audio = resolveUri(uri, baseUrl);
        } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
            if (!uri) continue;
            const [width, height] = String(attr(line, 'RESOLUTION') || '0x0').split('x').map(Number);
            variants.push({ width, height, bandwidth: Number(attr(line, 'BANDWIDTH')) || 0, uri: resolveUri(uri, baseUrl) });
        }
    }
    // Same resolution listed twice → keep the higher bitrate.
    const byHeight = new Map();
    for (const v of variants) if (!byHeight.has(v.height) || byHeight.get(v.height).bandwidth < v.bandwidth) byHeight.set(v.height, v);
    const list = [...byHeight.values()].sort((a, b) => a.height - b.height)
        .map((v) => ({ ...v, label: `${Math.min(v.width, v.height) || v.height}p` }));
    return { variants: list, audio };
};

/** Media playlist → ordered unique file URLs (init map + segments, or single byte-range file). */
export const parseMedia = (text, baseUrl) => {
    const files = [];
    for (const line of String(text || '').split(/\r?\n/).map((l) => l.trim())) {
        let uri = null;
        if (line.startsWith('#EXT-X-MAP:')) uri = attr(line, 'URI');
        else if (line && !line.startsWith('#')) uri = line;
        if (!uri) continue;
        const abs = resolveUri(uri, baseUrl);
        if (!files.includes(abs)) files.push(abs);
        if (files.length > MAX_FILES) throw new UserError('This video is too long to download.');
    }
    if (!files.length) throw new UserError('This Pinterest video has no playable stream.');
    return files;
};

const playlist = (url) => fetchText(url, { allowHosts: MEDIA_HOSTS, timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });

/** Video formats of a pin: [{ label, width, height, bandwidth, uri, estBytes }], audio. */
export const videoFormats = async (pin) => {
    const master = parseMaster(await playlist(pin.video.hls), pin.video.hls);
    if (!master.variants.length) throw new UserError('This Pinterest video has no playable stream.');
    const duration = pin.video.duration || 30;
    return {
        audio: master.audio,
        variants: master.variants.map((v) => ({ ...v, estBytes: Math.round(((v.bandwidth || 800_000) * duration) / 8) }))
    };
};

/** Downloads every file of a media playlist and joins them in order. */
const fetchTrack = async (mediaPlaylistUrl, budget) => {
    const files = parseMedia(await playlist(mediaPlaylistUrl), mediaPlaylistUrl);
    const parts = [];
    let total = 0;
    for (const file of files) {
        const got = await downloadFile(file, { allowHosts: MEDIA_HOSTS, maxBytes: budget - total });
        total += got.buffer.length;
        if (total > budget) throw new UserError('This video is too large to send on WhatsApp.');
        parts.push(got.buffer);
    }
    return Buffer.concat(parts);
};

const withTemp = async (fn) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-pin-'));
    try { return await fn(dir); } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

/**
 * Builds an MP4 (video + audio) for one variant.
 * variant: an entry of videoFormats().variants; audio: the audio playlist URL or null.
 */
export const buildMp4 = async (variant, audio, { maxBytes = MAX_MEDIA_BYTES } = {}) => {
    const [video, sound] = await Promise.all([
        fetchTrack(variant.uri, maxBytes),
        audio ? fetchTrack(audio, 16 * 1024 * 1024).catch(() => null) : null
    ]);
    return withTemp(async (dir) => {
        const id = crypto.randomBytes(5).toString('hex');
        const v = path.join(dir, `${id}.v.mp4`);
        const a = path.join(dir, `${id}.a.mp4`);
        const out = path.join(dir, `${id}.mp4`);
        await writeFile(v, video);
        const args = ['-i', v];
        if (sound) { await writeFile(a, sound); args.push('-i', a, '-map', '0:v:0', '-map', '1:a:0'); }
        args.push('-c', 'copy', '-movflags', '+faststart', out);
        await runFfmpeg(args, { timeoutMs: 60_000 });
        const buffer = await readFile(out);
        if (buffer.length > maxBytes) throw new UserError('This video is too large to send on WhatsApp.');
        return buffer;
    });
};

/** MP3 of the audio track only. */
export const buildMp3 = async (audio) => {
    if (!audio) throw new UserError('This video has no sound.');
    const sound = await fetchTrack(audio, 24 * 1024 * 1024);
    return withTemp(async (dir) => {
        const a = path.join(dir, 'a.mp4');
        const out = path.join(dir, 'a.mp3');
        await writeFile(a, sound);
        await runFfmpeg(['-i', a, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', out], { timeoutMs: 60_000 });
        return readFile(out);
    });
};

/** Smallest variant at least `minHeight` tall (the preview shown inside a card). */
export const previewVariant = (variants, minHeight = 300) =>
    variants.find((v) => Math.min(v.width, v.height) >= minHeight) || variants[variants.length - 1];

/** Image bytes: the original, falling back to the 736px copy. */
export const fetchImage = async (pin, { full = true } = {}) => {
    const urls = full ? [pin.image.full, pin.image.preview] : [pin.image.preview, pin.image.full];
    let lastError;
    for (const url of [...new Set(urls.filter(Boolean))]) {
        try {
            return (await downloadFile(url, { allowHosts: MEDIA_HOSTS, maxBytes: full ? 20 * 1024 * 1024 : 4 * 1024 * 1024, expect: ['image'] })).buffer;
        } catch (error) { lastError = error; }
    }
    throw lastError?.expose ? lastError : new UserError('Could not download this image. Try another one.');
};

export const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const formatDuration = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
