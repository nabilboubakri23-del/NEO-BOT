import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isPrivateIp, assertUrl, downloadFile, sendFile, sniffKind, formatSize, MAX_MEDIA_BYTES } from './.lib.js';
import { runFfmpeg } from '../../systems/media/ffmpeg.js';
import { UserError } from '../../utils/errors.js';

export const EXTRACTOR_HOSTS = {
    youtube: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'google.com', 'googleapis.com'],
    instagram: ['instagram.com', 'cdninstagram.com', 'fbcdn.net'],
    facebook: ['facebook.com', 'fb.com', 'fb.watch', 'fbcdn.net']
};
const INPUT_HOSTS = { youtube: ['youtube.com', 'youtu.be'], instagram: ['instagram.com'], facebook: ['facebook.com', 'fb.com', 'fb.watch'] };
export const allowedHost = (host, hosts) => hosts.some(h => host === h || host.endsWith(`.${h}`));
export const binaryPath = path.resolve('storage/cache/download-tools/yt-dlp');
let active = false;

const executable = (file) => access(file, constants.X_OK).then(() => true, () => false);

/**
 * yt-dlp location: YTDLP_PATH, then the pinned build (Render, Linux x64),
 * then a yt-dlp on PATH (Termux: `pip install yt-dlp`). Absolute paths only.
 */
export const resolveYtDlp = async () => {
    const custom = (process.env.YTDLP_PATH || '').trim();
    if (custom && path.isAbsolute(custom) && await executable(custom)) return custom;
    if (await executable(binaryPath)) return binaryPath;
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir || !path.isAbsolute(dir)) continue;
        const candidate = path.join(dir, 'yt-dlp');
        if (await executable(candidate)) return candidate;
    }
    return null;
};
export const hasYtDlp = async () => Boolean(await resolveYtDlp());

/** Loopback-only CONNECT proxy. Validate DNS and connect to the checked IP, not the hostname. */
export const startExtractorProxy = async (hosts) => {
    const sockets = new Set();
    const server = http.createServer((req, res) => { res.writeHead(403); res.end(); });
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.setTimeout(30000, () => s.destroy()); });
    server.on('connect', async (req, client, head) => {
        let upstream;
        const deny = () => { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); upstream?.destroy(); };
        try {
            const match = /^([a-z0-9.-]+):443$/i.exec(req.url || '');
            if (!match || net.isIP(match[1]) || !allowedHost(match[1].toLowerCase(), hosts)) return deny();
            const addresses = await dns.lookup(match[1], { all: true, verbatim: true });
            if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) return deny();
            const checked = addresses[0];
            if (client.destroyed) return;
            upstream = net.connect({ host: checked.address, family: checked.family, port: 443 });
            sockets.add(upstream);
            upstream.on('close', () => sockets.delete(upstream));
            upstream.setTimeout(30000, () => upstream.destroy());
            upstream.on('error', () => client.destroy());
            client.on('error', () => upstream.destroy());
            client.on('close', () => upstream.destroy());
            upstream.on('connect', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                upstream.pipe(client); client.pipe(upstream);
            });
        } catch { deny(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => { for (const s of sockets) s.destroy(); return new Promise(resolve => server.close(resolve)); }
    };
};

// YouTube serves no combined mp4 above 360p (often none at all): pick H.264 video + m4a audio
// and mux them; smaller fallbacks keep the result under the WhatsApp media cap.
export const formatFor = (platform, audio) => {
    if (audio) return 'ba[ext=m4a]/ba[acodec^=mp4a]/ba/b[ext=mp4]';
    if (platform === 'youtube') return [
        'bv*[ext=mp4][vcodec^=avc1][height<=720][filesize<?45M]+ba[ext=m4a]',
        'bv*[ext=mp4][vcodec^=avc1][height<=480]+ba[ext=m4a]',
        'bv*[ext=mp4][vcodec^=avc1][height<=360]+ba[ext=m4a]',
        'b[ext=mp4][height<=720]', 'b[ext=mp4]', 'b'
    ].join('/');
    return 'best[ext=mp4][height<=720]/best[ext=mp4]/best';
};

export const extractorArgs = (url, platform, proxy, audio = false) => [
    '--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-cache-dir',
    '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings',
    '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0',
    '--js-runtimes', `node:${process.execPath}`, '--proxy', proxy,
    '--use-extractors', `${platform === 'youtube' ? 'youtube,youtube:tab' : platform},end`,
    '-f', formatFor(platform, audio),
    '--', url
];

/** Bounded metadata-only extraction. No inherited credentials or configuration. */
export const extractMedia = async (url, platform, { audio = false } = {}) => {
    if (!INPUT_HOSTS[platform]) throw new UserError('Unsupported download platform.');
    const input = assertUrl(url, INPUT_HOSTS[platform]);
    if (active) throw new UserError('Another download is being prepared. Try again shortly.');
    active = true;
    let proxy;
    try {
        const bin = await resolveYtDlp();
        if (!bin) throw new Error('yt-dlp missing');
        proxy = await startExtractorProxy(EXTRACTOR_HOSTS[platform]);
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(bin, extractorArgs(input, platform, proxy.url, audio), {
                shell: false, detached: true, cwd: os.tmpdir(), env: { PATH: [path.dirname(bin), path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: '/nonexistent', LANG: 'C.UTF-8' },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let output = ''; let stderrBytes = 0; let failed = false;
            const stop = (error) => { if (failed) return; failed = true; try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } reject(error); };
            const timer = setTimeout(() => stop(new Error('Extraction timed out')), 65000);
            proc.stdout.on('data', data => { output += data; if (Buffer.byteLength(output) > 4 * 1024 * 1024) stop(new Error('Metadata too large')); });
            proc.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 128 * 1024) stop(new Error('Diagnostic output too large')); });
            proc.on('error', error => { clearTimeout(timer); reject(error); });
            proc.on('close', code => {
                clearTimeout(timer);
                try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* no descendants */ }
                if (failed) return;
                if (code !== 0) return reject(new Error('Extraction failed'));
                try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid metadata')); }
            });
        });
        return toExtracted(result, platform, audio);
    } catch (error) {
        if (error?.expose) throw error;
        throw new UserError('Could not retrieve this public video. It may be unavailable or blocked by the platform.');
    } finally { await proxy?.close(); active = false; }
};

