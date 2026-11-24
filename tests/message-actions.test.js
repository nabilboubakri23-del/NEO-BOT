import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepMessage, parsePinDuration, pinMessage } from '../systems/groups/messageActions.js';
import { quotedKey } from '../utils/quotedKey.js';

test('pin durations are only the ones WhatsApp offers', () => {
    assert.equal(parsePinDuration(''), 604800);
    assert.equal(parsePinDuration('24h'), 86400);
    assert.equal(parsePinDuration('شهر'), 2592000);
    assert.equal(parsePinDuration('3h'), null);
});

test('quoted key gets the group participant', () => {
    assert.equal(quotedKey({}), null);
    assert.deepEqual(quotedKey({ isGroup: true, quoted: { key: { id: 'A', remoteJid: 'g@g.us' }, sender: 'u@s.whatsapp.net' } }), { id: 'A', remoteJid: 'g@g.us', participant: 'u@s.whatsapp.net' });
});

test('pin and keep build the right messages', async () => {
    const sent = [];
    const sock = { user: { id: '1@s.whatsapp.net' }, sendMessage: async (c, m) => sent.push(m), relayMessage: async (c, m) => sent.push(m) };
    const key = { id: 'A', remoteJid: 'g@g.us', participant: 'u@s.whatsapp.net', fromMe: false };
    await pinMessage(sock, 'g@g.us', key, 86400);
    assert.deepEqual(sent[0], { pin: key, type: 1, time: 86400 });
    await keepMessage(sock, 'g@g.us', key, true);
    assert.equal(sent[1].keepInChatMessage.keepType, 1);
    assert.equal(sent[1].keepInChatMessage.key.id, 'A');
});
