import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { proto } from 'baileys';
import { bestWindow, clampSeconds, parseClipArgs, parseTime, prepareClip, sendSoundSticker, waveform, embeddedAudio } from '../systems/media/soundSticker.js';
import { hasFfmpeg } from '../systems/media/ffmpeg.js';

test('parseTime accepts seconds and clock formats', () => {
    assert.equal(parseTime('65'), 65);
    assert.equal(parseTime('65s'), 65);
    assert.equal(parseTime('1:05'), 65);
    assert.equal(parseTime('1:02:03'), 3723);
    assert.equal(parseTime('abc'), null);
    assert.equal(parseTime(''), null);
});

test('parseClipArgs splits song, start and length with limits', () => {
    assert.deepEqual(parseClipArgs('Blinding Lights'), { query: 'Blinding Lights', start: null, seconds: 10 });
    assert.deepEqual(parseClipArgs('Song | 0:45 | 8'), { query: 'Song', start: 45, seconds: 8 });
    assert.deepEqual(parseClipArgs('Song | auto | 99'), { query: 'Song', start: null, seconds: 20 });
    assert.deepEqual(parseClipArgs('| 1:00'), { query: '', start: 60, seconds: 10 });
    assert.throws(() => parseClipArgs('Song | soon'), /Start/);
    assert.throws(() => parseClipArgs('Song | 0:10 | long'), /Length/);
    assert.equal(clampSeconds(1), 2);
});

test('bestWindow finds the loudest part and waveform is 64 bars', () => {
    const rate = 8000;
    const pcm = new Int16Array(rate * 60).fill(100);
    for (let i = rate * 30; i < rate * 40; i++) pcm[i] = i % 2 ? 20000 : -20000;
    assert.equal(bestWindow(pcm, 10, rate), 30);
    const bars = waveform(pcm);
    assert.equal(bars.length, 64);
    assert.equal(Math.max(...bars), 100);
});

test('prepareClip cuts a normalized Opus clip', { skip: !(await hasFfmpeg()) }, async () => {
    const mp3 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-f', 'mp3', 'pipe:1']);
    const clip = await prepareClip(mp3, 'mp3', { start: 5, seconds: 8 });
    assert.equal(clip.ogg.toString('ascii', 0, 4), 'OggS');
    assert.equal(clip.seconds, 8);
    assert.equal(clip.start, 5);
    assert.equal(clip.waveform.length, 64);
    const auto = await prepareClip(mp3, 'mp3', { seconds: 50 });
    assert.equal(auto.seconds, 20); // clamped to the 20 s maximum
});

test('sendSoundSticker relays one sticker that carries the audio', async () => {
    let relayed;
    const sock = {
        user: { id: '1@s.whatsapp.net' },
        waUploadToServer: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/x' }),
        relayMessage: async (jid, message) => { relayed = message; }
    };
    const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'ascii');
    await sendSoundSticker(sock, '2@s.whatsapp.net', { webp, clip: { ogg: Buffer.from('OggS'), seconds: 3, waveform: Buffer.alloc(64, 9) } });
    const audio = embeddedAudio(relayed);
    assert.equal(audio.seconds, 3);
    assert.equal(audio.ptt, true);
    const round = proto.Message.decode(proto.Message.encode(proto.Message.fromObject(relayed)).finish());
    assert.equal(round.stickerMessage.audioMessage.seconds, 3);
});
