import config from '../config/config.js';
import { addCoins, addXp, rewardWin } from '../systems/economy/economyStore.js';
import { GameSessions } from '../systems/games/sessions.js';
import { isCorrect, QUIZZES } from '../systems/games/quiz.js';
import { sendButtons } from '../systems/menus/interactiveMenu.js';
import { mentionOf } from '../utils/mentions.js';
import { box } from '../utils/formatter.js';
import { personKey, senderOf } from '../utils/targets.js';

/**
 * Chat quizzes (offline question generators, no remote datasets):
 *   .quiz flag | math | word     start 5 rounds (aliases: .flag, .math, .scramble)
 *   .quiz hint · .quiz stop
 * The first correct answer in the chat scores. 30 s per round; two silent rounds end the game.
 * Points pay coins and XP at the end; the top scorer gets a win.
 */

const P = config.bot.prefix;
const ROUNDS = 5;
const ROUND_MS = 30_000;
const MAX_SILENT = 2;
const NAMES = { flag: 'FLAG QUIZ', math: 'MATH QUIZ', word: 'WORD SCRAMBLE' };
const ALIAS_KIND = { flag: 'flag', country: 'flag', math: 'math', scramble: 'word', unscramble: 'word', word: 'word' };

const quizzes = new GameSessions({ timeoutMs: ROUND_MS, onTimeout: (state, chat) => timedOut(state, chat) });

const say = (state, chat, lines, mentions = []) => state.sock.sendMessage(chat, { text: box(NAMES[state.kind], lines), mentions });

const ask = async (state, chat) => {
    state.round += 1;
    state.question = QUIZZES[state.kind]();
    state.hinted = false;
    await say(state, chat, [`Round ${state.round}/${ROUNDS}`, '', state.question.prompt, '', `⏱️ 30 s · answer in the chat · ${P}quiz hint`]);
};

const finish = async (state, chat) => {
    quizzes.end(chat);
    const ranking = Object.values(state.scores).sort((a, b) => b.points - a.points);
    if (!ranking.length) return say(state, chat, ['🏁 Game over. Nobody scored this time.', `Play again: ${P}quiz ${state.kind}`]);
    ranking.forEach((p, i) => {
        const prize = { coins: p.points * 10, xp: p.points * 20 };
        if (i === 0) rewardWin(p.who, prize);
        else {
            addCoins(p.who, prize.coins);
            addXp(p.who, prize.xp);
        }
    });
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
    await say(
        state,
        chat,
        ['🏁 Game over!', '', ...ranking.map((p, i) => `${medal(i)} ${p.text} — ${p.points} pts (+🪙 ${p.points * 10})`), '', `Play again: ${P}quiz ${state.kind}`],
        ranking.map((p) => p.jid)
    );
};

const next = async (state, chat) => {
    if (state.round >= ROUNDS) return finish(state, chat);
    quizzes.start(chat, state);
    await ask(state, chat);
};

async function timedOut(state, chat) {
    state.silent += 1;
    await say(state, chat, [`⏰ Time! The answer was: *${state.question.display}*`]);
    if (state.silent >= MAX_SILENT) {
        quizzes.start(chat, state); // finish() expects a session to end
        return finish(state, chat);
    }
    await next(state, chat);
}

const handleCommand = async (sock, message, args, ctx) => {
    const chat = message.chat;
    const sub = String(args[0] || '').toLowerCase();
    const state = quizzes.get(chat);

    if (sub === 'stop' || sub === 'end') {
        if (!state) return message.reply(box('QUIZ', ['No quiz running.']));
        state.sock = sock;
        return finish(state, chat);
    }
    if (sub === 'hint') {
        if (!state?.question) return message.reply(box('QUIZ', ['No question to hint right now.']));
        state.hinted = true;
        return message.reply(box(NAMES[state.kind], [`💡 ${state.question.hint}`, 'A hinted round is worth 1 point.']));
    }

    const kind = ALIAS_KIND[ctx.usedName] || ALIAS_KIND[sub];
    if (!kind) {
        const body = box('QUIZ', ['Pick a quiz:', `• ${P}quiz flag — guess the country`, `• ${P}quiz math — quick mental math`, `• ${P}quiz word — unscramble the word`]);
        return sendButtons(
            sock,
            chat,
            {
                title: config.bot.name,
                body,
                footer: config.bot.footer,
                buttons: [
                    { type: 'reply', text: '🏳️ Flags', id: `${P}quiz flag` },
                    { type: 'reply', text: '➗ Math', id: `${P}quiz math` },
                    { type: 'reply', text: '🔤 Words', id: `${P}quiz word` }
                ]
            },
            { quoted: message.raw, fallbackText: body }
        );
    }
    if (state) return message.reply(box('QUIZ', [`A quiz is already running (${state.round}/${ROUNDS}).`, `${P}quiz stop to end it.`]));
    const fresh = quizzes.start(chat, { sock, kind, round: 0, silent: 0, scores: {}, question: null, hinted: false });
    await ask(fresh, chat);
};

const handleAnswer = async ({ sock, message }, api) => {
    const state = quizzes.get(message.chat);
    if (!state?.question || !message.text || message.text.startsWith(P)) return;
    if (!isCorrect(state.question, message.text)) return;
    if (!api.allows(sock, message)) return;

    const who = senderOf(message);
    const key = personKey(who);
    if (!key) return;
    const tag = mentionOf(message);
    const points = state.hinted ? 1 : state.question.points;
    const entry = (state.scores[key] ||= { who, jid: tag.jid, text: tag.text, points: 0 });
    entry.points += points;
    state.silent = 0;
    state.sock = sock;
    const answer = state.question.display;
    state.question = null; // one winner per round
    await say(state, message.chat, [`✅ ${tag.text} got it: *${answer}* (+${points})`, `Score: ${entry.points}`], [tag.jid]);
    await next(state, message.chat);
};

export default {
    name: 'quiz',
    version: config.bot.version,
    author: 'NEO BOT',
    description: 'Flag, math and word-scramble quizzes with coin rewards.',
    commands: [
        {
            name: 'quiz',
            aliases: ['flag', 'country', 'math', 'scramble', 'unscramble'],
            category: 'games',
            description: 'Chat quiz: flags, math or word scramble (5 rounds).',
            usage: '[flag|math|word|hint|stop]',
            examples: ['flag', 'math', 'word', 'hint', 'stop'],
            permission: 'public',
            cooldown: 3,
            execute: handleCommand
        }
    ],
    hooks: { message: handleAnswer },
    async onUnload() {
        quizzes.clear();
    }
};
