import crypto from 'node:crypto';
import config from '../config/config.js';
import { child } from '../core/logger.js';
import { addCoins, addXp, rewardWin } from '../systems/economy/economyStore.js';
import { DIFFICULTY, PACKS, buildOptions, fetchCover, loadPool, makeClip, optionLabel, scoreAnswer, shuffle, titleMatches } from '../systems/games/songGuess.js';
import { recordGame, statsOf, topPlayers } from '../systems/games/songGuessStats.js';
import { drawShape } from '../systems/media/waveArt.js';
import { sendButtons, sendListMenu } from '../systems/menus/interactiveMenu.js';
import { box } from '../utils/formatter.js';
import { describeError, UserError } from '../utils/errors.js';
import { mentionOf } from '../utils/mentions.js';
import { personKey, senderOf } from '../utils/targets.js';

/**
 * Guess the song (.songguess / .sg): a short clip of a real song plays as a voice
 * note, everyone answers by tapping one of 4 options or typing 1–4 / the title.
 * Faster answers and answer streaks score more; the next clip is prepared while
 * the current round runs. Lasting rankings per group and global, coin rewards.
 */

const P = config.bot.prefix;
const log = child('songguess');
const MAX_GAMES = 6;
const MAX_SILENT = 2;
const PAUSE_MS = 4_000;
const RECENT_LIMIT = 300;
const NAME = 'GUESS THE SONG';

const games = new Map(); // chat → game
const recent = new Map(); // chat → recently played track ids

const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const react = (sock, m, text) => sock.sendMessage(m.chat, { react: { text, key: m.raw.key } }).catch(() => {});

// ── Rounds ────────────────────────────────────────────────────────────────

/** Picks the next song, its options and its clip (tries the next song when a clip fails). */
const prepare = async (game) => {
    for (let tries = 0; tries < 4 && game.queue.length; tries++) {
        const track = game.queue.shift();
        try {
            const { options, correct } = buildOptions(track, game.tracks, { artistMode: game.artistMode });
            const clip = await makeClip(track, { seconds: game.diff.clip });
            return { track, options, correct, clip };
        } catch (error) {
            log.warn(`Clip failed for ${track.id}: ${describeError(error)}`);
        }
    }
    return null;
};

const standings = (game) => Object.values(game.players).sort((a, b) => b.points - a.points);

const playRound = async (game) => {
    if (game.over) return;
    const ready = await game.next;
    if (game.over) return;
    if (!ready) return finish(game, '⚠️ Could not load more songs.');
    game.round += 1;
    game.next = game.round < game.rounds ? prepare(game) : Promise.resolve(null);
    const token = crypto.randomBytes(3).toString('hex');
    game.current = { ...ready, token, answers: new Map(), startedAt: 0, timer: null, ending: false };

    const { sock, chat } = game;
    const clipMsg = await sock.sendMessage(chat, { audio: ready.clip.ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: ready.clip.seconds, waveform: drawShape('equalizer') });
    const labels = ready.options.map((t) => optionLabel(t, game.artistMode));
    const body = box(NAME, [
        `${game.title} · Round ${game.round}/${game.rounds}`,
        '',
        '🎧 Which song is this?',
        '',
        ...labels.map((l, i) => `*${i + 1}.* ${l}`),
        '',
        `⏱️ ${game.diff.window} s · tap, or type 1–4 or the title`
    ]);
    await sendButtons(sock, chat, {
        title: '',
        body,
        footer: config.bot.footer,
        buttons: labels.map((l, i) => ({ type: 'reply', text: `${i + 1}. ${l}`.slice(0, 24), id: `${P}songguess pick ${token} ${i + 1}` }))
    }, { quoted: clipMsg, fallbackText: body });

    game.current.startedAt = Date.now();
    game.current.timer = setTimeout(() => endRound(game, token).catch((e) => log.error(describeError(e))), game.diff.window * 1000);
    game.current.timer.unref?.();
};

