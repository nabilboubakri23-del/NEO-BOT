import config from '../../config/config.js';
import { sendButtons } from '../menus/interactiveMenu.js';
import { NoticeLimiter } from '../security/noticeLimiter.js';
import { box } from '../../utils/formatter.js';

/**
 * Command assistant:
 *   "."      → explains that a command name must follow, with examples and buttons
 *   ".pinj"  → "Did you mean .ping?" with a button that runs it
 * Only answers a VERY close typo, so it never talks over other bots or normal chat.
 */

const P = () => config.bot.prefix;
const limiter = new NoticeLimiter(10_000, 2000); // one hint per sender per 10 s

/** Optimal string alignment distance: a swap of two neighbours ("pnig") counts as one edit. */
export const editDistance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
};

const commonPrefix = (a, b) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
};

/** Edits allowed for an input of this length: 1-2 letters none, 3-6 one, 7+ two. */
export const allowedEdits = (length) => (length < 3 ? 0 : length <= 6 ? 1 : 2);

/**
 * The one command `input` was almost certainly meant to be, or null.
 * `names` = [{ name, command }] (aliases included). Ties between different
 * commands are broken by the longer shared start, then the closer length; a real tie answers nothing.
 */
export const closestCommand = (input, names) => {
    const word = String(input || '').toLowerCase();
    const limit = allowedEdits(word.length);
    if (!limit || !/[\p{L}]/u.test(word)) return null;
    let best = [];
    let bestScore = Infinity;
    for (const entry of names) {
        if (Math.abs(entry.name.length - word.length) > limit) continue;
        const score = editDistance(word, entry.name);
        if (score > limit || score === 0) continue;
        if (score < bestScore) [best, bestScore] = [[entry], score];
        else if (score === bestScore) best.push(entry);
    }
    if (!best.length) return null;
    const commands = new Map(best.map((e) => [e.command, e]));
    if (commands.size === 1) return best[0];
    // Longer shared start first, then the same length (a wrong letter beats a missing or extra one).
    const rank = (e) => [commonPrefix(word, e.name), -Math.abs(e.name.length - word.length)];
    const better = (x, y) => {
        const [a, b] = [rank(x), rank(y)];
        return a[0] - b[0] || a[1] - b[1];
    };
    const ranked = [...commands.values()].sort((x, y) => better(y, x));
    return better(ranked[0], ranked[1]) > 0 ? ranked[0] : null;
};

const senderKey = (message) => message.senderNumber || message.sender || message.chat;

/** Reply to a lone prefix ("."). */
export const sendPrefixHelp = async (sock, message, examples = []) => {
    if (!limiter.allow(`bare|${senderKey(message)}`)) return null;
    const p = P();
    const sample = examples.length ? examples : ['menu', 'help', 'ping'];
    const body = box(config.bot.name, [
        '👋 Write a command name right after the dot.',
        '',
        'Examples:',
        ...sample.map((name) => `• ${p}${name}`),
        '',
        `All commands: ${p}menu · Details of one: ${p}help <command>`
    ]);
    return sendButtons(
        sock,
        message.chat,
        {
            title: config.bot.name,
            body,
            footer: config.bot.footer || '',
            buttons: [
                { type: 'reply', text: '📜 Menu', id: `${p}menu` },
                { type: 'reply', text: '📖 Help', id: `${p}help` },
                { type: 'reply', text: '🏓 Ping', id: `${p}ping` }
            ]
        },
        { quoted: message.raw, fallbackText: body }
    );
};

/** Reply to a mistyped command; returns true when a suggestion was sent. */
export const sendSuggestion = async (sock, message, typed, match, argsText = '') => {
    if (!limiter.allow(`typo|${senderKey(message)}`)) return false;
    const p = P();
    const fixed = `${p}${match.command}${argsText ? ` ${argsText}` : ''}`;
    const body = box(config.bot.name, [
        `❓ ${p}${typed} is not a command.`,
        `Did you mean ${p}${match.name}?`,
        ...(match.description ? ['', match.description] : []),
        '',
        `Tap to run it, or type: ${fixed}`
    ]);
    await sendButtons(
        sock,
        message.chat,
        {
            title: config.bot.name,
            body,
            footer: config.bot.footer || '',
            buttons: [
                { type: 'reply', text: `▶️ ${p}${match.name}`.slice(0, 20), id: fixed.slice(0, 200) },
                { type: 'reply', text: '📖 Help', id: `${p}help ${match.command}` }
            ]
        },
        { quoted: message.raw, fallbackText: body }
    );
    return true;
};
