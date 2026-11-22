// Group moderation: detectors, stores, guard and the moderation commands. Offline.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, fakeSock, msg, lastText, OWNER, GROUP, ADMIN, MEMBER } from './helpers.js';

const docStore = (await import('../systems/database/docStore.js')).default;
const detectors = await import('../systems/moderation/detectors.js');
const groupConfig = await import('../systems/moderation/groupConfig.js');
const warnings = await import('../systems/moderation/warnings.js');
const mutes = await import('../systems/moderation/mutes.js');
const { loadModeration } = await import('../systems/moderation/index.js');
const { applyWarning } = await import('../systems/moderation/actions.js');
const { NoticeLimiter } = await import('../systems/security/noticeLimiter.js');
const { guardMessage, guardCommand, findViolation } = await import('../systems/moderation/guard.js');
const { invalidateGroup } = await import('../systems/groups/groupCache.js');
const { resetLimits } = await import('../systems/security/rateLimiter.js');
const commandHandler = (await import('../core/commandHandler.js')).default;

before(async () => {
    await docStore.init(new MemoryBackend());
    const settings = await import('../systems/settings/settingsStore.js');
    const users = await import('../systems/users/userStore.js');
    const { loadStats } = await import('../systems/stats/statsStore.js');
    const { loadPermissions } = await import('../systems/permissions/index.js');
    const { loadEconomy } = await import('../systems/economy/economyStore.js');
    await Promise.all([settings.loadSettings(), users.loadUsers(), loadStats(), loadPermissions(), loadModeration(), loadEconomy()]);
    (await import('../systems/owners/ownerStore.js')).loadOwners();
    await commandHandler.load();
});

beforeEach(() => {
    resetLimits();
    invalidateGroup(GROUP);
});

const run = (sock, text, opts) => commandHandler.handleCommand(sock, msg(sock, text, { group: true, ...opts }));

test('detectors: invite links, any link, vCards', () => {
    assert.equal(detectors.hasInviteLink('join https://chat.whatsapp.com/AbCdEfGhIjKlMn'), true);
    assert.equal(detectors.hasInviteLink('see whatsapp.com/channel/0029VaQim2bAu3aPsRVaDq3v'), true);
    assert.equal(detectors.hasInviteLink('https://example.com'), false);
    assert.equal(detectors.hasLink('https://example.com/x', 'invites'), false);
    assert.equal(detectors.hasLink('https://example.com/x', 'all'), true);
    assert.equal(detectors.hasLink('visit google.com now', 'all'), true);
    assert.equal(detectors.hasLink('hello there. ok', 'all'), false);
    assert.equal(detectors.hasVCard({ type: 'contactMessage', text: '' }), true);
    assert.equal(detectors.hasVCard({ type: 'conversation', text: 'BEGIN:VCARD\nEND:VCARD' }), true);
    assert.equal(detectors.hasVCard({ type: 'conversation', text: 'hi' }), false);
});

test('group config: typed options, defaults not stored', () => {
    const g = 'cfg@g.us';
    assert.equal(groupConfig.getGroupOption(g, 'antilink'), 'off');
    assert.equal(groupConfig.setGroupOption(g, 'AntiLink', 'warn').value, 'warn');
    assert.equal(groupConfig.setGroupOption(g, 'warnlimit', '5').value, 5);
    assert.throws(() => groupConfig.setGroupOption(g, 'warnlimit', '1'), /2 to 10/);
    assert.throws(() => groupConfig.setGroupOption(g, 'antilink', 'nuke'), /one of/);
    assert.throws(() => groupConfig.setGroupOption(g, 'nope', 'x'), /Unknown option/);
    assert.equal(groupConfig.hasActiveGuards(g), true);
    groupConfig.setGroupOption(g, 'antilink', 'off');
    groupConfig.setGroupOption(g, 'warnlimit', '3');
    assert.equal(groupConfig.hasActiveGuards(g), false);
});

