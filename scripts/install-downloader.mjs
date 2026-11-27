import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Fixed upstream release. Never execute a fetched binary until its hash matches.
const version = '2026.11.23';
const expected = '249ddb058234276bc449b9cd9492aad9f133bda5923c61a9e39983ae114ef17d';
if (process.platform !== 'linux' || process.arch !== 'x64') {
    // Termux / ARM: use a yt-dlp on PATH instead (pip install yt-dlp) or set YTDLP_PATH.
    console.log('Pinned downloader is Linux x64 only; skipping (install yt-dlp yourself on this device).');
    process.exit(0);
}
const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp_linux`, { signal: AbortSignal.timeout(90000) });
if (!response.ok) throw new Error(`Downloader fetch failed: ${response.status}`);
const chunks = []; let bytes = 0;
for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 50 * 1024 * 1024) throw new Error('Downloader executable too large.');
    chunks.push(Buffer.from(chunk));
}
const buffer = Buffer.concat(chunks);
if (createHash('sha256').update(buffer).digest('hex') !== expected) throw new Error('Downloader checksum mismatch.');
const folder = path.resolve('storage/cache/download-tools');
await mkdir(folder, { recursive: true });
await writeFile(path.join(folder, 'yt-dlp.tmp'), buffer, { mode: 0o700 });
await rename(path.join(folder, 'yt-dlp.tmp'), path.join(folder, 'yt-dlp'));
await chmod(path.join(folder, 'yt-dlp'), 0o700);
console.log(`Verified downloader ${version} installed.`);

// Static ffmpeg (pinned, checksum-verified) for muxing Pinterest HLS videos and media conversion.
// A failure here never breaks the build: the bot downloads it again on first use.
try {
    const { installBundled, works } = await import('../systems/media/ffmpegBinary.js');
    const bin = await installBundled();
    console.log(`Verified ffmpeg installed: ${(await works(bin)) ? 'ok' : 'not runnable'}.`);
} catch (error) {
    console.log(`ffmpeg install skipped: ${error.message}`);
}
