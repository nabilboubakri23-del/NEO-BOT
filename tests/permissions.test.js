// Permission System V2 tests: ranks, rules, storage, overrides, perks and the command pipeline.
// Offline: an in-memory database and a fake socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';
process.env.MONGODB_URI = '';

const docStore = (await import('../systems/database/docStore.js')).default;
const { FileBackend } = await import('../systems/database/docStore.js');
const settings = await import('../systems/settings/settingsStore.js');
const users = await import('../systems/users/userStore.js');
const { loadStats } = await import('../systems/stats/statsStore.js');
const owners = await import('../systems/owners/ownerStore.js');
const ranks = await import('../systems/permissions/ranks.js');
const rules = await import('../systems/permissions/rankRules.js');
const rankStore = await import('../systems/permissions/rankStore.js');
const overrides = await import('../systems/permissions/commandOverrides.js');
const { resolveRank } = await import('../systems/permissions/resolveRank.js');
const { accessSpec, checkPermissions, createAccess, validateAccessFields } = await import('../systems/permissions/permissions.js');
const { cooldownFor, dailyLimitFor } = await import('../systems/permissions/perks.js');
const { resetDailyUsage } = await import('../systems/permissions/dailyLimit.js');
const { recentAudit } = await import('../systems/permissions/auditLog.js');
const { loadPermissions } = await import('../systems/permissions/index.js');
const { resetLimits } = await import('../systems/security/rateLimiter.js');
const { parseDuration } = await import('../utils/duration.js');
const commandHandler = (await import('../core/commandHandler.js')).default;
const { CommandHandler } = await import('../core/commandHandler.js');
const { PluginManager } = await import('../systems/plugins/pluginManager.js');

class MemoryBackend extends FileBackend {
    kind = 'memory';
    store = new Map();
    async init() {}
    async read(name) { return this.store.get(name); }
    async write(name, data) { this.store.set(name, structuredClone(data)); }
}

const CREATOR = '212721063675'; // config.owner.main default
const CO_OWNER = '212688888888';
const MOD = '212677777001';
const VIP = '212677777002';
const PREM = '212677777003';
const USER = '212677777004';
const OTHER = '212677777005';

const fakeSock = () => {
    const sent = [];
    return {
        sent,
        user: { id: '212700000000:5@s.whatsapp.net' },
        sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: crypto.randomUUID() } }; },
        relayMessage: async (jid, msg) => { sent.push({ jid, relay: msg }); return 'id'; },
        sendPresenceUpdate: async () => {},
        groupMetadata: async (jid) => ({ id: jid, participants: [] })
    };
};

const msg = (sock, text, number = USER) => ({
    raw: { key: { id: crypto.randomUUID(), remoteJid: `${number}@s.whatsapp.net` }, message: { conversation: text } },
    id: crypto.randomUUID(),
    chat: `${number}@s.whatsapp.net`,
    isGroup: false,
    sender: `${number}@s.whatsapp.net`,
    fromMe: false,
    senderNumber: number,
    senderLid: '',
    pushName: 'Tester',
    text,
    mentions: [],
    quoted: null,
    receivedAt: Date.now(),
    reply: (p) => sock.sendMessage(`${number}@s.whatsapp.net`, typeof p === 'string' ? { text: p } : p)
});

const person = (number) => ({ senderNumber: number, senderLid: '', fromMe: false });
const lastText = (sock) => sock.sent.at(-1)?.content?.text || '';
const run = async (sock, text, number) => {
    resetLimits();
    await commandHandler.handleCommand(sock, msg(sock, text, number));
    return lastText(sock);
};

before(async () => {
    await docStore.init(new MemoryBackend());
    await Promise.all([settings.loadSettings(), users.loadUsers(), loadStats(), loadPermissions()]);
    owners.loadOwners();
    if (!owners.isAdmin(person(CO_OWNER))) await owners.addAdmin({ number: CO_OWNER });
    rankStore.setStoredRank({ number: MOD }, 'moderator');
    rankStore.setStoredRank({ number: VIP }, 'vip');
    rankStore.setStoredRank({ number: PREM }, 'premium');
    await commandHandler.load();
});