test('warnings: add / remove / clear, found by number or LID', () => {
    const g = 'w@g.us';
    const who = { number: '212655555555', lid: '5555' };
    assert.equal(warnings.addWarning(g, who, { reason: 'a' }), 1);
    assert.equal(warnings.addWarning(g, { number: '', lid: '5555' }, { reason: 'b' }), 2);
    assert.equal(warnings.warningCount(g, { number: '212655555555' }), 2);
    assert.deepEqual(warnings.warningHistory(g, who).map((h) => h.reason), ['a', 'b']);
    assert.equal(warnings.listWarnings(g).length, 1);
    assert.equal(warnings.removeWarning(g, who), 1);
    assert.equal(warnings.clearWarnings(g, who), 0);
    assert.equal(warnings.warningCount(g, who), 0);
    assert.equal(warnings.listWarnings(g).length, 0);
});

test('mutes: timed mute expires', () => {
    const g = 'm@g.us';
    const who = { number: '212644444444', lid: '' };
    mutes.muteMember(g, who, { ms: 60_000, now: 1000 });
    assert.ok(mutes.activeMute(g, who, 2000));
    assert.equal(mutes.listMutes(g, 2000).length, 1);
    assert.equal(mutes.activeMute(g, who, 62_000), null);
    assert.equal(mutes.hasMutes(g), false);
    mutes.muteMember(g, who);
    assert.ok(mutes.activeMute(g, who, Date.now() + 10 ** 9)); // 0 = until unmuted
    assert.equal(mutes.unmuteMember(g, who), true);
    assert.equal(mutes.unmuteMember(g, who), false);
});

test('applyWarning removes the member at the limit and clears warnings', async () => {
    const sock = fakeSock({ admins: ['bot'] });
    const g = 'limit@g.us';
    const who = { number: '212666666666', lid: '' };
    groupConfig.setGroupOption(g, 'warnlimit', '2');
    assert.deepEqual(await applyWarning(sock, g, who, '212666666666@s.whatsapp.net'), { count: 1, limit: 2, kicked: false });
    const second = await applyWarning(sock, g, who, '212666666666@s.whatsapp.net');
    assert.equal(second.kicked, true);
    assert.equal(sock.calls.at(-1).name, 'groupParticipantsUpdate');
    assert.deepEqual(sock.calls.at(-1).args.slice(1), [['212666666666@s.whatsapp.net'], 'remove']);
    assert.equal(warnings.warningCount(g, who), 0);
    groupConfig.setGroupOption(g, 'warnlimit', '3');
});

test('notice limiter: one notice per window', () => {
    const n = new NoticeLimiter(1000);
    assert.equal(n.allow('a', 0), true);
    assert.equal(n.allow('a', 500), false);
    assert.equal(n.allow('a', 1500), true);
});

test('findViolation priorities', () => {
    const cfg = { antilink: 'warn', linkscope: 'invites', antivcard: 'delete' };
    assert.deepEqual(findViolation({ text: 'hi' }, cfg, { until: 0 }), { kind: 'mute', action: 'delete' });
    assert.deepEqual(findViolation({ text: 'chat.whatsapp.com/AbCdEfGhIjKl' }, cfg, null), { kind: 'link', action: 'warn' });
    assert.deepEqual(findViolation({ type: 'contactMessage', text: '' }, cfg, null), { kind: 'vcard', action: 'delete' });
    assert.equal(findViolation({ text: 'hi' }, cfg, null), null);
});

