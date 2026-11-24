// .round: video → circular video note (ptv). Offline; the ffmpeg part is skipped when ffmpeg is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSock } from './helpers.js';

const { hasFfmpeg } = await import('../systems/media/ffmpeg.js');
const { toVideoNote } = await import('../systems/media/converters.js');
const convert = (await import('../commands/media/convert.js')).default;

test('.round is registered with aliases and asks for a video', async () => {
    const round = convert.find((c) => c.name === 'round');
    assert.ok(round);
    assert.equal(round.permission, 'public');
    assert.ok(round.aliases.includes('videonote'));
    const sock = fakeSock();
    await assert.rejects(round.execute(sock, { chat: 'x@s.whatsapp.net', raw: { key: {}, message: { conversation: '.round' } }, quoted: null }), /Reply to a video/);
    assert.equal(sock.sent.length, 0);
});

test('toVideoNote makes a square 384x384 H.264 mp4 with sound, flagged ptv', async (t) => {
    if (!(await hasFfmpeg())) return t.skip('ffmpeg not installed');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'neo-round-'));
    try {
        const src = path.join(dir, 'in.mp4');
        const out = path.join(dir, 'out.mp4');
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-pix_fmt', 'yuv420p', '-shortest', src]);
        const result = await toVideoNote(readFileSync(src));
        assert.equal(result.ptv, true);
        assert.equal(result.mimetype, 'video/mp4');
        assert.equal(result.gifPlayback, undefined);
        writeFileSync(out, result.video);
        let info;
        try {
            info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', out]).toString());
        } catch { return t.skip('ffprobe not installed'); }
        const video = info.streams.find((s) => s.codec_type === 'video');
        assert.equal(video.codec_name, 'h264');
        assert.equal(video.width, 384);
        assert.equal(video.height, 384);
        assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
