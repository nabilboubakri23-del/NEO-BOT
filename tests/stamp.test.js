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
