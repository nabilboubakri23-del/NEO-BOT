import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, generateCandidates, isValidUsername, scoreUsername, shapeOf } from '../systems/usernames/candidates.js';
import { aiRank, parseJsonArray } from '../systems/usernames/aiRank.js';
import { _reset, checkNames, lookup } from '../systems/usernames/checker.js';
import { formatResults, orderResults, parseArgs } from '../commands/tools/username.js';

test('WhatsApp username rules', () => {
    for (const ok of ['abc', 'a.bc', 'ab_c', 'abc_', '_abc', 'a1b', 'neo.bot']) assert.ok(isValidUsername(ok), ok);
    for (const bad of ['ab', '123', '.abc', 'abc.', 'a..b', 'wwwx', 'shop.com', 'ABC', 'a-bc', 'x'.repeat(36)]) assert.ok(!isValidUsername(bad), bad);
});

test('scores: patterns and letters beat random and digits', () => {
    assert.equal(shapeOf('xyx'), 'aba');
    assert.ok(scoreUsername('aaa') > scoreUsername('qzk'));
    assert.ok(scoreUsername('bob') > scoreUsername('b0b'));
    assert.ok(scoreUsername('abc') > scoreUsername('a.bc'));
    assert.ok(scoreUsername('abc') > scoreUsername('abcd'));
});

test('generators respect mode and filters', () => {
    const tri = generateCandidates('3', { letters: true, start: 'n' }, { size: 100 });
    assert.ok(tri.length > 20);
    assert.ok(tri.every((c) => c.u.length === 3 && c.u.startsWith('n') && !/\d/.test(c.u)));
    const quad = generateCandidates('4', { shape: 'abab' }, { size: 30 });
    assert.ok(quad.every((c) => c.u.length === 4 && shapeOf(c.u) === 'abab'));
    const semi = generateCandidates('semi', {}, { size: 60 });
    assert.ok(semi.every((c) => /^[a-z._]{4}$/.test(c.u) && /[._]/.test(c.u) && isValidUsername(c.u)));
    for (let i = 1; i < tri.length; i += 1) assert.ok(tri[i - 1].score >= tri[i].score);
});

test('choose mixes top names with lower ones and skips checked names', () => {
    const ranked = Array.from({ length: 50 }, (_, i) => ({ u: `n${String(i).padStart(2, '0')}x`, score: 100 - i }));
    const got = choose(ranked, 10, new Set(['n00x']));
    assert.equal(got.length, 10);
    assert.ok(!got.some((c) => c.u === 'n00x'));
    assert.equal(got[0].u, 'n01x');
});

test('AI ranking blends scores and survives bad replies', async () => {
    assert.deepEqual(parseJsonArray('sure: [1,2] ok'), [1, 2]);
    assert.equal(parseJsonArray('nope'), null);
    const pool = [{ u: 'qzx', score: 50 }, { u: 'sun', score: 50 }];
    const good = await aiRank(pool, { chatImpl: async () => '[{"u":"sun","s":95,"t":"real word"},{"u":"qzx","s":10}]' });
    assert.equal(good.ai, true);
    assert.equal(good.list[0].u, 'sun');
    assert.equal(good.list[0].tag, 'real word');
    const bad = await aiRank(pool, { chatImpl: async () => 'I cannot' });
    assert.equal(bad.ai, false);
    assert.equal(bad.list.length, 2);
});

test('lookup builds a USync username query and reads the answer', async () => {
    const sent = [];
    const sock = (answer) => ({ executeUSyncQuery: async (q) => { sent.push(q); return answer; } });
    assert.equal(await lookup(sock({ list: [{ id: '1@s.whatsapp.net', contact: true }] }), 'abc'), 'taken');
    assert.equal(await lookup(sock({ list: [] }), 'abd'), 'free');
    assert.equal(await lookup(sock(undefined), 'abe'), 'unknown');
    const q = sent[0];
    assert.equal(q.protocols[0].name, 'contact');
    assert.deepEqual(q.protocols[0].getUserElement(q.users[0]).attrs, { username: 'abc' });
    const limited = { executeUSyncQuery: async () => { throw Object.assign(new Error('rate-overlimit'), { output: { statusCode: 429 } }); } };
    await assert.rejects(lookup(limited, 'abc'), /rate-limited/);
});

