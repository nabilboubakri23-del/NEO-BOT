// Levels, coins, rewards and the AI client (with a fake fetch). Offline.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Set before config/config.js is first imported (helpers.js imports it).
process.env.AI_API_KEY = 'test-key';
process.env.AI_BASE_URL = 'https://ai.example.test/v1/';
const { MemoryBackend } = await import('./helpers.js');

const docStore = (await import('../systems/database/docStore.js')).default;
const levels = await import('../systems/economy/levels.js');
const eco = await import('../systems/economy/economyStore.js');
const { chat } = await import('../systems/ai/aiClient.js');
const conv = await import('../systems/ai/conversations.js');

before(async () => {
    await docStore.init(new MemoryBackend());
    await eco.loadEconomy();
});

test('levels: thresholds, progress and titles', () => {
    assert.equal(levels.xpForLevel(1), 100);
    assert.equal(levels.xpForLevel(3), 600);
    assert.equal(levels.levelForXp(0), 0);
    assert.equal(levels.levelForXp(99), 0);
    assert.equal(levels.levelForXp(100), 1);
    assert.equal(levels.levelForXp(599), 2);
    assert.equal(levels.levelForXp(600), 3);
    for (let xp = 0; xp < 50000; xp += 37) {
        const l = levels.levelForXp(xp);
        assert.ok(levels.xpForLevel(l) <= xp && levels.xpForLevel(l + 1) > xp);
    }
    assert.deepEqual(levels.progress(150), { level: 1, into: 50, needed: 200, percent: 25 });
    assert.equal(levels.titleFor(0), '🌱 Newcomer');
    assert.equal(levels.titleFor(12), '⚔️ Veteran');
    assert.equal(levels.bar(50), '▰▰▰▰▰▱▱▱▱▱');
});

test('economy: message XP has a cooldown and reports level-ups', () => {
    const who = { number: '212600000001', lid: '' };
    const first = eco.gainMessageXp(who, { now: 1_000_000, random: () => 0.99 });
    assert.equal(first.xp, 15);
    assert.equal(eco.gainMessageXp(who, { now: 1_030_000 }), null);
    const up = eco.addXp(who, 90);
    assert.equal(up.levelUp, 1);
    assert.equal(eco.addXp(who, 1).levelUp, 0);
});

test('economy: periodic rewards once per period', () => {
    const who = { number: '212600000002', lid: '' };
    const t0 = 10_000_000;
    const ok = eco.claimReward(who, 'daily', { now: t0 });
    assert.equal(ok.ok, true);
    assert.equal(ok.coins, 100);
    const again = eco.claimReward(who, 'daily', { now: t0 + 3_600_000 });
    assert.equal(again.ok, false);
    assert.equal(again.remainingMs, 23 * 3_600_000);
    assert.equal(eco.claimReward(who, 'daily', { now: t0 + 86_400_000 }).ok, true);
    assert.equal(eco.claimReward(who, 'weekly', { now: t0 }).ok, true);
    assert.equal(eco.getAccount(who).coins, 700);
});

test('economy: transfers are validated', () => {
    const a = { number: '212600000003', lid: '' };
    const b = { number: '', lid: '4444' };
    eco.addCoins(a, 100);
    assert.deepEqual(eco.transferCoins(a, b, 40), { from: 60, to: 40 });
    assert.throws(() => eco.transferCoins(a, b, 1000), /Not enough coins/);
    assert.throws(() => eco.transferCoins(a, a, 1), /yourself/);
    assert.throws(() => eco.transferCoins(a, b, -5), /whole number/);
    assert.throws(() => eco.transferCoins(a, b, 1.5), /whole number/);
});

test('economy: wins and leaderboard', () => {
    const w = { number: '212600000004', lid: '' };
    eco.rewardWin(w, { coins: 5000, xp: 9000 });
    assert.equal(eco.leaderboard('xp', 1)[0].number, '212600000004');
    assert.equal(eco.leaderboard('coins', 1)[0].number, '212600000004');
    assert.equal(eco.positionOf(w), 1);
    assert.equal(eco.getAccount(w).wins, 1);
});

test('ai client: sends an OpenAI-compatible request and maps errors', async () => {
    let seen;
    const ok = async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: ' Hello! ' } }] }) };
    };
    assert.equal(await chat([{ role: 'user', content: 'hi' }], { fetchImpl: ok }), 'Hello!');
    assert.equal(seen.url, 'https://ai.example.test/v1/chat/completions');
    assert.equal(seen.init.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages.at(-1).content, 'hi');

    const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });
    await assert.rejects(chat([], { fetchImpl: status(401) }), /key was refused/);
    await assert.rejects(chat([], { fetchImpl: status(429) }), /rate limit/);
    await assert.rejects(chat([], { fetchImpl: async () => { throw new Error('offline'); } }), /did not answer/);
});

test('ai conversations: keep the last turns, forget after silence', () => {
    for (let i = 0; i < 5; i++) conv.remember('k', `q${i}`, `a${i}`, 1000 + i);
    const h = conv.history('k', 2000);
    assert.equal(h.length, 6);
    assert.equal(h.at(-1).content, 'a4');
    assert.deepEqual(conv.history('k', 1000 + 11 * 60 * 1000), []);
});
