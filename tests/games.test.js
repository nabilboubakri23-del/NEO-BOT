// Games: tic-tac-toe rules and bot, quiz generators, sessions, and both game plugins end to end. Offline.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, fakeSock, msg, allText, GROUP, MEMBER, ADMIN, OWNER } from './helpers.js';

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

test('autoresponder: contains triggers, placeholders, emoji parsing, modes', async () => {
    const r = await import('../systems/automation/responders.js');
    assert.equal(r.findReply({ '*price': ['Ask the admin'] }, 'what is the PRICE today'), 'Ask the admin');
    assert.equal(r.findReply({ '*price': ['x'] }, 'prices'), null);
    assert.equal(r.fillPlaceholders('Hi {name} ({number})', { name: 'Nabil', number: '212' }), 'Hi Nabil (212)');
    assert.deepEqual(r.parseEmojis('😂 🔥, ❤️ abc 😂'), ['😂', '🔥', '❤️']);
    assert.equal(r.reactMode(true), 'words');
    assert.equal(r.reactMode('owner'), 'owner');
    assert.equal(r.reactMode('bogus'), null);
});

test('autoreact: owner mode reacts only to owners; "on" reacts to everyone (rate-limited)', async () => {
    const sock = fakeSock({ admins: [ADMIN] });
    const reacts = [];
    const sendR = async (text, opts) => {
        resetLimits();
        const m = msg(sock, text, { group: true, ...opts });
        m.react = async (e) => reacts.push({ by: m.senderNumber, e });
        return text.startsWith('.') ? commandHandler.handleCommand(sock, m) : events.barrier('message', { sock, message: m });
    };
    await sendR('.autoreact owner', { number: ADMIN });
    assert.match(sock.sent.at(-1).content.text, /Only owners/);
    await sendR('.autoreact owner', { number: OWNER });
    assert.match(sock.sent.at(-1).content.text, /owners and above/);
    await sendR('hello everyone', { number: MEMBER });
    assert.equal(reacts.length, 0);
    await sendR('hello everyone', { number: OWNER });
    assert.equal(reacts.length, 1);
    assert.equal(reacts[0].by, OWNER);

    await sendR('.autoreact on', { number: ADMIN });
    assert.match(sock.sent.at(-1).content.text, /every message/);
    await sendR('nice', { number: '212633333333' });
    assert.equal(reacts.length, 2);
    await sendR('again', { number: '212633333333' }); // same sender within 20 s → no reaction
    assert.equal(reacts.length, 2);

    await sendR('.autoreact off', { number: ADMIN });
    await sendR('hello', { number: OWNER });
    assert.equal(reacts.length, 2);
});

test('autoreply: warns when no triggers, global default, placeholders', async () => {
    const sock = fakeSock({ admins: [ADMIN] });
    await send(sock, '.autoreply add *thanks | You are welcome {name}!', { number: OWNER });
    await send(sock, '.autoreply global on', { number: OWNER });
    assert.match(sock.sent.at(-1).content.text, /Global default: ON/);
    await send(sock, 'ok thanks a lot', { number: MEMBER });
    assert.equal(sock.sent.at(-1).content.text, 'You are welcome Tester!');
    await send(sock, '.autoreply off', { number: ADMIN });
    const n = sock.sent.length;
    await send(sock, 'thanks again', { number: '212633333333' });
    assert.equal(sock.sent.length, n);
    await send(sock, '.autoreply global off', { number: OWNER });
});

test('autoreact/autoreply: bare command opens a button panel; a tap applies and re-shows it', async () => {
    const sock = fakeSock({ admins: [ADMIN] });
    await send(sock, '.autoreact', { number: OWNER });
    const panel = JSON.stringify(sock.sent.at(-1));
    assert.match(panel, /AUTO-REACT/);
    assert.match(panel, /autoreact:set:owner/);
    resetLimits();
    const tap = msg(sock, '', { group: true, number: OWNER, selectionId: 'autoreact:set:owner' });
    await commandHandler.handleSelection(sock, tap);
    assert.match(JSON.stringify(sock.sent.at(-1)), /owners and above only/);
    resetLimits();
    await send(sock, '.autoreact', { number: MEMBER });
    assert.doesNotMatch(JSON.stringify(sock.sent.at(-1)), /autoreact:set:/); // members cannot switch
    await send(sock, '.autoreply', { number: ADMIN });
    assert.match(JSON.stringify(sock.sent.at(-1)), /autoreply:set:on/);
    resetLimits();
    await commandHandler.handleSelection(sock, msg(sock, '', { group: true, number: OWNER, selectionId: 'autoreact:set:off' }));
});

test('mood: detects feelings in Arabic, Darija, Arabizi, English and emojis', async () => {
    const m = await import('../systems/automation/mood.js');
    const cases = { 'ههههههه': 'laugh', 'lol': 'laugh', 'خخخخ': 'laugh', 'كنبغيك': 'love', 'i love you': 'love', 'انا حزين اليوم': 'sad', '😭😭': 'sad', 'شكراً لك': 'thanks', 'مبروك': 'congrats', 'الحمد لله': 'faith', 'السلام عليكم': 'greeting', 'تصبحون على خير': 'night', 'واو': 'wow', 'زوين بزاف': 'praise', 'واخا': 'agree', 'معصب': 'angry' };
    for (const [text, mood] of Object.entries(cases)) assert.equal(m.detectMood(text)?.mood, mood, text);
    assert.equal(m.detectMood('what time is the meeting'), null);
    assert.equal(m.detectMood('هههه هههه نار')?.mood, 'laugh'); // strongest wins
    for (const mood of m.MOOD_NAMES) {
        for (let i = 0; i < 10; i++) assert.ok(!m.OWNER_EXCLUSIVE.has(m.moodEmoji(mood)), `public ${mood}`);
        assert.ok(m.OWNER_EXCLUSIVE.has(m.moodEmoji(mood, { owner: true })), `owner ${mood}`);
    }
});

test('autoreact smart: reacts to the mood; owners get owner-only emojis, members never do', async () => {
    const { chooseReaction } = (await import('../plugins/autoresponder.js'));
    const { OWNER_EXCLUSIVE } = await import('../systems/automation/mood.js');
    const store = { react: { chats: {}, rules: {}, global: null, emojis: ['👑', '😂'], ownerEmojis: [] } };
    const m = (text, n) => ({ chat: `chat-${n}`, senderNumber: `2126${n}`, text });
    assert.equal(chooseReaction(store, 'smart', m('what time', 1), { isOwnerSender: false }), null);
    const laugh = chooseReaction(store, 'smart', m('هههههه', 2), { isOwnerSender: false });
    assert.ok(['😂', '🤣', '😆'].includes(laugh));
    const ownerLaugh = chooseReaction(store, 'smart', m('هههههه', 3), { isOwnerSender: true });
    assert.ok(OWNER_EXCLUSIVE.has(ownerLaugh));
    for (let i = 10; i < 40; i++) {
        const e = chooseReaction(store, 'all', m('random text', i), { isOwnerSender: false });
        assert.notEqual(e, '👑'); // reserved emoji filtered out of the public pool
    }
});