const answer = async (game, m, choice) => {
    const cur = game.current;
    if (!cur || cur.ending || !cur.startedAt) return;
    const who = senderOf(m);
    const key = personKey(who);
    if (!key || cur.answers.has(key)) return;
    const tag = mentionOf(m);
    const player = (game.players[key] ||= { who, jid: tag.jid, text: tag.text, name: m.pushName || '', points: 0, correct: 0, answered: 0, streak: 0, bestStreak: 0 });
    cur.answers.set(key, { choice, correct: choice === cur.correct, ms: Date.now() - cur.startedAt });
    player.answered += 1;
    await react(game.sock, m, '🎧'); // neutral: nobody can copy a ✅
    const known = Object.keys(game.players).length;
    // Everyone who has played so far answered: no need to wait (needs 2+ players, never in round 1).
    if (game.round > 1 && known >= 2 && cur.answers.size >= known) {
        cur.ending = true;
        setTimeout(() => endRound(game, cur.token).catch((e) => log.error(describeError(e))), 1500).unref?.();
    }
};

const endRound = async (game, token) => {
    const cur = game.current;
    if (!cur || cur.token !== token || game.over) return;
    clearTimeout(cur.timer);
    game.current = null;
    const windowMs = game.diff.window * 1000;
    const right = [...cur.answers.entries()].filter(([, a]) => a.correct).sort((a, b) => a[1].ms - b[1].ms);
    const wrong = cur.answers.size - right.length;

    for (const [key, p] of Object.entries(game.players)) {
        const a = cur.answers.get(key);
        if (!a?.correct) p.streak = 0;
    }
    const lines = right.map(([key, a], i) => {
        const p = game.players[key];
        p.streak += 1;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
        p.correct += 1;
        const pts = scoreAnswer({ elapsedMs: a.ms, windowMs, streak: p.streak, first: i === 0, multiplier: game.diff.multiplier });
        p.points += pts;
        return `${i === 0 ? '⚡' : '✅'} ${p.text} ${secs(a.ms)} +${pts}${p.streak >= 2 ? ` 🔥${p.streak}` : ''}`;
    });
    game.silent = cur.answers.size ? 0 : game.silent + 1;

    const t = cur.track;
    const top = standings(game).slice(0, 3);
    const caption = box(NAME, [
        `🎵 *${t.title}*`,
        `👤 ${t.artist}${t.album ? ` · 💿 ${t.album}` : ''}`,
        '',
        ...(lines.length ? lines : ['Nobody got it.']),
        ...(wrong ? [`❌ ${wrong} wrong`] : []),
        ...(top.length ? ['', '📊 ' + top.map((p, i) => `${medal(i)} ${p.text} ${p.points}`).join('  ')] : [])
    ]);
    const mentions = Object.values(game.players).map((p) => p.jid);
    const cover = await fetchCover(t);
    await game.sock.sendMessage(game.chat, cover ? { image: cover, caption, mentions } : { text: caption, mentions });

    if (game.silent >= MAX_SILENT) return finish(game, '💤 Two silent rounds, game stopped.');
    if (game.round >= game.rounds) return finish(game);
    setTimeout(() => playRound(game).catch((e) => fail(game, e)), PAUSE_MS).unref?.();
};

const finish = async (game, note = '') => {
    if (game.over) return;
    game.over = true;
    clearTimeout(game.current?.timer);
    games.delete(game.chat);
    const ranking = standings(game).filter((p) => p.answered);
    const lines = [`🏁 Game over · ${game.title}`, ...(note ? [note] : []), ''];
    if (!ranking.some((p) => p.points)) lines.push('Nobody scored this time.');
    ranking.forEach((p, i) => {
        const prize = { coins: Math.round(p.points / 10), xp: Math.round(p.points / 5) };
        if (p.points) {
            if (i === 0 && ranking.length > 1) rewardWin(p.who, prize);
            else {
                addCoins(p.who, prize.coins);
                addXp(p.who, prize.xp);
            }
        }
        lines.push(`${medal(i)} ${p.text} — ${p.points} pts · ${p.correct}/${game.round} ✓ · best 🔥${p.bestStreak} (+🪙${prize.coins})`);
    });
    await recordGame(game.chat, ranking.map((p) => ({ ...p, name: p.name || p.text }))).catch((e) => log.warn(describeError(e)));
    await game.sock.sendMessage(game.chat, { text: box(NAME, lines), mentions: ranking.map((p) => p.jid) });
    const again = box(NAME, ['Another game?']);
    await sendButtons(game.sock, game.chat, {
        title: '',
        body: again,
        footer: config.bot.footer,
        buttons: [
            { type: 'reply', text: '🔁 Play again', id: `${P}songguess ${game.replay}`.trim() },
            { type: 'reply', text: '🏆 Ranking', id: `${P}songguess rank` }
        ]
    }, { fallbackText: `${again}\n${P}sg ${game.replay}` });
};

