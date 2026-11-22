// Games: tic-tac-toe rules and bot, quiz generators, sessions, and both game plugins end to end. Offline.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, fakeSock, msg, allText, GROUP, MEMBER, ADMIN } from './helpers.js';

const ttt = await import('../systems/games/tictactoe.js');
const quiz = await import('../systems/games/quiz.js');
const { flagOf, COUNTRIES } = await import('../systems/games/countries.js');
const { GameSessions } = await import('../systems/games/sessions.js');
const docStore = (await import('../systems/database/docStore.js')).default;
const events = (await import('../core/events.js')).default;
const { resetLimits } = await import('../systems/security/rateLimiter.js');

let commandHandler;
let economy;

before(async () => {
    await docStore.init(new MemoryBackend());
    const settings = await import('../systems/settings/settingsStore.js');
    const users = await import('../systems/users/userStore.js');
    const { loadStats } = await import('../systems/stats/statsStore.js');
    const { loadPermissions } = await import('../systems/permissions/index.js');
    const { loadModeration } = await import('../systems/moderation/index.js');
    economy = await import('../systems/economy/economyStore.js');
    await Promise.all([settings.loadSettings(), users.loadUsers(), loadStats(), loadPermissions(), loadModeration(), economy.loadEconomy()]);
    (await import('../systems/owners/ownerStore.js')).loadOwners();
    commandHandler = (await import('../core/commandHandler.js')).default;
    const pluginManager = (await import('../systems/plugins/pluginManager.js')).default;
    pluginManager.attach(commandHandler);
    await pluginManager.load();
});

test('tic-tac-toe: rules', () => {
    let b = ttt.newBoard();
    for (const [cell, mark] of [[1, 'X'], [4, 'O'], [2, 'X'], [5, 'O'], [3, 'X']]) b = ttt.play(b, cell, mark).board;
    assert.equal(ttt.winner(b), 'X');
    assert.equal(ttt.play(b, 9, 'O').reason, 'over');
    const fresh = ttt.play(ttt.newBoard(), 5, 'X').board;
    assert.equal(ttt.play(fresh, 5, 'O').reason, 'taken');
    assert.equal(ttt.play(fresh, 10, 'O').reason, 'invalid');
    const draw = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X'];
    assert.equal(ttt.outcome(draw), 'draw');
    assert.match(ttt.render(ttt.newBoard()), /1️⃣ 2️⃣ 3️⃣/);
});

test('tic-tac-toe: the perfect bot never loses against random play', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let game = 0; game < 60; game++) {
        let b = ttt.newBoard();
        let turn = 'X'; // random player
        while (!ttt.outcome(b)) {
            const free = b.map((c, i) => (c ? null : i + 1)).filter(Boolean);
            const cell = turn === 'X' ? free[Math.floor(random() * free.length)] : ttt.bestMove(b, 'O');
            b = ttt.play(b, cell, turn).board;
            turn = ttt.other(turn);
        }
        assert.notEqual(ttt.outcome(b), 'X');
    }
    assert.equal(ttt.bestMove(['X', 'X', null, 'O', 'O', null, null, null, null], 'O'), 6); // wins
    assert.equal(ttt.bestMove(['X', 'X', null, null, 'O', null, null, null, null], 'O'), 3); // blocks
});

test('quiz: normalising and generated questions', () => {
    assert.equal(quiz.normalize('  Côte d\'Ivoire!! '), 'cote divoire');
    assert.equal(flagOf('MA'), '🇲🇦');
    assert.ok(COUNTRIES.length > 100);
    const seq = [0, 0.5, 0.99, 0.2, 0.7];
    let i = 0;
    const random = () => seq[i++ % seq.length];
    const flag = quiz.flagQuestion(random);
    assert.ok(quiz.isCorrect(flag, flag.display.toUpperCase()));
    const math = quiz.mathQuestion(random);
    const [, a, op, b] = math.prompt.match(/(\d+) ([+\-×]) (\d+)/);
    const expected = op === '+' ? +a + +b : op === '-' ? a - b : a * b;
    assert.ok(expected >= 0);
    assert.ok(quiz.isCorrect(math, String(expected)));
    const word = quiz.wordQuestion(random);
    assert.ok(quiz.isCorrect(word, word.display));
    assert.ok(!quiz.isCorrect(word, 'definitely-wrong'));
    const us = quiz.flagQuestion(() => COUNTRIES.findIndex((c) => c[0] === 'US') / COUNTRIES.length + 0.0001);
    assert.ok(quiz.isCorrect(us, 'USA'));
});

