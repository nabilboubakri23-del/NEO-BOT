// Core Evolution tests: parser, permissions, rate limits, settings, command pipeline.
// Offline: a fake socket records what the bot would send.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.SESSION_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';
process.env.MONGODB_URI = '';

const { parseCommand, suggest } = await import('../core/commandParser.js');
const { checkCooldown, checkSpam, resetLimits } = await import('../systems/security/rateLimiter.js');
const { isDuplicate } = await import('../systems/security/dedupe.js');
const docStore = (await import('../systems/database/docStore.js')).default;
const { FileBackend } = await import('../systems/database/docStore.js');
const settings = await import('../systems/settings/settingsStore.js');
const users = await import('../systems/users/userStore.js');
const { loadStats } = await import('../systems/stats/statsStore.js');
const { checkPermissions, createAccess } = await import('../systems/permissions/permissions.js');
const { invalidateGroup } = await import('../systems/groups/groupCache.js');
const commandHandler = (await import('../core/commandHandler.js')).default;
const { CommandHandler } = await import('../core/commandHandler.js');

// Isolated in-memory backend: tests never touch data/ or MongoDB.
class MemoryBackend extends FileBackend {
    kind = 'memory';
    store = new Map();
    async init() {}
    async read(name) { return this.store.get(name); }
    async write(name, data) { this.store.set(name, structuredClone(data)); }
}

const OWNER = '212721063675';
const GROUP = '120363000000000000@g.us';

const fakeSock = ({ admins = [] } = {}) => {
    const sent = [];
    return {
        sent,
        user: { id: '212700000000:5@s.whatsapp.net', lid: '99999:5@lid' },
        sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: crypto.randomUUID() } }; },
        relayMessage: async (jid, msg) => { sent.push({ jid, relay: msg }); return 'id'; },
        sendPresenceUpdate: async () => {},
        waUploadToServer: async () => ({}),
        groupMetadata: async (jid) => ({
            id: jid,
            participants: [
                { id: '11111@lid', phoneNumber: '212611111111@s.whatsapp.net', admin: admins.includes('212611111111') ? 'admin' : null },
                { id: '22222@lid', phoneNumber: '212622222222@s.whatsapp.net', admin: null },
                { id: '99999@lid', phoneNumber: '212700000000@s.whatsapp.net', admin: admins.includes('bot') ? 'admin' : null }
            ]
        })
    };
};

const msg = (sock, text, { number = '212622222222', lid = '', group = false, selectionId = null } = {}) => ({
    raw: { key: { id: crypto.randomUUID(), remoteJid: group ? GROUP : `${number}@s.whatsapp.net` }, message: { conversation: text } },
    id: crypto.randomUUID(),
    chat: group ? GROUP : `${number}@s.whatsapp.net`,
    isGroup: group,
    sender: `${number}@s.whatsapp.net`,
    fromMe: false,
    senderNumber: number,
    senderLid: lid,
    pushName: 'Tester',
    text,
    selectionId,
    mentions: [],
    quoted: null,
    receivedAt: Date.now(),
    reply: (p) => sock.sendMessage(group ? GROUP : `${number}@s.whatsapp.net`, typeof p === 'string' ? { text: p } : p)
});

const lastText = (sock) => sock.sent.at(-1)?.content?.text || '';

before(async () => {
    await docStore.init(new MemoryBackend());
    const { loadPermissions } = await import('../systems/permissions/index.js');
    await Promise.all([settings.loadSettings(), users.loadUsers(), loadStats(), loadPermissions()]);
    const { loadOwners } = await import('../systems/owners/ownerStore.js');
    loadOwners();
    await commandHandler.load();
});

test('parser: quotes, flags, body lines', () => {
    const p = parseCommand('.Say "hello world" --to=me -v rest\nline two', '.');
    assert.equal(p.name, 'say');
    assert.deepEqual(p.args, ['hello world', 'rest']);
    assert.deepEqual(p.flags, { to: 'me', v: true });
    assert.equal(p.body, 'line two');
    assert.equal(parseCommand('hello', '.'), null);
    assert.deepEqual(parseCommand('.x -- --raw', '.').args, ['--raw']);
});

