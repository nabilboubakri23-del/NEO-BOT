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

test('soundOf falls back to the remembered sound when a reply copy drops it', async () => {
    const { soundOf } = await import('../systems/media/soundSticker.js');
    const { rememberSound, clearSounds } = await import('../systems/media/soundStickerCache.js');
    const events = (await import('../core/events.js')).default;
    clearSounds();
    const key = { remoteJid: '2@s.whatsapp.net', id: 'ABC', fromMe: false };
    const plain = { kind: 'sticker', key, message: { stickerMessage: { mimetype: 'image/webp' } } };
    assert.equal(soundOf(plain), null);
    assert.equal(soundOf({ kind: 'image', key, message: {} }), null);

    rememberSound(key, { mediaKey: Buffer.alloc(32, 1), directPath: '/a', seconds: 4 });
    const found = soundOf(plain);
    assert.equal(found.audio.seconds, 4);
    assert.equal(found.alternatives.length, 1);

    const embedded = { kind: 'sticker', key, message: { stickerMessage: { audioMessage: { mediaKey: Buffer.alloc(32, 2), directPath: '/b', seconds: 7 } } } };
    const both = soundOf(embedded);
    assert.equal(both.audio.seconds, 7); // the copy in the message first
    assert.equal(both.alternatives.length, 2); // then the remembered one

    clearSounds();
    const raw = { key: { remoteJid: '3@s.whatsapp.net', id: 'SEEN', fromMe: false }, message: { stickerMessage: { audioMessage: { mediaKey: Buffer.alloc(32, 3), directPath: '/c', seconds: 5 } } } };
    await events.emit('message', { sock: {}, message: { raw } });
    assert.equal(soundOf({ kind: 'sticker', key: raw.key, message: { stickerMessage: {} } }).audio.seconds, 5);
    clearSounds();
});

test('sound stickers from anyone are remembered per chat, unwrapped and saved across restarts', async () => {
    const { soundOf } = await import('../systems/media/soundSticker.js');
    const cache = await import('../systems/media/soundStickerCache.js');
    const events = (await import('../core/events.js')).default;
    cache.clearSounds();
    const chat = '120363000000000001@g.us';
    // A lottie (animated) sound sticker sent by another member, inside an ephemeral wrapper.
    const raw = { key: { remoteJid: chat, id: 'LOTTIE1', fromMe: false, participant: '9@s.whatsapp.net' },
        message: { ephemeralMessage: { message: { lottieStickerMessage: { message: { stickerMessage: { audioMessage: { mediaKey: Buffer.alloc(32, 4), directPath: '/l', seconds: 6 } } } } } } } };
    await events.emit('message', { sock: {}, message: { raw } });
    assert.equal(cache.latestSound(chat).audio.seconds, 6);
    assert.equal(soundOf({ kind: 'sticker', key: raw.key, message: raw.message }).audio.seconds, 6);
    assert.equal(cache.latestSound('other@g.us'), null);
    assert.ok(cache.stickerOf(raw.message));
});

test('sound stickers are recorded straight from every socket upsert type', async () => {
    const cache = await import('../systems/media/soundStickerCache.js');
    cache.clearSounds();
    cache.recordUpsert({ type: 'append', messages: [
        { key: { remoteJid: '5@s.whatsapp.net', id: 'OFF1', fromMe: false }, message: { stickerMessage: { audioMessage: { mediaKey: Buffer.alloc(32, 5), directPath: '/o', seconds: 3 } } } },
        { key: { remoteJid: '5@s.whatsapp.net', id: 'PLAIN', fromMe: false }, message: { stickerMessage: {} } },
        null
    ] });
    assert.equal(cache.recallSound('OFF1').audio.seconds, 3);
    assert.equal(cache.recallSound('PLAIN'), null);
    assert.equal(cache.latestSound('5@s.whatsapp.net').audio.seconds, 3);
    cache.clearSounds();
});

test('sound stickers sent from the WhatsApp app (audioStickerMessage, field 134) keep their sound', async () => {
    await import('../systems/security/stickerAudioProtocol.js');
    const { audioStickerReady } = await import('../systems/security/audioStickerProtocol.js');
    assert.ok(audioStickerReady());
    const { proto } = await import('baileys');
    const cache = await import('../systems/media/soundStickerCache.js');
    const { findMedia } = await import('../utils/media.js');
    cache.clearSounds();
    const wire = proto.Message.encode({ messageContextInfo: {}, audioStickerMessage: { message: { stickerMessage: { mimetype: 'image/webp', audioMessage: { mediaKey: Buffer.alloc(32, 9), directPath: '/w', seconds: 8 } } } } }).finish();
    assert.ok(wire.includes(0xb2)); // tag 134 → varint b2 08
    const message = proto.Message.decode(wire);
    assert.equal(message.audioStickerMessage.message.stickerMessage.audioMessage.seconds, 8);
    const key = { remoteJid: '7@g.us', id: 'APP1', fromMe: false };
    cache.recordUpsert({ type: 'notify', messages: [{ key, message }] });
    assert.equal(cache.recallSound('APP1').audio.seconds, 8);
    assert.equal(findMedia({ raw: { key, message } }, ['sticker']).kind, 'sticker');
    assert.equal(proto.Message.toObject(message).audioStickerMessage.message.stickerMessage.mimetype, 'image/webp');
    cache.clearSounds();
});