test('game sessions: inactivity timeout calls back once; end() does not', async () => {
    const fired = [];
    const s = new GameSessions({ timeoutMs: 20, onTimeout: (state, chat) => fired.push([chat, state.n]) });
    s.start('a', { n: 1 });
    s.start('b', { n: 2 });
    s.end('b');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(fired, [['a', 1]]);
    assert.equal(s.size, 0);
});

const send = async (sock, text, opts = {}) => {
    resetLimits();
    const m = msg(sock, text, { group: true, ...opts });
    if (text.startsWith('.')) return commandHandler.handleCommand(sock, m);
    return events.barrier('message', { sock, message: m });
};

test('xo plugin: two players, a win pays coins', async () => {
    const sock = fakeSock();
    const p1 = { number: ADMIN };
    const p2 = { number: MEMBER };
    await send(sock, '.xo', p1);
    assert.match(allText(sock), /wants to play/);
    await send(sock, '.xo', p2);
    assert.match(sock.sent.at(-1).content.text, /starts/);
    for (const [cell, who] of [['1', p1], ['4', p2], ['2', p1], ['5', p2]]) await send(sock, cell, who);
    await send(sock, '7', p1); // not a win yet
    await send(sock, '6', p2); // O: 4 5 6 → wins
    assert.match(sock.sent.at(-1).content.text, /wins!/);
    assert.equal(economy.getAccount({ number: MEMBER }).coins, 50);
    assert.equal(economy.getAccount({ number: MEMBER }).wins, 1);
    const n = sock.sent.length;
    await send(sock, '3', p1); // game over → ignored
    assert.equal(sock.sent.length, n);
});

test('xo plugin: bot opponent answers a move', async () => {
    const sock = fakeSock();
    const me = { number: '212612121212' };
    await send(sock, '.xo bot', me);
    await send(sock, '5', me);
    assert.match(sock.sent.at(-1).content.text, /Bot played \d|wins|Draw/);
    await send(sock, '.xo end', me);
    assert.match(sock.sent.at(-1).content.text, /Game ended/);
});

test('quiz plugin: math round answered in chat scores points', async () => {
    const sock = fakeSock();
    const player = { number: '212613131313' };
    await send(sock, '.math', player);
    for (let round = 0; round < 5; round++) {
        const prompt = [...sock.sent].reverse().find((s) => /What is/.test(s.content?.text || '')).content.text;
        const [, a, op, b] = prompt.match(/What is (\d+) ([+\-×]) (\d+)\?/);
        const answer = op === '+' ? +a + +b : op === '-' ? a - b : a * b;
        await send(sock, 'wrong guess', player);
        await send(sock, String(answer), player);
    }
    const text = allText(sock);
    assert.match(text, /got it/);
    assert.match(text, /Game over!/);
    assert.match(text, /5 pts/);
    assert.equal(economy.getAccount({ number: '212613131313' }).coins, 50);
});

test('autoresponder: matching rules', async () => {
    const r = await import('../systems/automation/responders.js');
    assert.deepEqual(r.parseRule('Good Morning | Morning! | Hi'), { trigger: 'good morning', values: ['Morning!', 'Hi'] });
    assert.equal(r.findReply({ 'good morning': ['Morning!'] }, '  GOOD   morning '), 'Morning!');
    assert.equal(r.findReply({ 'good morning': ['Morning!'] }, 'good morning all'), null);
    assert.equal(r.findReaction({ bot: ['🤖'] }, 'is the bot online?'), '🤖');
    assert.equal(r.findReaction({ bot: ['🤖'] }, 'robotics'), null);
    assert.equal(r.findReaction({ 'c++': ['💻'] }, 'i love c++'), '💻');
});

test('autoresponder plugin: off by default, owner adds a trigger, chat switched on', async () => {
    const sock = fakeSock({ admins: [ADMIN] });
    await send(sock, 'hello bot', { number: MEMBER });
    assert.equal(sock.sent.length, 0);
    await send(sock, '.autoreply add hello bot | Hi there!', { number: '212721063675' });
    assert.match(sock.sent.at(-1).content.text, /hello bot → Hi there!/);
    await send(sock, '.autoreply on', { number: ADMIN });
    assert.match(sock.sent.at(-1).content.text, /ON/);
    await send(sock, 'Hello Bot', { number: MEMBER });
    assert.equal(sock.sent.at(-1).content.text, 'Hi there!');
    const n = sock.sent.length;
    await send(sock, 'hello bot', { number: MEMBER }); // within 15 s → silent
    assert.equal(sock.sent.length, n);
});