// Leave data/owners.json as it was.
after(async () => {
    await owners.removeAdmin(CO_OWNER).catch(() => {});
});

test('hierarchy: ordered levels, aliases, atLeast', () => {
    assert.deepEqual(ranks.RANKS.map((r) => r.name), ['creator', 'owner', 'moderator', 'vip', 'premium', 'user', 'banned']);
    assert.deepEqual(ranks.RANKS.map((r) => r.level), [100, 80, 60, 40, 30, 10, 0]);
    assert.equal(ranks.rankName('public'), 'user');
    assert.equal(ranks.rankName('PREMIUM'), 'premium');
    assert.equal(ranks.rankName('god'), null);
    assert.equal(ranks.atLeast('vip', 'premium'), true);
    assert.equal(ranks.atLeast('premium', 'vip'), false);
    assert.equal(ranks.atLeast('creator', 'owner'), true);
    assert.equal(ranks.badge('premium'), '💎 Premium');
});

test('resolveRank: creator, owner, stored ranks, banned, default', () => {
    assert.equal(resolveRank(person(CREATOR)).name, 'creator');
    assert.equal(resolveRank({ ...person('212600000999'), fromMe: true }).name, 'creator');
    assert.equal(resolveRank(person(CO_OWNER)).name, 'owner');
    assert.equal(resolveRank(person(MOD)).name, 'moderator');
    assert.equal(resolveRank(person(PREM)).name, 'premium');
    assert.equal(resolveRank(person(USER)).name, 'user');
    users.setBanned({ number: OTHER }, true);
    assert.equal(resolveRank(person(OTHER)).name, 'banned');
    users.setBanned({ number: OTHER }, false);
    assert.equal(resolveRank(person(OTHER)).name, 'user');
});

test('backward compatibility: old permissions arrays map onto ranks', () => {
    assert.deepEqual({ ...accessSpec({ name: 'a', permissions: ['owner'] }) }, { rank: 'owner', scope: null, requires: [] });
    assert.equal(accessSpec({ name: 'b', permissions: ['mainOwner'] }).rank, 'creator');
    const kick = accessSpec({ name: 'c', permissions: ['group', 'admin', 'botAdmin'] });
    assert.equal(kick.rank, 'user');
    assert.equal(kick.scope, 'group');
    assert.deepEqual([...kick.requires], ['groupAdmin', 'botAdmin']);
    assert.equal(accessSpec({ name: 'd', permissions: ['private'] }).scope, 'private');
    assert.equal(accessSpec({ name: 'e', permissions: ['public'] }).rank, 'user');
    assert.equal(accessSpec({ name: 'f' }).rank, 'user');
    assert.equal(accessSpec({ name: 'g', permission: 'public' }).rank, 'user');
    assert.equal(accessSpec({ name: 'h', permission: 'vip', scope: 'group' }).scope, 'group');
});

test('validate: unknown ranks and conditions fail closed', () => {
    assert.deepEqual(CommandHandler.validate({ name: 'ok', permission: 'premium', execute() {} }), []);
    assert.ok(CommandHandler.validate({ name: 'x', permission: 'god', execute() {} }).length);
    assert.ok(CommandHandler.validate({ name: 'x', permission: 'banned', execute() {} }).length);
    assert.ok(CommandHandler.validate({ name: 'x', permission: 'vip', permissions: ['owner'], execute() {} }).length);
    assert.ok(validateAccessFields({ scope: 'channel' }).length);
    assert.ok(validateAccessFields({ requires: ['superAdmin'] }).length);
    assert.ok(validateAccessFields({ scope: 'group', permissions: ['private'] }).length);
});