test('did-you-mean suggestions', () => {
    assert.equal(suggest('pnig', ['ping', 'menu']), 'ping');
    assert.equal(suggest('menuu', ['ping', 'menu']), 'menu');
    assert.equal(suggest('zzzzzz', ['ping', 'menu']), null);
});

test('command validation rejects bad definitions', () => {
    assert.deepEqual(CommandHandler.validate({ name: 'ok', execute() {} }), []);
    assert.ok(CommandHandler.validate({ name: 'Bad Name!', execute() {} }).length);
    assert.ok(CommandHandler.validate({ name: 'x', execute() {}, permissions: ['god'] }).length);
    assert.ok(CommandHandler.validate({ name: 'x' }).length);
});

test('cooldown answers once, then stays silent', () => {
    resetLimits();
    assert.equal(checkCooldown('u', 'ping', 3, 1000).ok, true);
    const a = checkCooldown('u', 'ping', 3, 1500);
    const b = checkCooldown('u', 'ping', 3, 2000);
    assert.equal(a.ok, false);
    assert.equal(a.notify, true);
    assert.equal(b.notify, false);
    assert.equal(checkCooldown('u', 'ping', 3, 4100).ok, true);
});

test('anti-spam mutes after the limit', () => {
    resetLimits();
    for (let i = 0; i < 3; i++) assert.equal(checkSpam('s', 3, 1000 + i).ok, true);
    const muted = checkSpam('s', 3, 1010);
    assert.equal(muted.ok, false);
    assert.equal(muted.notify, true);
    assert.equal(checkSpam('s', 3, 2000).notify, false);
});

test('anti-duplicate', () => {
    assert.equal(isDuplicate('ABC'), false);
    assert.equal(isDuplicate('ABC'), true);
});

test('settings: typed values only', () => {
    assert.equal(settings.setSetting('Cooldown', '5').value, 5);
    assert.equal(settings.getSetting('cooldown'), 5);
    assert.throws(() => settings.setSetting('cooldown', '9999'), /0 to 300/);
    assert.throws(() => settings.setSetting('mode', 'chaos'), /one of/);
    assert.throws(() => settings.setSetting('nope', '1'), /Unknown/);
    settings.resetSetting('all');
    assert.equal(settings.getSetting('cooldown'), 3);
});

test('permissions (legacy array): group / admin / botAdmin / owner', async () => {
    const sock = fakeSock({ admins: ['212611111111'] });
    const groupCmd = { name: 'kick', permissions: ['group', 'admin', 'botAdmin'] };
    invalidateGroup(GROUP);

    const member = msg(sock, '.kick', { group: true });
    let r = await checkPermissions(groupCmd, member, createAccess(sock, member));
    assert.equal(r.requirement, 'groupAdmin');

    const admin = msg(sock, '.kick', { group: true, number: '212611111111' });
    r = await checkPermissions(groupCmd, admin, createAccess(sock, admin));
    assert.equal(r.requirement, 'botAdmin');

    const sock2 = fakeSock({ admins: ['212611111111', 'bot'] });
    invalidateGroup(GROUP);
    const admin2 = msg(sock2, '.kick', { group: true, number: '212611111111' });
    assert.equal((await checkPermissions(groupCmd, admin2, createAccess(sock2, admin2))).ok, true);

    const inPrivate = msg(sock2, '.kick', { number: '212611111111' });
    assert.equal((await checkPermissions(groupCmd, inPrivate, createAccess(sock2, inPrivate))).requirement, 'group');

    const owner = msg(sock2, '.x', { number: OWNER });
    assert.equal((await checkPermissions({ name: 'x', permissions: ['owner'] }, owner, createAccess(sock2, owner))).ok, true);
    const user = msg(sock2, '.x');
    assert.equal((await checkPermissions({ name: 'x', permissions: ['owner'] }, user, createAccess(sock2, user))).ok, false);
});

