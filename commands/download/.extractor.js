import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isPrivateIp, assertUrl, downloadFile, sendFile, MAX_MEDIA_BYTES } from './.lib.js';
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

export const extractorArgs = (url, platform, proxy, audio = false) => [
    '--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-cache-dir',
    '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings',
    '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0',
    '--js-runtimes', `node:${process.execPath}`, '--proxy', proxy,
    '--use-extractors', `${platform === 'youtube' ? 'youtube,youtube:tab' : platform},end`,
    '-f', audio ? 'bestaudio[ext=m4a]/bestaudio' : 'best[ext=mp4][height<=720]/best[ext=mp4]/best',
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
        proxy = await startExtractorProxy(EXTRACTOR_HOSTS[platform]);
        const result = await new Promise((resolve, reject) => {
            const proc = spawn(binaryPath, extractorArgs(input, platform, proxy.url, audio), {
                shell: false, detached: true, cwd: '/tmp', env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8' },
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
        if (!result.url || result._type === 'playlist' || result.is_live) throw new Error('Unsupported result');
        assertUrl(result.url, EXTRACTOR_HOSTS[platform]);
        return { url: result.url, title: String(result.title || '').slice(0, 160), ext: result.ext, audio };
    } catch {
        throw new UserError('Could not retrieve this public video. It may be unavailable or blocked by the platform.');
    } finally { await proxy?.close(); active = false; }
};

export const deliverExtracted = async (sock, message, result, platform, caption = '') => {
    const file = await downloadFile(result.url, { allowHosts: EXTRACTOR_HOSTS[platform], maxBytes: MAX_MEDIA_BYTES, expect: result.audio ? ['audio', 'video'] : ['video', 'image'] });
    await sendFile(sock, message, { kind: result.audio ? 'audio' : file.kind === 'image' ? 'image' : 'video', buffer: file.buffer,
        mimetype: result.audio ? (result.ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg') : undefined,
        fileName: result.audio ? `audio.${result.ext === 'm4a' ? 'm4a' : 'mp3'}` : undefined, caption });
};