test('rules: grant only strictly below your own rank', () => {
    const r = (name) => ranks.getRank(name);
    assert.equal(rules.canSetRank(r('moderator'), r('user'), 'vip').ok, true);
    assert.equal(rules.canSetRank(r('moderator'), r('user'), 'moderator').ok, false);
    assert.equal(rules.canSetRank(r('moderator'), r('vip'), 'owner').ok, false);
    assert.equal(rules.canSetRank(r('owner'), r('user'), 'moderator').ok, true);
    assert.equal(rules.canSetRank(r('owner'), r('user'), 'owner').ok, false); // only the creator grants owner
    assert.equal(rules.canSetRank(r('creator'), r('user'), 'owner').ok, true);
    assert.equal(rules.canSetRank(r('vip'), r('user'), 'premium').ok, false); // below moderator cannot manage
    assert.equal(rules.canSetRank(r('moderator'), r('moderator'), 'user').ok, false); // equal rank
    assert.equal(rules.canSetRank(r('owner'), r('owner'), 'user').ok, false);
    assert.equal(rules.canSetRank(r('creator'), r('owner'), 'user').ok, true);
    assert.equal(rules.canSetRank(r('creator'), r('user'), 'creator').ok, false);
    assert.equal(rules.canModerateMember(r('user'), r('user')).ok, true); // plain members: WhatsApp rules
    assert.equal(rules.canModerateMember(r('user'), r('vip')).ok, false);
    assert.equal(rules.canModerateMember(r('owner'), r('vip')).ok, true);
});

test('creator immunity: cannot be targeted, banned, denied or demoted', async () => {
    const creator = ranks.getRank('creator');
    for (const actor of ['owner', 'moderator']) {
        assert.equal(rules.canTarget(ranks.getRank(actor), creator).ok, false);
        assert.equal(rules.canSetRank(ranks.getRank(actor), creator, 'user').ok, false);
    }
    assert.equal(rules.canTarget(creator, creator).ok, false);

    const sock = fakeSock();
    assert.match(await run(sock, `.ban ${CREATOR}`, CO_OWNER), /creator cannot be targeted/i);
    assert.equal(resolveRank(person(CREATOR)).name, 'creator');
    assert.match(await run(sock, `.rank set ${CREATOR} user`, CO_OWNER), /creator cannot be targeted/i);
    assert.match(await run(sock, `.perm deny ${CREATOR} ping`, CREATOR), /creator cannot be denied/i);
    // The creator passes locks and denies.
    overrides.setLocked('ping', true);
    overrides.addException('deny', 'stats', { number: CREATOR });
    const access = createAccess(sock, msg(sock, '.ping', CREATOR));
    assert.equal((await checkPermissions(commandHandler.get('ping'), msg(sock, '.ping', CREATOR), access)).ok, true);
    assert.equal((await checkPermissions(commandHandler.get('stats'), msg(sock, '.stats', CREATOR), access)).ok, true);
    overrides.resetCommand('ping');
    overrides.resetCommand('stats');
});

test('temporary ranks expire back to user', async () => {
    const target = { number: '212677777100' };
    rankStore.setStoredRank(target, 'premium', { durationMs: 5 });
    assert.equal(resolveRank(person(target.number)).name, 'premium');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(resolveRank(person(target.number)).name, 'user');
    assert.equal(rankStore.getStoredRank(target), null);
    assert.ok(recentAudit(5).some((e) => e.action === 'rank:expire'));

    rankStore.setStoredRank({ number: '212677777101' }, 'vip', { durationMs: 5 });
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(rankStore.cleanExpired() >= 1);
    assert.equal(parseDuration('7d'), 7 * 86_400_000);
    assert.equal(parseDuration('1d12h'), 36 * 3_600_000);
    assert.equal(parseDuration('soon'), null);
});

test('rank identity: number and LID are both learned', () => {
    rankStore.setStoredRank({ number: '212677777200' }, 'vip');
    rankStore.learnRankIdentity({ senderNumber: '212677777200', senderLid: '555000111' });
    assert.equal(resolveRank({ senderNumber: '', senderLid: '555000111' }).name, 'vip');
});

