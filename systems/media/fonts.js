import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Open-licence fonts (SIL OFL, google/fonts) downloaded once on first use and
 * cached on disk. Pinned to one google/fonts commit and SHA-256 checked, like
 * the yt-dlp and ffmpeg installers. Nothing is committed to the repo.
 */

const COMMIT = '83c62e30d87daa70216dab6b984d00d20d96d585';
const BASE = `https://raw.githubusercontent.com/google/fonts/${COMMIT}/ofl`;
export const FONT_DIR = path.resolve('storage/cache/fonts');

/** arabic: the font maps every Arabic presentation form (U+FE80–FEFC), which ffmpeg's fribidi shaping needs; fonts with partial maps print boxes. */
export const FONTS = Object.freeze([
    { id: 1, name: 'IBM Plex Arabic', style: 'clean', file: 'IBMPlexSansArabic-Bold.ttf', src: 'ibmplexsansarabic/IBMPlexSansArabic-Bold.ttf', sha256: '691e0c891a38637ae6bbdb69700f8042cb0724a137bee615068ffdb92244f61f', arabic: true },
    { id: 2, name: 'Amiri', style: 'classic', file: 'Amiri-Bold.ttf', src: 'amiri/Amiri-Bold.ttf', sha256: 'cfccb794268e7d573d857e6d6a67f89cf8a053e8ffd85dfa0c8ec1bb36fc4827', arabic: true },
    { id: 3, name: 'Noto Kufi', style: 'kufi', file: 'NotoKufiArabic.ttf', src: 'notokufiarabic/NotoKufiArabic%5Bwght%5D.ttf', sha256: '494f6b61469d7a02a2d63f0fc4930bb007388d8cfe551de5eb98354e100889f3', arabic: true },
    { id: 4, name: 'Noto Naskh', style: 'naskh', file: 'NotoNaskhArabic.ttf', src: 'notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf', sha256: '67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f', arabic: true },
    { id: 5, name: 'Courier Prime', style: 'typewriter', file: 'CourierPrime-Bold.ttf', src: 'courierprime/CourierPrime-Bold.ttf', sha256: 'ff1f38786c849d1c41fa8e447960abdb2bd75fdfb0cfcdeb524fad65a5af3638', arabic: false },
    { id: 6, name: 'Calistoga', style: 'round', file: 'Calistoga-Regular.ttf', src: 'calistoga/Calistoga-Regular.ttf', sha256: '85a5accb2453368357d432fd0edf4701545cac7551946711c06085677fd1399f', arabic: false }
]);

export const fontById = (id) => FONTS.find((f) => f.id === Number(id)) || null;

const pending = new Map();

const download = async (font, fetchImpl) => {
    const res = await fetchImpl(`${BASE}/${font.src}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`font download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) throw new Error('font too large');
    const hash = createHash('sha256').update(buf).digest('hex');
    if (hash !== font.sha256) throw new Error(`font checksum mismatch for ${font.name}`);
    await mkdir(FONT_DIR, { recursive: true });
    const target = path.join(FONT_DIR, font.file);
    await writeFile(`${target}.part`, buf);
    await rename(`${target}.part`, target);
    return target;
};

/** Absolute path of a verified font file, downloading it the first time. */
export const fontPath = async (font, { fetchImpl = fetch } = {}) => {
    const target = path.join(FONT_DIR, font.file);
    try {
        await access(target);
        const hash = createHash('sha256').update(await readFile(target)).digest('hex');
        if (hash === font.sha256) return target;
    } catch { /* not cached yet */ }
    if (!pending.has(font.id)) pending.set(font.id, download(font, fetchImpl).finally(() => pending.delete(font.id)));
    return pending.get(font.id);
};
