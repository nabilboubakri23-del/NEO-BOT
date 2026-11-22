// Anti-profanity, anti-spam and the anti-ban send governor. Offline.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, fakeSock, msg, lastText, GROUP, ADMIN } from './helpers.js';

const docStore = (await import('../systems/database/docStore.js')).default;
const { checkText } = await import('../systems/moderation/profanity/matcher.js');
const { words } = await import('../systems/moderation/profanity/normalize.js');
const { FloodDetector, isBombText } = await import('../systems/moderation/spam/floodDetector.js');
const { SendGovernor } = await import('../systems/antiban/sendGovernor.js');
const groupConfig = await import('../systems/moderation/groupConfig.js');
const custom = await import('../systems/moderation/profanity/customWords.js');
const mutes = await import('../systems/moderation/mutes.js');
const { loadModeration } = await import('../systems/moderation/index.js');
const { guardMessage, floodDetector } = await import('../systems/moderation/guard.js');
const { invalidateGroup } = await import('../systems/groups/groupCache.js');

before(async () => {
    await docStore.init(new MemoryBackend());
    const settings = await import('../systems/settings/settingsStore.js');
    const users = await import('../systems/users/userStore.js');
    const { loadPermissions } = await import('../systems/permissions/index.js');
    await Promise.all([settings.loadSettings(), users.loadUsers(), loadPermissions(), loadModeration()]);
    (await import('../systems/owners/ownerStore.js')).loadOwners();
});

beforeEach(() => {
    invalidateGroup(GROUP);
    floodDetector.reset();
    for (const k of ['antilink', 'antivcard', 'antibad', 'antispam']) groupConfig.setGroupOption(GROUP, k, 'off');
});

test('profanity: evasion tricks are caught', () => {
    const bad = ['كس امك', 'ك س م ك', 'كـــــس', 'كُسّ', 'يا شرموطة', 'ولد القحبة', 'زامل', 'ابن الكلب', 'ابنالكلب', 'يلعن دينك', 'طبونمك',
        'گواد', 'ﺷﺮﻣﻮﻃﺔ', 'ك.س.م.ك', 'f u c k', 'fuuuuck', 'f4ck', 'fцck', 'sh!t', 'b1tch', 'a$$hole', 'motherfucker', 'kosomak', '9a7ba', 'STFU', 'son of a bitch'];
    for (const t of bad) assert.equal(checkText(t).hit, true, `missed: ${t}`);
});

test('profanity: ordinary words are not flagged', () => {
    const good = ['عكس', 'بكس', 'كسر', 'كسل', 'الكسكس', 'نكتة', 'كتاب', 'مدرسة', 'زكاة', 'كلام', 'assessment', 'classic', 'grass', 'Scunthorpe', 'cocktail', 'nikah', 'tizi ouzou', 'pass', 'title'];
    for (const t of good) assert.equal(checkText(t).hit, false, `false hit: ${t}`);
});

test('profanity: levels, custom and allowed words', () => {
    assert.equal(checkText('يا حمار').hit, false);
    assert.equal(checkText('يا حمار', { level: 'strict' }).hit, true);
    assert.equal(checkText('you idiot', { level: 'strict' }).hit, true);
    assert.equal(checkText('hello banana', { custom: ['banana'] }).hit, true);
    assert.equal(checkText('nik', {}).hit, true);
    assert.equal(checkText('nik', { allow: ['nik'] }).hit, false);
    assert.deepEqual(words('ك س م ك hello'), ['كسمك', 'hello']);
});

test('spam: flood, repeats, mass tags and crash text', () => {
    let t = 0;
    const d = new FloodDetector({ now: () => t });
    const m = (text, extra = {}) => ({ type: 'conversation', text, raw: { key: { id: String(Math.random()) }, message: {} }, mentions: [], ...extra });
    for (let i = 0; i < 7; i += 1) assert.equal(d.record('a', m(`msg ${i} different text`), { limit: 7 }), null);
    assert.equal(d.record('a', m('one more message'), { limit: 7 }), 'flood');
    t += 20_000;
    assert.equal(d.record('b', m('buy cheap followers now')), null);
    assert.equal(d.record('b', m('BUY cheap followers now!!')), null);
    assert.equal(d.record('b', m('b u y cheap followers now')), 'repeat');
    assert.equal(d.record('c', m('😂')), null);
    assert.equal(d.record('c', m('😂')), null);
    assert.equal(d.record('c', m('😂')), null);
    assert.equal(d.record('d', m('hi', { mentions: Array.from({ length: 12 }, (_, i) => `${i}@s.whatsapp.net`) })), 'mentions');
    assert.equal(isBombText('x'.repeat(5000)), true);
    assert.equal(isBombText('\u200B'.repeat(60) + 'hi'), true);
    assert.equal(isBombText('normal message'), false);
    assert.equal(d.strike('a'), 1);
    assert.equal(d.strike('a'), 2);
});