test('overrides and locks win over the file default', async () => {
    const sock = fakeSock();
    settings.setSetting('cooldown', '0');
    assert.match(await run(sock, '.perm set ping premium', CREATOR), /PERMISSION SET/);
    assert.match(await run(sock, '.ping', USER), /Requires 💎 Premium\. Your rank: 👤 User\./);
    assert.doesNotMatch(await run(sock, '.ping', PREM), /Access denied/);

    assert.match(await run(sock, '.perm lock ping', CREATOR), /LOCKED/);
    const before = sock.sent.length;
    await run(sock, '.ping', PREM);
    assert.equal(sock.sent.length, before); // locked → silent for non-owners
    assert.match(await run(sock, '.ping', CO_OWNER), /locked by the creator/);
    assert.match(await run(sock, '.perm list', CO_OWNER), /locked/);
    assert.match(await run(sock, '.perm unlock ping', CO_OWNER), /Only the 🔱 Creator/);
    assert.match(await run(sock, '.perm reset ping', CREATOR), /RESET/);
    assert.doesNotMatch(await run(sock, '.ping', USER), /Access denied/);
    assert.match(await run(sock, '.perm lock perm', CREATOR), /protected/);
    settings.resetSetting('cooldown');
});

test('per-user allow and deny (deny wins)', async () => {
    const sock = fakeSock();
    assert.match(await run(sock, '.settings', USER), /Requires 👑 Owner/);
    assert.match(await run(sock, `.perm allow ${USER} settings`, CREATOR), /ACCESS GRANTED/);
    assert.match(await run(sock, '.settings', USER), /SETTINGS/);
    assert.match(await run(sock, `.perm deny ${USER} settings`, CREATOR), /ACCESS DENIED/);
    assert.match(await run(sock, '.settings', USER), /blocked/);
    assert.match(await run(sock, `.perm deny ${CO_OWNER} stats`, CREATOR), /ACCESS DENIED/);
    assert.match(await run(sock, '.stats', CO_OWNER), /blocked/); // deny beats a high rank
    overrides.resetCommand('settings');
    overrides.resetCommand('stats');
    assert.match(await run(sock, '.settings', USER), /Requires 👑 Owner/);
});

test('perks: cooldown multiplier and daily limit by rank', async () => {
    const cmd = { name: 'x', cooldown: 10 };
    assert.equal(cooldownFor(cmd, ranks.getRank('user')), 10);
    assert.equal(cooldownFor(cmd, ranks.getRank('premium')), 5);
    assert.equal(cooldownFor(cmd, ranks.getRank('vip')), 2.5);
    assert.equal(cooldownFor(cmd, ranks.getRank('moderator')), 0);
    assert.equal(dailyLimitFor(ranks.getRank('user')), 100);
    assert.equal(dailyLimitFor(ranks.getRank('premium')), Infinity);
    settings.setSetting('dailyLimit', '0');
    assert.equal(dailyLimitFor(ranks.getRank('user')), Infinity);

    const sock = fakeSock();
    settings.setSetting('dailyLimit', '2');
    settings.setSetting('cooldown', '0');
    resetDailyUsage();
    await run(sock, '.myid', OTHER);
    await run(sock, '.myid', OTHER);
    assert.match(await run(sock, '.myid', OTHER), /Daily limit reached/);
    const n = sock.sent.length;
    await run(sock, '.myid', OTHER);
    assert.equal(sock.sent.length, n); // announced once, then silent
    for (let i = 0; i < 3; i++) assert.match(await run(sock, '.myid', PREM), /Rank: 💎 Premium/);
    settings.resetSetting('dailyLimit');
    settings.resetSetting('cooldown');
    resetDailyUsage();
});

