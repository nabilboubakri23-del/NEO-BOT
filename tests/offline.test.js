// Offline tests: run with `npm test`. They never connect to WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';

process.env.SESSION_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';

const { encrypt, decrypt } = await import('../systems/security/encryption.js');
const { normalizePhoneNumber } = await import('../utils/validators.js');
const { SessionManager } = await import('../core/sessionManager.js');
const { FileStore } = await import('../systems/storage/index.js');
const fileSession = (dir) => new SessionManager(new FileStore(dir));
const { Button, generateWAMessageFromContent } = await import('baileys');

test('AES-256-GCM round trip with random IV', () => {
    const a = encrypt('secret', 'creds.json');
    const b = encrypt('secret', 'creds.json');
    assert.notDeepEqual(a, b);
    assert.equal(decrypt(a, 'creds.json').toString(), 'secret');
});

test('tampered ciphertext is rejected', () => {
    const payload = encrypt('secret', 'x');
    payload[payload.length - 1] ^= 1;
    assert.throws(() => decrypt(payload, 'x'), /Integrity check failed/);
});

test('ciphertext bound to its file (AAD)', () => {
    assert.throws(() => decrypt(encrypt('secret', 'a'), 'b'), /Integrity check failed/);
});

test('phone validation', () => {
    assert.equal(normalizePhoneNumber('+212 612-345 678'), '212612345678');
    assert.equal(normalizePhoneNumber('00212612345678'), '212612345678');
    assert.throws(() => normalizePhoneNumber('0612345678'));
    assert.throws(() => normalizePhoneNumber('abc'));
    assert.throws(() => normalizePhoneNumber('123'));
});

test('encrypted session adapter: save, restore, no plaintext on disk, tamper detection', async () => {
    const dir = path.join(os.tmpdir(), `neo-session-${Date.now()}`);
    const sm = fileSession(dir);
    const { state, saveCreds } = await sm.loadAuthState();
    state.creds.me = { id: '212600000000:1@s.whatsapp.net' };
    state.creds.account = { details: Buffer.from('x') };
    await saveCreds();
    await state.keys.set({ 'pre-key': { 1: { public: Buffer.from('pub'), private: Buffer.from('priv') } } });

    assert.equal(await sm.hasValidSession(), true);
    const restored = await fileSession(dir).loadAuthState();
    assert.equal(restored.state.creds.me.id, state.creds.me.id);
    assert.equal(restored.state.creds.noiseKey.private.toString('hex'), state.creds.noiseKey.private.toString('hex'));
    const keys = await restored.state.keys.get('pre-key', ['1']);
    assert.equal(keys['1'].private.toString(), 'priv');

    const files = await readdir(dir);
    for (const f of files) {
        const raw = await readFile(path.join(dir, f));
        assert.ok(!raw.toString('latin1').includes('noiseKey'));
        assert.ok(!f.includes('pre-key') && !f.includes('creds'));
    }

    const victim = path.join(dir, files[0]);
    const raw = await readFile(victim);
    raw[raw.length - 1] ^= 1;
    await writeFile(victim, raw);
    await assert.rejects(fileSession(dir).loadAuthState().then((s) => s.state.keys.get('pre-key', ['1']).then(() => sm.hasValidSession())), /could not be verified/);

    await sm.deleteSession();
    assert.equal(await sm.hasValidSession(), false);
});

test('ORDERS list builds a real native-flow single_select message', async () => {
    const fakeSock = { waUploadToServer: async () => ({}) };
    const msg = await new Button(fakeSock)
        .setTitle('NEO BOT').setBody('Welcome').setFooter('Advanced WhatsApp Assistant')
        .addSelection('ORDERS')
        .makeSection('MAIN SYSTEMS').makeRow('', 'AI CENTER', 'Artificial intelligence tools.', 'ai_center')
        .makeSection('OTHER SYSTEMS').makeRow('', 'SYSTEM', 'Bot information and settings.', 'system')
        .build('212600000000@s.whatsapp.net');
    const im = msg.message.interactiveMessage;
    const btn = im.nativeFlowMessage.buttons[0];
    assert.equal(btn.name, 'single_select');
    const params = JSON.parse(btn.buttonParamsJson);
    assert.equal(params.title, 'ORDERS');
    assert.equal(params.sections.length, 2);
    assert.equal(params.sections[0].rows[0].id, 'ai_center');
    assert.equal(im.header.title, 'NEO BOT');
});