test('pipeline: help, unknown command suggestion, usage errors, owner gate', async () => {
    resetLimits();
    const sock = fakeSock();
    await commandHandler.handleCommand(sock, msg(sock, '.help'));
    assert.match(lastText(sock), /HELP/);
    assert.match(lastText(sock), /\.ping/);
    assert.doesNotMatch(lastText(sock), /\.dev/); // owner-only hidden

    await commandHandler.handleCommand(sock, msg(sock, '.pnig'));
    assert.match(lastText(sock), /Did you mean \.ping/);

    await commandHandler.handleCommand(sock, msg(sock, '.antiban', { number: '212633333333' }));
    assert.match(lastText(sock), /Access denied/);
    assert.match(lastText(sock), /Requires 👑 Owner\. Your rank: 👤 User\./);

    await commandHandler.handleCommand(sock, msg(sock, '.bot', { number: OWNER }));
    assert.match(lastText(sock), /USAGE/);

    await commandHandler.handleCommand(sock, msg(sock, '.help ping', { number: '212644444444' }));
    assert.match(lastText(sock), /Permission: 👤 User/);
});

test('pipeline: ban, chat off, mode private', async () => {
    resetLimits();
    const sock = fakeSock({ admins: ['212611111111'] });
    invalidateGroup(GROUP);

    await commandHandler.handleCommand(sock, msg(sock, '.ban 212655555555 flood', { number: OWNER }));
    assert.match(lastText(sock), /USER BANNED/);
    const before = sock.sent.length;
    await commandHandler.handleCommand(sock, msg(sock, '.ping', { number: '212655555555' }));
    assert.equal(sock.sent.length, before); // banned → ignored
    await commandHandler.handleCommand(sock, msg(sock, '.unban 212655555555', { number: OWNER }));
    assert.match(lastText(sock), /UNBANNED/);

    await commandHandler.handleCommand(sock, msg(sock, '.bot off', { group: true, number: '212611111111' }));
    assert.match(lastText(sock), /OFF/);
    const n = sock.sent.length;
    await commandHandler.handleCommand(sock, msg(sock, '.help', { group: true, number: '212666666666' }));
    assert.equal(sock.sent.length, n); // chat off → ignored
    resetLimits();
    await commandHandler.handleCommand(sock, msg(sock, '.bot on', { group: true, number: '212611111111' }));
    assert.match(lastText(sock), /ON/);

    settings.setSetting('mode', 'private');
    const m = sock.sent.length;
    await commandHandler.handleCommand(sock, msg(sock, '.help', { number: '212677777777' }));
    assert.equal(sock.sent.length, m);
    settings.resetSetting('mode');
});

test('pipeline: crash in a command gives a reference, not a stack', async () => {
    resetLimits();
    const sock = fakeSock();
    commandHandler.commands.set('boom', { name: 'boom', execute: async () => { throw new Error('secret internals'); } });
    await commandHandler.handleCommand(sock, msg(sock, '.boom'));
    assert.match(lastText(sock), /Ref: [0-9A-F]{6}/);
    assert.doesNotMatch(lastText(sock), /secret internals/);
    commandHandler.commands.delete('boom');
});

test('menu: category selection lists its commands with BACK', async () => {
    resetLimits();
    const sock = fakeSock();
    await commandHandler.handleSelection(sock, msg(sock, '', { selectionId: 'menu:cat:system' }));
    const relayed = sock.sent.at(-1).relay;
    const json = JSON.stringify(relayed);
    assert.match(json, /\.ping/);
    assert.match(json, /menu:main/);
});

test('users: activity tracked', () => {
    const u = users.getUser({ number: '212622222222' });
    assert.ok(u && u.commands > 0);
});