test('guard: anti-link deletes a member\'s invite link and warns; admins and quiet groups untouched', async () => {
    groupConfig.setGroupOption(GROUP, 'antilink', 'warn');
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    const link = 'come https://chat.whatsapp.com/AbCdEfGhIjKlMn';

    const fromMember = msg(sock, link, { group: true, number: '212677777777' });
    assert.equal(await guardMessage({ sock, message: fromMember }), false);
    assert.deepEqual(sock.sent[0].content, { delete: fromMember.raw.key });
    assert.match(lastText(sock), /Warning 1\/3/);
    assert.equal(warnings.warningCount(GROUP, { number: '212677777777' }), 1);

    const fromAdmin = msg(sock, link, { group: true, number: ADMIN });
    const before = sock.sent.length;
    assert.equal(await guardMessage({ sock, message: fromAdmin }), true);
    assert.equal(sock.sent.length, before);

    const fromOwner = msg(sock, link, { group: true, number: OWNER });
    assert.equal(await guardMessage({ sock, message: fromOwner }), true);

    // Bot not admin → nothing deleted, but the group is told why (once).
    invalidateGroup(GROUP);
    const weak = fakeSock({ admins: [ADMIN] });
    assert.equal(await guardMessage({ sock: weak, message: msg(weak, link, { group: true, number: '212677777777' }) }), true);
    assert.equal(weak.sent.length, 1);
    assert.match(lastText(weak), /make the bot a group admin/);
    await guardMessage({ sock: weak, message: msg(weak, link, { group: true, number: '212677777777' }) });
    assert.equal(weak.sent.length, 1);
    invalidateGroup(GROUP);

    // Any web link is caught by default (linkscope "all").
    const plain = msg(sock, 'see youtube.com/watch?v=1', { group: true, number: '212677777778' });
    assert.equal(await guardMessage({ sock, message: plain }), false);

    // exemptadmins off → admins are checked too (to test it yourself).
    groupConfig.setGroupOption(GROUP, 'exemptadmins', 'off');
    assert.equal(await guardMessage({ sock, message: msg(sock, link, { group: true, number: ADMIN }) }), false);
    groupConfig.setGroupOption(GROUP, 'exemptadmins', 'on');
    warnings.clearWarnings(GROUP, { number: ADMIN });
    warnings.clearWarnings(GROUP, { number: '212677777778' });

    groupConfig.setGroupOption(GROUP, 'antilink', 'off');
    warnings.clearWarnings(GROUP, { number: '212677777777' });
    assert.equal(await guardMessage({ sock, message: msg(sock, link, { group: true, number: '212677777777' }) }), true);
});

test('guard: muted member\'s messages are deleted silently; adminonly blocks commands', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    mutes.muteMember(GROUP, { number: '212688888888', lid: '' });
    const m = msg(sock, 'hello', { group: true, number: '212688888888' });
    assert.equal(await guardMessage({ sock, message: m }), false);
    assert.equal(sock.sent.length, 1);
    assert.ok(sock.sent[0].content.delete);
    mutes.unmuteMember(GROUP, { number: '212688888888' });

    groupConfig.setGroupOption(GROUP, 'adminonly', 'on');
    assert.equal(await guardCommand({ sock, message: msg(sock, '.ping', { group: true, number: MEMBER }) }), false);
    assert.equal(await guardCommand({ sock, message: msg(sock, '.ping', { group: true, number: ADMIN }) }), true);
    groupConfig.setGroupOption(GROUP, 'adminonly', 'off');
    assert.equal(await guardCommand({ sock, message: msg(sock, '.ping', { group: true, number: MEMBER }) }), true);
});

test('.warn / .warnings / .unwarn through the command pipeline, with rank protection', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    await run(sock, '.warn 212699999999 spamming', { number: ADMIN });
    assert.match(lastText(sock), /Warnings: 1\/3/);
    assert.match(lastText(sock), /Reason: spamming/);

    resetLimits();
    await run(sock, '.warnings 212699999999', { number: MEMBER });
    assert.match(lastText(sock), /1\/3/);
    assert.match(lastText(sock), /spamming/);

    resetLimits();
    await run(sock, '.unwarn 212699999999 all', { number: ADMIN });
    assert.match(lastText(sock), /1 → 0/);

    resetLimits();
    await run(sock, `.warn ${OWNER}`, { number: ADMIN });
    assert.match(lastText(sock), /creator cannot be targeted/i);

    resetLimits();
    await run(sock, '.warn 212699999999', { number: MEMBER });
    assert.match(lastText(sock), /group admins only/);
});

