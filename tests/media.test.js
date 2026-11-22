// Media: WebP sticker metadata (pure JS), media lookup, ffmpeg conversions when ffmpeg exists. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers.js';

const webp = await import('../systems/media/webpExif.js');
const { makeSticker, parseMetaArgs } = await import('../systems/media/sticker.js');
const { hasFfmpeg } = await import('../systems/media/ffmpeg.js');
const { stickerToImage } = await import('../systems/media/converters.js');
const { findMedia } = await import('../utils/media.js');

/** Minimal simple-format WebP (VP8L header only): enough for the chunk / header logic. */
const fakeVp8l = (width, height, alpha = true) => {
    const data = Buffer.alloc(10);
    data[0] = 0x2f;
    data.writeUInt32LE((width - 1) | ((height - 1) << 14) | ((alpha ? 1 : 0) << 28), 1);
    return webp.buildWebp([{ id: 'VP8L', data }]);
};

test('webp: simple file is upgraded to VP8X with an EXIF chunk', () => {
    const src = fakeVp8l(512, 300);
    const out = webp.setStickerMetadata(src, { pack: 'Pack', author: 'Me', emojis: ['😀'] });
    const chunks = webp.parseChunks(out);
    assert.deepEqual(chunks.map((c) => c.id), ['VP8X', 'VP8L', 'EXIF']);
    const head = chunks[0].data;
    assert.equal(head[0] & 0x08, 0x08); // EXIF flag
    assert.equal(head[0] & 0x10, 0x10); // alpha flag from VP8L
    assert.equal(head.readUIntLE(4, 3) + 1, 512);
    assert.equal(head.readUIntLE(7, 3) + 1, 300);
    assert.equal(out.readUInt32LE(4), out.length - 8); // RIFF size
    const meta = webp.readStickerMetadata(out);
    assert.equal(meta['sticker-pack-name'], 'Pack');
    assert.equal(meta['sticker-pack-publisher'], 'Me');
    assert.deepEqual(meta.emojis, ['😀']);
});

test('webp: metadata is replaced, not duplicated; odd-sized chunks stay aligned', () => {
    const once = webp.setStickerMetadata(fakeVp8l(10, 10), { pack: 'A', author: 'B' });
    const twice = webp.setStickerMetadata(once, { pack: 'Another pack', author: 'x' });
    assert.equal(webp.parseChunks(twice).filter((c) => c.id === 'EXIF').length, 1);
    assert.equal(webp.readStickerMetadata(twice)['sticker-pack-name'], 'Another pack');
    assert.equal(webp.isAnimatedWebp(twice), false);
    assert.throws(() => webp.parseChunks(Buffer.from('not a webp at all')), /Not a WebP/);
});

test('sticker meta args', () => {
    assert.deepEqual(parseMetaArgs('My Pack | Me', { pack: 'D', author: '' }), { pack: 'My Pack', author: 'Me' });
    assert.deepEqual(parseMetaArgs('', { pack: 'D', author: 'E' }), { pack: 'D', author: 'E' });
    assert.deepEqual(parseMetaArgs(' | Only author', { pack: 'D', author: '' }), { pack: 'D', author: 'Only author' });
});

test('re-labelling an existing sticker needs no ffmpeg', async () => {
    const out = await makeSticker(fakeVp8l(64, 64), { kind: 'sticker' }, { pack: 'Mine', author: 'Me' });
    assert.equal(webp.readStickerMetadata(out)['sticker-pack-name'], 'Mine');
});

test('findMedia: the command message first, then the replied message', () => {
    const own = { raw: { key: { id: '1' }, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } } }, quoted: null };
    assert.equal(findMedia(own, ['image']).kind, 'image');
    const reply = {
        raw: { key: { id: '2' }, message: { extendedTextMessage: { text: '.s' } } },
        quoted: { key: { id: 'q' }, message: { viewOnceMessageV2: { message: { videoMessage: { seconds: 4, mimetype: 'video/mp4' } } } } }
    };
    const found = findMedia(reply, ['image', 'video']);
    assert.equal(found.kind, 'video');
    assert.equal(found.seconds, 4);
    assert.equal(found.key.id, 'q');
    assert.equal(findMedia(reply, ['sticker']), null);
});

test('ffmpeg conversions (skipped when ffmpeg is missing)', async (t) => {
    if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-test-'));
    try {
        const jpg = path.join(dir, 'a.jpg');
        const mp4 = path.join(dir, 'a.mp4');
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240', '-frames:v', '1', jpg]);
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-pix_fmt', 'yuv420p', mp4]);

        const still = await makeSticker(readFileSync(jpg), { kind: 'image' }, { pack: 'P', author: 'A' });
        assert.equal(webp.isAnimatedWebp(still), false);
        assert.equal(webp.readStickerMetadata(still)['sticker-pack-name'], 'P');

        const moving = await makeSticker(readFileSync(mp4), { kind: 'video' }, { pack: 'P', author: 'A' });
        assert.equal(webp.isAnimatedWebp(moving), true);
        assert.ok(moving.length <= 1000 * 1024);

        const image = await stickerToImage(still);
        assert.equal(image.mimetype, 'image/png');
        assert.equal(image.image.subarray(1, 4).toString(), 'PNG');
        await assert.rejects(stickerToImage(moving), /Animated stickers/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
