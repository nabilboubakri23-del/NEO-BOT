import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

/**
 * Finds a working ffmpeg, in this order:
 *   1. FFMPEG_PATH (owner override)
 *   2. `ffmpeg` on PATH (Termux: pkg install ffmpeg)
 *   3. the bundled static build in storage/cache/download-tools/ffmpeg
 *      (installed at Render build time, or downloaded once at runtime)
 * The bundled build is a pinned release whose SHA-256 is checked before it is
 * ever executed (same policy as the yt-dlp installer).
 */

export const BUNDLED_PATH = path.resolve('storage/cache/download-tools/ffmpeg');
const RELEASE = 'b6.0';
const BUILDS = {
    'linux-x64': { file: 'ffmpeg-linux-x64.gz', sha256: '17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f' },
    'linux-arm64': { file: 'ffmpeg-linux-arm64.gz', sha256: '2b708b2d15041d2a192c1db24c7a8a1d24f645a8242dce1c744ff2392b86ada1' }
};
const MAX_DOWNLOAD = 60 * 1024 * 1024;

/** True when `bin -version` exits 0 within 10 s. */
export const works = (bin) => new Promise((resolve) => {
    let proc;
    try { proc = spawn(bin, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 10_000);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
});

export const bundledBuild = () => BUILDS[`${process.platform}-${process.arch}`] || null;

/** Downloads and verifies the pinned static ffmpeg. Returns its path. */
export const installBundled = async ({ fetchImpl = fetch } = {}) => {
    const build = bundledBuild();
    if (!build) throw new Error(`No bundled ffmpeg for ${process.platform}-${process.arch}.`);
    const res = await fetchImpl(`https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/${build.file}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`ffmpeg download failed: ${res.status}`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD) throw new Error('ffmpeg download too large.');
        chunks.push(Buffer.from(chunk));
    }
    const gz = Buffer.concat(chunks);
    if (createHash('sha256').update(gz).digest('hex') !== build.sha256) throw new Error('ffmpeg checksum mismatch.');
    await mkdir(path.dirname(BUNDLED_PATH), { recursive: true });
    const tmp = `${BUNDLED_PATH}.tmp`;
    await writeFile(tmp, gunzipSync(gz), { mode: 0o700 });
    await rename(tmp, BUNDLED_PATH);
    await chmod(BUNDLED_PATH, 0o700);
    return BUNDLED_PATH;
};

let resolving = null;

/**
 * Resolves the ffmpeg binary once. With { install: true } (default) a missing
 * ffmpeg on a supported Linux host is downloaded and verified on first use.
 * Resolves to the path, or null when none is available.
 */
export const resolveFfmpeg = ({ install = true } = {}) => {
    resolving ||= (async () => {
        const candidates = [process.env.FFMPEG_PATH, 'ffmpeg', BUNDLED_PATH].filter(Boolean);
        for (const bin of candidates) {
            if (bin === BUNDLED_PATH && !(await access(bin, constants.X_OK).then(() => true, () => false))) continue;
            if (await works(bin)) return bin;
        }
        if (!install || !bundledBuild()) return null;
        try {
            const bin = await installBundled();
            return (await works(bin)) ? bin : null;
        } catch {
            return null;
        }
    })();
    return resolving;
};

/** Test hook. */
export const resetFfmpegResolution = () => { resolving = null; };
