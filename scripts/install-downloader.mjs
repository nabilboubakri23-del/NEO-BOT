import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Fixed upstream release. Never execute a fetched binary until its hash matches.
const version = '2026.10.26';
const expected = '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Downloader requires Linux x64.');
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