const fail = async (game, error) => {
    log.error(`Game failed: ${describeError(error)}`);
    await finish(game, `⚠️ ${error?.expose ? error.message : 'Something went wrong.'}`).catch(() => {});
};

// ── Commands ──────────────────────────────────────────────────────────────

const parseStart = (args) => {
    let rounds = 7;
    let diff = 'normal';
    const words = [];
    for (const a of args) {
        const low = a.toLowerCase();
        if (/^\d{1,2}$/.test(low)) rounds = Math.min(15, Math.max(3, Number(low)));
        else if (DIFFICULTY[low]) diff = low;
        else words.push(a);
    }
    if (words[0]?.toLowerCase() === 'artist') {
        const name = words.slice(1).join(' ').trim();
        if (!name) throw new UserError(`Name the artist: ${P}sg artist Inkonnu`);
        return { source: { artist: name }, rounds, diff };
    }
    const text = words.join(' ').trim();
    const pack = text.toLowerCase();
    if (!text) return { source: { pack: 'hits' }, rounds, diff };
    return { source: PACKS[pack] ? { pack } : { query: text }, rounds, diff };
};

const startGame = async (sock, m, args) => {
    if (games.has(m.chat)) return m.reply(box(NAME, ['A game is already running here.', `${P}sg stop to end it.`]));
    if (games.size >= MAX_GAMES) return m.reply(box(NAME, ['Too many games are running right now. Try again in a few minutes.']));
    const { source, rounds, diff } = parseStart(args);
    const game = { sock, chat: m.chat, starter: personKey(senderOf(m)), rounds, diff: DIFFICULTY[diff], players: {}, round: 0, silent: 0, over: false, current: null, replay: args.join(' ') };
    games.set(m.chat, game); // reserve the chat while loading
    try {
        await react(sock, m, '🎶');
        const pool = await loadPool(source);
        const played = recent.get(m.chat) || [];
        const fresh = pool.tracks.filter((t) => !played.includes(t.id));
        const usable = fresh.length >= rounds + 3 ? fresh : pool.tracks;
        if (usable.length < 6) throw new UserError('Not enough songs with previews for that. Try another pack or artist.');
        Object.assign(game, { title: pool.title, artistMode: pool.artistMode, tracks: pool.tracks, queue: shuffle(usable) });
        game.rounds = Math.min(rounds, game.queue.length);
        recent.set(m.chat, [...played, ...game.queue.slice(0, game.rounds + 3).map((t) => t.id)].slice(-RECENT_LIMIT));
        await m.reply(box(NAME, [
            `${pool.title} · ${game.rounds} rounds · ${game.diff.label}`,
            `🎧 ${game.diff.clip} s clip, ${game.diff.window} s to answer`,
            '⚡ faster = more points · 🔥 streaks add a bonus',
            'Everyone can play: tap an option or type 1–4.',
            '',
            '▶️ First song coming up…'
        ]));
        game.next = prepare(game);
        await playRound(game);
    } catch (error) {
        games.delete(m.chat);
        game.over = true;
        throw error;
    }
};

const canControl = async (game, m, ctx) => game.starter === personKey(senderOf(m)) || ctx.access?.isOwner || (await ctx.access?.isAdmin?.());

const showMenu = (sock, m) => {
    const rows = Object.entries(PACKS).map(([key, p]) => ({ id: `${P}songguess ${key}`, title: `${p.icon} ${p.label}`, description: `${P}sg ${key}` }));
    const menu = {
        title: NAME,
        body: box(NAME, [
            'Hear a clip, pick the song. Fast answers and streaks score more.',
            '',
            `${P}sg <pack> [rounds] [easy|hard]`,
            `${P}sg artist <name>  → songs of one artist`,
            `${P}sg <anything>  → e.g. ${P}sg cheb khaled`,
            `${P}sg rank · ${P}sg rank global · ${P}sg me`,
            `${P}sg skip · ${P}sg stop`
        ]),
        footer: config.bot.footer,
        buttonText: '🎵 Pick a pack',
        sections: [
            { title: 'Packs', rows },
            { title: 'Scores', rows: [{ id: `${P}songguess rank`, title: '🏆 Group ranking' }, { id: `${P}songguess rank global`, title: '🌍 Global ranking' }, { id: `${P}songguess me`, title: '👤 My stats' }] }
        ]
    };
    return sendListMenu(sock, m.chat, menu, { quoted: m.raw });
};