test('.gset / .antilink change options; .mute and .mutelist', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    await run(sock, '.antilink kick all', { number: ADMIN });
    assert.match(lastText(sock), /antilink → kick/);
    assert.equal(groupConfig.getGroupOption(GROUP, 'linkscope'), 'all');
    resetLimits();
    await run(sock, '.gset off', { number: ADMIN });
    assert.equal(groupConfig.getGroupOption(GROUP, 'antilink'), 'off');
    resetLimits();
    await run(sock, '.gset warnlimit 4', { number: ADMIN });
    assert.equal(groupConfig.getGroupOption(GROUP, 'warnlimit'), 4);
    groupConfig.setGroupOption(GROUP, 'warnlimit', '3');
    groupConfig.setGroupOption(GROUP, 'linkscope', 'invites');

    resetLimits();
    await run(sock, '.mute 212691919191 30m', { number: ADMIN });
    assert.match(lastText(sock), /muted for 30m/);
    resetLimits();
    await run(sock, '.mutelist', { number: ADMIN });
    assert.match(lastText(sock), /@212691919191/);
    resetLimits();
    await run(sock, '.unmute 212691919191', { number: ADMIN });
    assert.match(lastText(sock), /can talk again/);
});

test('group settings commands call the right WhatsApp APIs', async () => {
    const pending = [{ jid: '44444@lid', phone_number: '212644440000@s.whatsapp.net' }, { jid: '55555@lid', phone_number: '212655550000@s.whatsapp.net' }];
    const sock = fakeSock({ admins: [ADMIN, 'bot'], pending });
    await run(sock, '.close', { number: ADMIN });
    assert.deepEqual(sock.calls.at(-1), { name: 'groupSettingUpdate', args: [GROUP, 'announcement'] });
    resetLimits();
    await run(sock, '.open', { number: ADMIN });
    assert.equal(sock.calls.at(-1).args[1], 'not_announcement');
    resetLimits();
    await run(sock, '.editinfo admins', { number: ADMIN });
    assert.equal(sock.calls.at(-1).args[1], 'locked');
    resetLimits();
    await run(sock, '.setname New Name Here', { number: ADMIN });
    assert.deepEqual(sock.calls.at(-1), { name: 'groupUpdateSubject', args: [GROUP, 'New Name Here'] });
    resetLimits();
    await run(sock, '.link', { number: ADMIN });
    assert.match(lastText(sock), /chat\.whatsapp\.com\/ABCDEFGHIJKL/);
    resetLimits();
    await run(sock, '.requests', { number: ADMIN });
    assert.match(lastText(sock), /@212644440000/);
    resetLimits();
    await run(sock, '.requests approve 2', { number: ADMIN });
    assert.deepEqual(sock.calls.at(-1).args, [GROUP, ['55555@lid'], 'approve']);
    assert.match(lastText(sock), /Approved: 1\/1/);
    resetLimits();
    await run(sock, '.open', { number: MEMBER });
    assert.match(lastText(sock), /group admins only/);
});

test('.delete removes the replied message; .hidetag mentions everyone', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    const quoted = { id: 'Q1', sender: `${MEMBER}@s.whatsapp.net`, text: 'bad', key: { remoteJid: GROUP, id: 'Q1', fromMe: false, participant: `${MEMBER}@s.whatsapp.net` } };
    await run(sock, '.delete', { number: ADMIN, quoted });
    assert.deepEqual(sock.sent[0].content, { delete: quoted.key });

    resetLimits();
    await run(sock, '.hidetag meeting at 8', { number: ADMIN });
    const last = sock.sent.at(-1).content;
    assert.equal(last.text, 'meeting at 8');
    assert.equal(last.mentions.length, 4);
});

test('turning a guard on tells the admin when the bot is not admin', async () => {
    invalidateGroup(GROUP);
    const sock = fakeSock({ admins: [ADMIN] });
    await run(sock, '.antivcard delete', { number: ADMIN });
    assert.match(lastText(sock), /NOT a group admin/);
    assert.match(lastText(sock), /exemptadmins/);
    groupConfig.setGroupOption(GROUP, 'antivcard', 'off');
});
