import crypto from 'node:crypto';

/**
 * Pure-JS WebP sticker metadata (no native modules, works on Termux and Render):
 * writes the EXIF chunk WhatsApp reads for a sticker's pack name and author.
 * Simple WebP files (VP8 / VP8L) are upgraded to the extended format (VP8X) first.
 */

const EXIF_HEADER = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
const FLAG_EXIF = 0x08;
const FLAG_ALPHA = 0x10;
const FLAG_ANIMATION = 0x02;

export const isWebp = (buf) => Buffer.isBuffer(buf) && buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';

/** Splits a WebP file into its chunks: [{ id, data }]. */
export const parseChunks = (buf) => {
    if (!isWebp(buf)) throw new Error('Not a WebP file.');
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + size > buf.length) throw new Error('Corrupted WebP chunk.');
        chunks.push({ id, data: buf.subarray(start, start + size) });
        offset = start + size + (size % 2);
    }
    return chunks;
};

/** Joins chunks back into a WebP file. */
export const buildWebp = (chunks) => {
    const parts = chunks.map(({ id, data }) => {
        const header = Buffer.alloc(8);
        header.write(id, 0, 'ascii');
        header.writeUInt32LE(data.length, 4);
        return data.length % 2 ? Buffer.concat([header, data, Buffer.alloc(1)]) : Buffer.concat([header, data]);
    });
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'ascii');
    return Buffer.concat([head, body]);
};

/** Canvas size and alpha of a simple (VP8 / VP8L) image chunk. */
const imageInfo = ({ id, data }) => {
    if (id === 'VP8 ') {
        if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw new Error('Bad VP8 header.');
        return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff, alpha: false };
    }
    if (id === 'VP8L') {
        if (data[0] !== 0x2f) throw new Error('Bad VP8L header.');
        const bits = data.readUInt32LE(1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: Boolean((bits >>> 28) & 1) };
    }
    throw new Error(`Unsupported WebP image chunk "${id}".`);
};

const vp8x = (flags, width, height) => {
    const data = Buffer.alloc(10);
    data[0] = flags;
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
    return { id: 'VP8X', data };
};

/** The EXIF payload WhatsApp expects (JSON after a fixed TIFF header). */
export const stickerExif = ({ pack = '', author = '', emojis = [], id = crypto.randomBytes(16).toString('hex') } = {}) => {
    const json = Buffer.from(JSON.stringify({ 'sticker-pack-id': id, 'sticker-pack-name': pack, 'sticker-pack-publisher': author, emojis }), 'utf8');
    const exif = Buffer.concat([EXIF_HEADER, json]);
    exif.writeUInt32LE(json.length, 14);
    return exif;
};

/** Returns a copy of the WebP with the sticker metadata set (replaces any existing EXIF). */
export const setStickerMetadata = (webp, meta) => {
    let chunks = parseChunks(webp).filter((c) => c.id !== 'EXIF');
    if (chunks[0]?.id === 'VP8X') {
        const head = Buffer.from(chunks[0].data);
        head[0] |= FLAG_EXIF;
        chunks[0] = { id: 'VP8X', data: head };
    } else {
        const image = chunks.find((c) => c.id === 'VP8 ' || c.id === 'VP8L');
        if (!image) throw new Error('No image data in WebP.');
        const { width, height, alpha } = imageInfo(image);
        chunks = [vp8x(FLAG_EXIF | (alpha ? FLAG_ALPHA : 0), width, height), ...chunks];
    }
    chunks.push({ id: 'EXIF', data: stickerExif(meta) });
    return buildWebp(chunks);
};

/** Reads the sticker metadata back (null when none). */
export const readStickerMetadata = (webp) => {
    const exif = parseChunks(webp).find((c) => c.id === 'EXIF')?.data;
    if (!exif || exif.length < EXIF_HEADER.length) return null;
    const length = exif.readUInt32LE(14);
    try {
        return JSON.parse(exif.subarray(EXIF_HEADER.length, EXIF_HEADER.length + length).toString('utf8'));
    } catch {
        return null;
    }
};

/** True for animated WebP (VP8X animation flag). */
export const isAnimatedWebp = (webp) => {
    const first = parseChunks(webp)[0];
    return first?.id === 'VP8X' && Boolean(first.data[0] & FLAG_ANIMATION);
};