/** yt-dlp JSON → { url, parts[], title, ext, audio, duration }. Every media URL is host-checked. */
export const toExtracted = (result, platform, audio = false) => {
    if (!result || result._type === 'playlist' || result.is_live) throw new Error('Unsupported result');
    const formats = Array.isArray(result.requested_formats) && result.requested_formats.length ? result.requested_formats : [result];
    const parts = formats.map(f => {
        if (!f?.url) throw new Error('Missing media url');
        assertUrl(f.url, EXTRACTOR_HOSTS[platform]);
        return { url: f.url, ext: String(f.ext || ''), size: Number(f.filesize || f.filesize_approx || 0), video: f.vcodec && f.vcodec !== 'none', audio: f.acodec && f.acodec !== 'none' };
    });
    if (parts.length > 2) throw new Error('Unexpected formats');
    const total = parts.reduce((sum, p) => sum + p.size, 0);
    if (total > MAX_MEDIA_BYTES) throw new UserError(`⚠️ Too large (${formatSize(total)}). Maximum is ${formatSize(MAX_MEDIA_BYTES)}; try a shorter video.`);
    return { url: parts[0].url, parts, title: String(result.title || '').slice(0, 160), ext: String(result.ext || parts[0].ext), audio, duration: Number(result.duration || 0) };
};

const CHUNK = 10 * 1024 * 1024;

/**
 * googlevideo throttles one long request to a crawl; ranged 10 MB requests
 * (what yt-dlp itself does) arrive at full speed. Other hosts: one request.
 */
export const fetchPart = async (part, platform, expect = []) => {
    const hosts = EXTRACTOR_HOSTS[platform];
    if (!/(^|\.)googlevideo\.com$/i.test(new URL(part.url).hostname)) return downloadFile(part.url, { allowHosts: hosts, maxBytes: MAX_MEDIA_BYTES, expect });
    const chunks = [];
    let total = 0;
    for (let start = 0; ; start += CHUNK) {
        const sep = part.url.includes('?') ? '&' : '?';
        const file = await downloadFile(`${part.url}${sep}range=${start}-${start + CHUNK - 1}`, { allowHosts: hosts, maxBytes: CHUNK + 1024, expect: start === 0 ? expect : [] });
        chunks.push(file.buffer);
        total += file.size;
        if (total > MAX_MEDIA_BYTES) throw new UserError(`⚠️ Too large. Maximum is ${formatSize(MAX_MEDIA_BYTES)}; try a shorter video.`);
        if (file.size < CHUNK || (part.size && total >= part.size)) break;
    }
    const buffer = Buffer.concat(chunks);
    return { buffer, size: buffer.length, kind: sniffKind(buffer) };
};

/** Mux one video-only and one audio-only track into an mp4 without re-encoding. */
export const muxParts = async (video, audio) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neo-mux-'));
    try {
        const v = path.join(dir, 'v.mp4'); const a = path.join(dir, 'a.m4a'); const out = path.join(dir, 'out.mp4');
        await writeFile(v, video); await writeFile(a, audio);
        await runFfmpeg(['-i', v, '-i', a, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', out], { timeoutMs: 120_000 });
        return await readFile(out);
    } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

/** Download (and mux when split) an extracted result → { buffer, kind, mimetype, fileName }. */
export const fetchExtracted = async (result, platform) => {
    if (result.audio) {
        const file = await fetchPart(result.parts[0], platform, ['audio', 'video']);
        const m4a = result.parts[0].ext === 'm4a' || result.ext === 'm4a';
        return { buffer: file.buffer, kind: 'audio', mimetype: m4a ? 'audio/mp4' : 'audio/mpeg', fileName: `${safeName(result.title)}.${m4a ? 'm4a' : 'mp3'}` };
    }
    if (result.parts.length === 2) {
        const videoPart = result.parts.find(p => p.video) || result.parts[0];
        const audioPart = result.parts.find(p => p !== videoPart);
        const [v, a] = await Promise.all([fetchPart(videoPart, platform, ['video']), fetchPart(audioPart, platform, ['video', 'audio'])]);
        const buffer = await muxParts(v.buffer, a.buffer);
        if (buffer.length > MAX_MEDIA_BYTES) throw new UserError(`⚠️ Too large. Maximum is ${formatSize(MAX_MEDIA_BYTES)}; try a shorter video.`);
        return { buffer, kind: 'video' };
    }
    const file = await fetchPart(result.parts[0], platform, ['video', 'image']);
    return { buffer: file.buffer, kind: file.kind === 'image' ? 'image' : 'video' };
};

const safeName = (title) => (String(title || 'audio').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 80) || 'audio');

export const deliverExtracted = async (sock, message, result, platform, caption = '') => {
    const file = await fetchExtracted(result, platform);
    await sendFile(sock, message, { kind: file.kind, buffer: file.buffer, mimetype: file.mimetype, fileName: file.fileName, caption: file.kind === 'audio' ? '' : caption });
};