test('checkNames caches, counts and stops on a hard error', async () => {
    await _reset();
    let calls = 0;
    const first = await checkNames({}, ['aaa', 'bbb'], { gap: false, lookupImpl: async (_s, u) => { calls += 1; return u === 'aaa' ? 'taken' : 'free'; } });
    assert.deepEqual(first.results.map((r) => r.status), ['taken', 'free']);
    const second = await checkNames({}, ['aaa', 'ccc'], { gap: false, lookupImpl: async () => { calls += 1; const e = new Error('not-allowed'); e.stop = true; throw e; } });
    assert.equal(second.results[0].cached, true);
    assert.equal(second.stopped, true);
    assert.equal(second.reason, 'not-allowed');
    assert.equal(calls, 3);
});

test('args and result order', () => {
    const a = parseArgs(['4', 'l', 'n:99', 'start:z', 'shape:abab']);
    assert.deepEqual(a.filters, { letters: true, start: 'z', shape: 'abab' });
    assert.equal(a.mode, '4');
    assert.equal(a.n, 25);
    assert.equal(parseArgs(['ثلاثي']).mode, '3');
    assert.deepEqual(parseArgs(['check', '@Neo', 'neo', 'x']).names, ['neo', 'x']);
    assert.equal(parseArgs(['ai', 'dark', 'gaming']).theme, 'dark gaming');
    const rows = [{ u: 'a', score: 90, status: 'taken' }, { u: 'b', score: 40, status: 'free' }, { u: 'c', score: 70, status: 'free' }];
    assert.deepEqual(orderResults(rows).map((r) => r.u), ['c', 'b', 'a']);
    assert.match(formatResults(rows, { mode: '3' }), /✅ 2 free · ❌ 1 taken/);
});

import { _resetIg, igCheckNames, igLookup } from '../systems/usernames/instagram.js';

const fakeRes = (status, body, type = 'application/json') => ({
    status, headers: { get: () => type }, json: async () => body
});

test('Instagram lookup reads taken / free / blocked', async () => {
    assert.equal(await igLookup('eeee', { fetchImpl: async () => fakeRes(200, { data: { user: { id: '1' } } }) }), 'taken');
    assert.equal(await igLookup('zq_x9', { fetchImpl: async () => fakeRes(404, {}) }), 'free');
    assert.equal(await igLookup('zq_x9', { fetchImpl: async () => fakeRes(404, null, 'text/html') }), 'unknown');
    assert.equal(await igLookup('abc', { fetchImpl: async () => fakeRes(429, {}) }), 'unknown');
    assert.equal(await igLookup('abc', { fetchImpl: async () => { throw new Error('net'); } }), 'unknown');
});

test('Instagram filter: blind server is refused, results cached', async () => {
    await _resetIg();
    const blind = await igCheckNames(['aaa'], { worksImpl: async () => false, gap: false });
    assert.equal(blind.blind, true);
    let calls = 0;
    const run = await igCheckNames(['eeee', 'q_zx'], { worksImpl: async () => true, gap: false, lookupImpl: async (u) => { calls += 1; return u === 'eeee' ? 'taken' : 'free'; } });
    assert.deepEqual(run.results.map((r) => r.status), ['taken', 'free']);
    const again = await igCheckNames(['eeee'], { worksImpl: async () => false, gap: false });
    assert.equal(again.blind, false);
    assert.equal(again.results[0].cached, true);
    assert.equal(calls, 2);
});

test('search output lists only names free on Instagram and WhatsApp', () => {
    const rows = [{ u: 'a_bc', score: 60, status: 'free' }, { u: 'xyz', score: 90, status: 'taken' }];
    const text = formatResults(rows, { mode: 'semi', onlyFree: true, ig: true, igChecked: 40, igFree: 2 });
    assert.match(text, /a_bc/);
    assert.doesNotMatch(text, /xyz/);
    assert.match(text, /40 checked on Instagram · 2 not on Instagram · ✅ 1 free/);
    assert.equal(parseArgs(['3', 'ig:off']).ig, false);
});
