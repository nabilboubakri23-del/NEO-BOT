// ".settings": buttons, permissions per scope, on/off switches. Offline.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, fakeSock, msg, allText, lastText, OWNER, GROUP, ADMIN, MEMBER } from './helpers.js';

const docStore = (await import('../systems/database/docStore.js')).default;
const settings = await import('../systems/settings/settingsStore.js');
const groupConfig = await import('../systems/moderation/groupConfig.js');
const { invalidateGroup } = await import('../systems/groups/groupCache.js');
const { resetLimits } = await import('../systems/security/rateLimiter.js');
const governor = (await import('../systems/antiban/index.js')).default;
const commandHandler = (await import('../core/commandHandler.js')).default;

before(async () => {
    await docStore.init(new MemoryBackend());
    const users = await import('../systems/users/userStore.js');
    const { loadStats } = await import('../systems/stats/statsStore.js');
    const { loadPermissions } = await import('../systems/permissions/index.js');
    const { loadModeration } = await import('../systems/moderation/index.js');
    await Promise.all([settings.loadSettings(), users.loadUsers(), loadStats(), loadPermissions(), loadModeration()]);
    (await import('../systems/owners/ownerStore.js')).loadOwners();
    await commandHandler.load();
});

beforeEach(() => {
    resetLimits();
    invalidateGroup(GROUP);
});

const cmd = (sock, text, opts) => (resetLimits(), commandHandler.handleCommand(sock, msg(sock, text, opts)));
const pick = (sock, id, opts) => (resetLimits(), commandHandler.handleSelection(sock, { ...msg(sock, '', opts), selectionId: id }));
const relayed = (sock) => JSON.stringify(sock.sent.at(-1)?.relay || sock.sent.at(-1)?.content || '');

test('regular member: no settings to change', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    await cmd(sock, '.settings', { group: true, number: MEMBER });
    assert.match(lastText(sock), /No settings you can change/);
    await cmd(sock, '.settings', { number: MEMBER });
    assert.match(lastText(sock), /No settings you can change/);
});

test('group admin: sees chat + group sections, never bot settings', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    await cmd(sock, '.settings', { group: true, number: ADMIN });
    const home = relayed(sock);
    assert.match(home, /settings:scope:group/);
    assert.match(home, /settings:scope:chat/);
    assert.doesNotMatch(home, /settings:scope:bot/);

    await pick(sock, 'settings:scope:group', { group: true, number: ADMIN });
    assert.match(relayed(sock), /settings:open:group:antibad/);

    await pick(sock, 'settings:open:group:adminonly', { group: true, number: ADMIN });
    assert.match(relayed(sock), /settings:set:group:adminonly:on/);

    await pick(sock, 'settings:set:group:antibad:warn', { group: true, number: ADMIN });
    assert.equal(groupConfig.getGroupOption(GROUP, 'antibad'), 'warn');
    await cmd(sock, '.settings off antibad', { group: true, number: ADMIN });
    assert.equal(groupConfig.getGroupOption(GROUP, 'antibad'), 'off');

    // Forged / forwarded button ids are re-checked.
    await pick(sock, 'settings:set:bot:active:off', { group: true, number: ADMIN });
    assert.equal(settings.getSetting('active'), true);
    assert.match(allText(sock), /Only bot owners/);
    await pick(sock, 'settings:set:group:antispam:kick', { group: true, number: MEMBER });
    assert.equal(groupConfig.getGroupOption(GROUP, 'antispam'), 'off');
});

test('chat switch: admin turns the bot off here and back on', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    await pick(sock, 'settings:set:chat:enabled:off', { group: true, number: ADMIN });
    assert.equal(settings.getChatSetting(GROUP, 'enabled'), false);
    const before = sock.sent.length;
    await cmd(sock, '.ping', { group: true, number: MEMBER });
    assert.equal(sock.sent.length, before, 'bot silent in a switched-off chat');
    await cmd(sock, '.settings on enabled', { group: true, number: ADMIN });
    assert.equal(settings.getChatSetting(GROUP, 'enabled'), true);
});

test('owner: global on/off and anti-ban switch', async () => {
    const sock = fakeSock();
    await cmd(sock, '.settings', { number: OWNER });
    assert.match(relayed(sock), /settings:scope:bot/);
    await pick(sock, 'settings:scope:bot', { number: OWNER });
    assert.match(relayed(sock), /settings:open:bot:active/);

    await pick(sock, 'settings:set:bot:active:off', { number: OWNER });
    assert.equal(settings.getSetting('active'), false);
    const before = sock.sent.length;
    await cmd(sock, '.ping', { number: MEMBER });
    assert.equal(sock.sent.length, before, 'bot off for users');
    await cmd(sock, '.ping', { number: OWNER });
    assert.ok(sock.sent.length > before, 'owners keep access');
    await cmd(sock, '.settings on active', { number: OWNER });
    assert.equal(settings.getSetting('active'), true);

    await cmd(sock, '.set antiban off', { number: OWNER });
    assert.equal(governor.status().enabled, false);
    await cmd(sock, '.settings on antiban', { number: OWNER });
    assert.equal(governor.status().enabled, true);
    settings.resetSetting('all');
});