test('guard: profanity deleted + warned; edits re-checked; admins exempt', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    groupConfig.setGroupOption(GROUP, 'antibad', 'warn');
    const m = msg(sock, 'يا ابن الكلب', { group: true, number: '212644444444' });
    assert.equal(await guardMessage({ sock, message: m }), false);
    assert.deepEqual(sock.sent[0].content, { delete: m.raw.key });
    assert.match(lastText(sock), /Offensive language/);

    const edit = msg(sock, 'f.u.c.k you', { group: true, number: '212644444445' });
    edit.isEdit = true;
    assert.equal(await guardMessage({ sock, message: edit }), false);

    const fromAdmin = msg(sock, 'كس امك', { group: true, number: ADMIN });
    assert.equal(await guardMessage({ sock, message: fromAdmin }), true);

    custom.addCustomWord(GROUP, 'allow', 'nik');
    assert.equal(await guardMessage({ sock, message: msg(sock, 'nik', { group: true, number: '212644444446' }) }), true);
    custom.removeCustomWord(GROUP, 'allow', 'nik');
});

test('guard: anti-spam escalates to mute and removes the burst', async () => {
    const sock = fakeSock({ admins: [ADMIN, 'bot'] });
    groupConfig.setGroupOption(GROUP, 'antispam', 'mute');
    groupConfig.setGroupOption(GROUP, 'spamlimit', '4');
    const who = '212655555555';
    let removed = false;
    for (let i = 0; i < 5; i += 1) removed = !(await guardMessage({ sock, message: msg(sock, `spam number ${i} xx`, { group: true, number: who }) }));
    assert.equal(removed, true);
    const deletes = sock.sent.filter((s) => s.content?.delete).length;
    assert.ok(deletes >= 4, `burst deleted (${deletes})`);
    for (let i = 0; i < 5; i += 1) await guardMessage({ sock, message: msg(sock, `again ${i} yy zz`, { group: true, number: who }) });
    assert.ok(mutes.activeMute(GROUP, { number: who, lid: '' }), 'muted on 2nd strike');
    mutes.unmuteMember(GROUP, { number: who, lid: '' });
});

test('anti-ban: cold DMs, loops, queue cap and hourly limit', async () => {
    let t = 0;
    const g = new SendGovernor(
        { enabled: true, perMinute: 600, perHour: 3, burst: 50, chatGapMs: 0, blockColdDm: true },
        { now: () => t, wait: async (ms) => { t += ms; } }
    );
    const send = async () => ({ key: { id: 'x' } });
    await assert.rejects(g.run('212600000001@s.whatsapp.net', { text: 'hi' }, send), /cold_dm/);
    g.noteInbound('212600000001@s.whatsapp.net');
    await g.run('212600000001@s.whatsapp.net', { text: 'hi' }, send);
    await g.run('212600000001@s.whatsapp.net', { text: 'hi' }, send);
    await assert.rejects(g.run('212600000001@s.whatsapp.net', { text: 'hi' }, send), /repeated_text/);
    await g.run(GROUP, { text: 'group msg' }, send);
    await assert.rejects(g.run(GROUP, { text: 'another' }, send), /hourly_limit/);
    // Deletes and reactions are never blocked by the hourly message limit.
    await g.run(GROUP, { delete: { id: 'x' } }, send);
    assert.equal(g.status().sent, 4);
});

test('anti-ban: rate-limit error pauses sending', async () => {
    let t = 0;
    const g = new SendGovernor({ enabled: true, perMinute: 600, perHour: 100, burst: 50, chatGapMs: 0, blockColdDm: false }, { now: () => t, wait: async (ms) => { t += ms; } });
    await assert.rejects(g.run(GROUP, { text: 'a' }, async () => { throw new Error('rate-overlimit'); }), /rate-overlimit/);
    assert.ok(g.status().pausedMs >= 30_000);
    await g.run(GROUP, { text: 'b' }, async () => ({}));
    assert.ok(t >= 30_000, 'waited for the pause');
});