const showRank = async (m, global) => {
    const top = await topPlayers(global ? null : m.chat, 10);
    if (!top.length) return m.reply(box(NAME, ['No scores yet. Start a game!']));
    return m.reply(box(global ? '🌍 GLOBAL RANKING' : '🏆 GROUP RANKING', top.map((p, i) => `${medal(i)} ${p.name || p.jid.split('@')[0]} — ${p.points} pts · ${p.wins} wins · ${p.correct}/${p.answered} ✓`)));
};

const showMe = async (m) => {
    const s = await statsOf(senderOf(m));
    if (!s) return m.reply(box(NAME, ['You have not played yet.']));
    const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
    return m.reply(box('👤 MY SONG STATS', [`🏅 #${s.rank} of ${s.players}`, `⭐ ${s.points} pts in ${s.games} games`, `🏆 ${s.wins} wins`, `🎯 ${s.correct}/${s.answered} right (${acc}%)`, `🔥 best streak ${s.bestStreak}`]));
};

const handleCommand = async (sock, m, args, ctx) => {
    const sub = String(args[0] || '').toLowerCase();
    const game = games.get(m.chat);
    if (sub === 'pick') {
        if (!game?.current || game.current.token !== args[1]) return undefined; // old round: ignore quietly
        return answer(game, m, Number(args[2]) - 1);
    }
    if (!sub || sub === 'help' || sub === 'menu') return showMenu(sock, m);
    if (sub === 'rank' || sub === 'top') return showRank(m, String(args[1] || '').toLowerCase() === 'global');
    if (sub === 'me' || sub === 'stats') return showMe(m);
    if (sub === 'stop' || sub === 'end' || sub === 'skip') {
        if (!game) return m.reply(box(NAME, ['No game running.']));
        if (!(await canControl(game, m, ctx))) return m.reply(box(NAME, ['Only the player who started it or an admin can do that.']));
        if (sub === 'skip') return game.current ? endRound(game, game.current.token) : undefined;
        return finish(game, '⏹️ Stopped.');
    }
    return startGame(sock, m, args);
};

/** Typed answers: "1"–"4" or the song title (small typos are fine). */
const handleTyped = async ({ sock, message: m }, api) => {
    const game = games.get(m.chat);
    const cur = game?.current;
    if (!cur?.startedAt || cur.ending || m.selectionId) return;
    const text = String(m.text || '').trim();
    if (!text || text.startsWith(P) || text.length > 80) return;
    let choice = -1;
    if (/^[1-4]$/.test(text)) choice = Number(text) - 1;
    else choice = cur.options.findIndex((t) => titleMatches(text, t.title));
    if (choice < 0 || !api.allows(sock, m)) return;
    game.sock = sock;
    await answer(game, m, choice);
};

export default {
    name: 'songguess',
    version: '1.0.0',
    author: 'NEO BOT',
    description: 'Guess the song from a short clip: packs, artists, speed points, streaks and rankings.',
    commands: [
        {
            name: 'songguess',
            aliases: ['sg', 'guesssong', 'songquiz', 'خمن'],
            category: 'games',
            description: 'Guess the song from a clip (packs, artist mode, rankings).',
            usage: '[pack|artist <name>|<search>] [rounds] [easy|hard] | rank [global] | me | skip | stop',
            examples: ['sg', 'sg arabic', 'sg rap 10 hard', 'sg artist Inkonnu', 'sg rank'],
            permission: 'public',
            cooldown: 0,
            execute: handleCommand
        }
    ],
    hooks: { message: handleTyped },
    async onUnload() {
        for (const game of games.values()) {
            game.over = true;
            clearTimeout(game.current?.timer);
        }
        games.clear();
    }
};
