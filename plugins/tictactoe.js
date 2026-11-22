import config from '../config/config.js';
import { rewardWin } from '../systems/economy/economyStore.js';
import { GameSessions } from '../systems/games/sessions.js';
import { bestMove, newBoard, other, outcome, play, render } from '../systems/games/tictactoe.js';
import { mentionOf } from '../utils/mentions.js';
import { box } from '../utils/formatter.js';
import { personKey, senderOf } from '../utils/targets.js';

/**
 * Tic-tac-toe (XO), one game per chat.
 *   .xo            create a game, or join the waiting one
 *   .xo bot        play against the bot (works in private chat too)
 *   .xo end        stop the game (its players or group admins)
 * Moves: send a number 1–9 when it is your turn. Idle games end after 3 minutes.
 * Wins pay coins and XP (see .profile).
 */

const P = config.bot.prefix;
const IDLE_MS = 3 * 60 * 1000;
const BOT = 'bot';
const PRIZE = { human: { coins: 50, xp: 100 }, bot: { coins: 20, xp: 40 } };
const BOT_MISTAKE_RATE = 0.25; // the bot plays perfectly 3 times out of 4, so it can be beaten

const games = new GameSessions({
    timeoutMs: IDLE_MS,
    onTimeout: (game, chat) => game.sock.sendMessage(chat, { text: box('TIC-TAC-TOE', ['⏰ Game ended: no move for 3 minutes.']) })
});

const playerOf = (message) => ({ key: personKey(senderOf(message)), who: senderOf(message), ...mentionOf(message) });

const current = (game) => (game.turn === 'X' ? game.x : game.o);

const statusLines = (game) => [
    render(game.board),
    '',
    `❌ ${game.x.text}   vs   ⭕ ${game.o.key === BOT ? '🤖 Bot' : game.o.text}`
];

const send = (game, chat, lines, extra = []) =>
    game.sock.sendMessage(chat, { text: box('TIC-TAC-TOE', lines), mentions: [game.x.jid, game.o.jid, ...extra].filter((j) => j && j !== BOT) });

const randomFree = (board) => {
    const free = board.map((c, i) => (c ? null : i + 1)).filter(Boolean);
    return free[Math.floor(Math.random() * free.length)];
};

/** Ends the game when it is over; pays the winner. Returns true when it ended. */
const finishIfOver = async (game, chat) => {
    const result = outcome(game.board);
    if (!result) return false;
    games.end(chat);
    if (result === 'draw') {
        await send(game, chat, [...statusLines(game), '', '🤝 Draw!']);
        return true;
    }
    const winner = result === 'X' ? game.x : game.o;
    if (winner.key === BOT) {
        await send(game, chat, [...statusLines(game), '', '🤖 The bot wins! Try again: ' + P + 'xo bot']);
        return true;
    }
    const prize = game.o.key === BOT ? PRIZE.bot : PRIZE.human;
    rewardWin(winner.who, prize);
    await send(game, chat, [...statusLines(game), '', `🏆 ${winner.text} wins!`, `+🪙 ${prize.coins} coins · +${prize.xp} XP`]);
    return true;
};

const botTurn = async (game, chat) => {
    const cell = Math.random() < BOT_MISTAKE_RATE ? randomFree(game.board) : bestMove(game.board, game.turn);
    game.board = play(game.board, cell, game.turn).board;
    game.turn = other(game.turn);
    if (await finishIfOver(game, chat)) return;
    await send(game, chat, [...statusLines(game), '', `🤖 Bot played ${cell}. Your turn ${game.x.text} — send 1-9.`]);
};

const start = async (game, chat) => {
    game.status = 'playing';
    game.board = newBoard();
    game.turn = 'X';
    games.touch(chat);
    await send(game, chat, [...statusLines(game), '', `${game.x.text} starts (❌). Send a number 1-9.`]);
};

const handleCommand = async (sock, message, args, ctx) => {
    const chat = message.chat;
    const me = playerOf(message);
    const sub = String(args[0] || '').toLowerCase();
    const game = games.get(chat);

    if (['end', 'stop', 'quit'].includes(sub)) {
        if (!game) return message.reply(box('TIC-TAC-TOE', ['No game here.']));
        const isPlayer = [game.x.key, game.o?.key].includes(me.key);
        if (!isPlayer && !ctx.access.isOwner && !(await ctx.access.isAdmin())) return message.reply(box('TIC-TAC-TOE', ['Only its players or group admins can end this game.']));
        games.end(chat);
        return message.reply(box('TIC-TAC-TOE', ['🛑 Game ended.']));
    }

    if (sub === 'bot') {
        if (game?.status === 'playing') return send(game, chat, [...statusLines(game), '', `A game is running. ${P}xo end to stop it.`]);
        const state = games.start(chat, { sock, x: me, o: { key: BOT, jid: BOT, text: '🤖 Bot' }, status: 'playing' });
        return start(state, chat);
    }

    if (!game) {
        if (!message.isGroup) return message.reply(box('TIC-TAC-TOE', [`In private chat, play the bot: ${P}xo bot`]));
        games.start(chat, { sock, x: me, o: null, status: 'waiting' });
        return sock.sendMessage(chat, { text: box('TIC-TAC-TOE', [`🎮 ${me.text} wants to play!`, '', `Send ${P}xo to join.`, `Or play the bot: ${P}xo bot`]), mentions: [me.jid] });
    }
    if (game.status === 'waiting') {
        if (game.x.key === me.key) return message.reply(box('TIC-TAC-TOE', ['Waiting for an opponent…', `Cancel: ${P}xo end`]));
        game.o = me;
        return start(game, chat);
    }
    return send(game, chat, [...statusLines(game), '', `Turn: ${current(game).text}`, `${P}xo end to stop.`]);
};

const handleMove = async ({ sock, message }, api) => {
    const game = games.get(message.chat);
    if (!game || game.status !== 'playing' || !/^[1-9]$/.test(message.text)) return;
    const me = personKey(senderOf(message));
    if (current(game).key !== me) return;
    if (!api.allows(sock, message)) return;

    const result = play(game.board, message.text, game.turn);
    if (!result.ok) {
        if (result.reason === 'taken') await message.reply(box('TIC-TAC-TOE', ['That cell is taken. Pick another.']));
        return;
    }
    game.sock = sock;
    game.board = result.board;
    game.turn = other(game.turn);
    games.touch(message.chat);
    if (await finishIfOver(game, message.chat)) return;
    if (current(game).key === BOT) return botTurn(game, message.chat);
    await send(game, message.chat, [...statusLines(game), '', `Your turn ${current(game).text} — send 1-9.`]);
};

export default {
    name: 'tictactoe',
    version: '1.0.0',
    author: 'NEO BOT',
    description: 'Tic-tac-toe against a friend or the bot, with coin rewards.',
    commands: [
        {
            name: 'xo',
            aliases: ['ttt', 'tictactoe'],
            category: 'games',
            description: 'Tic-tac-toe: create, join, play the bot, or end a game.',
            usage: '[bot|end]',
            examples: ['', 'bot', 'end'],
            permission: 'public',
            cooldown: 3,
            execute: handleCommand
        }
    ],
    hooks: { message: handleMove },
    async onUnload() {
        games.clear();
    }
};
