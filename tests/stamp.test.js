import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto } from 'baileys';
import { buildStamp, MAX_PER_MESSAGE, sendStamp, undoStamps, _test } from '../systems/media/stickerStamp.js';
import stamp from '../commands/sticker/stamp.js';

const parent = { remoteJid: '1-2@g.us', id: 'PARENT', fromMe: false, participant: '3@s.whatsapp.net' };

test('a stamp is a sticker annotated onto the parent message', () => {
    const content = buildStamp({ mimetype: 'image/webp', directPath: '/x', mediaKey: Buffer.alloc(32, 1) }, parent);
    const round = proto.Message.decode(proto.Message.encode(proto.Message.fromObject(content)).finish());
    assert.equal(round.messageContextInfo.messageAssociation.associationType, 11);
    assert.equal(round.messageContextInfo.messageAssociation.parentMessageKey.id, 'PARENT');
    assert.equal(round.stickerMessage.mimetype, 'image/webp');
});

test('stamps are capped per message and undo only removes the bot stamps', async () => {
    _test.history.length = 0;
    _test.uploads.set('9', { stickerMessage: { mimetype: 'image/webp', directPath: '/x', mediaKey: Buffer.alloc(32, 1) }, at: Date.now() });
    const relayed = [];
    const deleted = [];
    const sock = {
        user: { id: '1@s.whatsapp.net' },
        relayMessage: async (jid, message) => relayed.push(message),
        sendMessage: async (jid, content) => deleted.push(content.delete.id)
    };
    for (let i = 0; i < MAX_PER_MESSAGE; i++) await sendStamp(sock, parent.remoteJid, parent, '9');
    await assert.rejects(sendStamp(sock, parent.remoteJid, parent, '9'), /already has/);
    assert.equal(relayed.length, MAX_PER_MESSAGE);
    const result = await undoStamps(sock, parent.remoteJid, { parentId: 'PARENT', owner: '9' });
    assert.deepEqual(result, { found: MAX_PER_MESSAGE, removed: MAX_PER_MESSAGE });
    assert.equal(deleted.length, MAX_PER_MESSAGE);
    assert.equal(_test.history.length, 0);
    _test.uploads.clear();
});

test('.stamp without a reply shows help and rejects unknown options', async () => {
    let said = '';
    const m = { chat: '2@s.whatsapp.net', senderNumber: '9', reply: async (t) => { said = t; } };
    await stamp.execute({}, m, []);
    assert.match(said, /STICKER STAMP/);
    await assert.rejects(stamp.execute({}, m, ['boom']), /Unknown option/);
});

import { LIMITS, sendStamps } from '../systems/media/stickerStamp.js';
import { borderColour, clearBackground } from '../systems/media/backgroundRemoval.js';

test('multi-stamp respects the user and owner caps', async () => {
    _test.history.length = 0;
    _test.uploads.set('7', { stickerMessage: { mimetype: 'image/webp', directPath: '/x' }, at: Date.now() });
    let n = 0;
    const sock = { user: { id: '1@s.whatsapp.net' }, relayMessage: async () => { n++; } };
    const key = { ...parent, id: 'P2' };
    assert.deepEqual(await sendStamps(sock, parent.remoteJid, key, '7', { count: 10, limit: LIMITS.user, gapMs: 0 }), { sent: LIMITS.user, capped: true });
    await assert.rejects(sendStamps(sock, parent.remoteJid, key, '7', { count: 1, limit: LIMITS.user, gapMs: 0 }), /max 3/);
    const owner = await sendStamps(sock, parent.remoteJid, key, '7', { count: 50, limit: LIMITS.owner, gapMs: 0 });
    assert.equal(owner.sent, LIMITS.owner - LIMITS.user);
    assert.equal(n, LIMITS.owner);
    _test.history.length = 0;
    _test.uploads.clear();
});

test('background removal clears the flat border colour and keeps the subject', () => {
    const size = 64;
    const px = new Uint8Array(size * size * 4);
    for (let p = 0; p < size * size; p++) {
        const x = p % size, y = Math.floor(p / size);
        const inside = Math.hypot(x - 32, y - 32) < 16;
        px.set(inside ? [200, 20, 20, 255] : [250, 250, 250, 255], p * 4);
    }
    assert.ok(borderColour(px, size)[0] > 240);
    const { removed } = clearBackground(px, size);
    assert.ok(removed > size * size * 0.6);
    assert.equal(px[(32 * size + 32) * 4 + 3], 255);
    assert.equal(px[3], 0);
});