test('.rank: view, set with duration, grant-below rule, del, who, log', async () => {
    const sock = fakeSock();
    assert.match(await run(sock, '.myrank', PREM), /💎 Premium/);
    assert.match(await run(sock, '.rank list', USER), /🔱 Creator/);
    assert.match(await run(sock, `.rank set ${OTHER} vip`, USER), /Requires 🛡️ Moderator/);
    assert.match(await run(sock, `.rank set ${OTHER} vip 7d test`, MOD), /RANK UPDATED[\s\S]*🌟 VIP[\s\S]*Expires in: 7d/);
    assert.equal(resolveRank(person(OTHER)).name, 'vip');
    assert.match(await run(sock, `.rank set ${OTHER} moderator`, MOD), /below 🛡️ Moderator/);
    assert.match(await run(sock, `.rank set ${MOD} user`, MOD), /not below your rank/);
    assert.match(await run(sock, `.rank set ${OTHER} owner`, CO_OWNER), /Only the creator/);
    assert.match(await run(sock, `.rank who vip`, USER), new RegExp(OTHER));
    assert.match(await run(sock, `.rank del ${OTHER}`, MOD), /RANK REMOVED/);
    assert.equal(resolveRank(person(OTHER)).name, 'user');
    assert.match(await run(sock, `.premium ${OTHER} 12h`, CO_OWNER), /💎 Premium[\s\S]*Expires in: 12h/);
    assert.match(await run(sock, '.rank log 5', MOD), /Requires 👑 Owner/);
    assert.match(await run(sock, '.rank log 5', CO_OWNER), /AUDIT LOG[\s\S]*rank:set/);
    await run(sock, `.rank del ${OTHER}`, CO_OWNER);
});

test('.rank set owner and banned use their own source of truth', async () => {
    const sock = fakeSock();
    const target = '212677777300';
    assert.match(await run(sock, `.rank set ${target} owner`, CREATOR), /👑 Owner/);
    assert.equal(owners.isAdmin(person(target)), true);
    assert.match(await run(sock, `.rank set ${target} owner 7d`, CREATOR), /cannot be temporary/);
    assert.match(await run(sock, `.rank del ${target}`, CREATOR), /RANK REMOVED/);
    assert.equal(owners.isAdmin(person(target)), false);
    assert.match(await run(sock, `.ban ${target} spam`, MOD), /USER BANNED/);
    assert.equal(users.isBanned(person(target)), true);
    assert.equal(resolveRank(person(target)).name, 'banned');
    assert.match(await run(sock, `.ban ${VIP}`, VIP), /Requires 🛡️ Moderator/);
    assert.match(await run(sock, `.ban ${CO_OWNER}`, MOD), /not below your rank/);
    await run(sock, `.unban ${target}`, MOD);
    assert.equal(resolveRank(person(target)).name, 'user');
});

test('.help and .menu show only usable commands, with rank badges', async () => {
    const sock = fakeSock();
    const userHelp = await run(sock, '.help', USER);
    assert.doesNotMatch(userHelp, /\.ban/);
    assert.doesNotMatch(userHelp, /\.settings/);
    const modHelp = await run(sock, '.help', MOD);
    assert.match(modHelp, /\.ban .*🛡️/);
    assert.doesNotMatch(modHelp, /\.settings/);
    assert.match(await run(sock, '.help ban', MOD), /Permission: 🛡️ Moderator/);
    assert.match(await run(sock, '.help settings', USER), /No command named/);
    assert.match(await run(sock, '.help', CREATOR), /\.perm/);

    resetLimits();
    await commandHandler.handleSelection(sock, { ...msg(sock, '', MOD), selectionId: 'menu:cat:owner' });
    const modMenu = JSON.stringify(sock.sent.at(-1).relay);
    assert.match(modMenu, /\.ban/);
    assert.doesNotMatch(modMenu, /\.settings/);
    resetLimits();
    await commandHandler.handleSelection(sock, { ...msg(sock, '', USER), selectionId: 'menu:main' });
    assert.doesNotMatch(JSON.stringify(sock.sent.at(-1).relay), /OWNER PANEL/);
});

test('plugin API exposes read-only rank lookups', () => {
    const api = new PluginManager().api('test');
    assert.equal(api.ranks.of(person(PREM)).name, 'premium');
    assert.equal(api.ranks.atLeast(person(PREM), 'vip'), false);
    assert.equal(api.ranks.atLeast(person(CREATOR), 'owner'), true);
});
