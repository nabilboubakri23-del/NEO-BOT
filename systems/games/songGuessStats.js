import docStore from '../database/docStore.js';
import { personKey } from '../../utils/targets.js';

/**
 * Lasting guess-the-song scores, per group and across all chats.
 * doc "songguess": { chats: { <chat>: { <person>: Stat } }, global: { <person>: Stat } }
 * Stat: { name, jid, points, correct, answered, games, wins, bestStreak }
 */

const NAME = 'songguess';
let doc = null;

const load = async () => (doc ||= await docStore.open(NAME, () => ({ chats: {}, global: {} })));

const blank = () => ({ name: '', jid: '', points: 0, correct: 0, answered: 0, games: 0, wins: 0, bestStreak: 0 });

const apply = (table, key, p, won) => {
    const s = (table[key] ||= blank());
    s.name = p.name || s.name;
    s.jid = p.jid || s.jid;
    s.points += p.points;
    s.correct += p.correct;
    s.answered += p.answered;
    s.games += 1;
    if (won) s.wins += 1;
    s.bestStreak = Math.max(s.bestStreak, p.bestStreak);
};

/** Saves a finished game. players: [{ who, name, jid, points, correct, answered, bestStreak }] sorted by points. */
export const recordGame = async (chat, players) => {
    await load();
    const table = (doc.chats[chat] ||= {});
    players.forEach((p, i) => {
        const key = personKey(p.who);
        if (!key) return;
        const won = p.won ?? (i === 0 && p.points > 0 && players.length > 1);
        apply(table, key, p, won);
        apply(doc.global, key, p, won);
    });
    docStore.touch(NAME);
};

/** Top players of a chat (or of every chat when chat is null). */
export const topPlayers = async (chat, limit = 10) => {
    await load();
    const table = chat ? doc.chats[chat] || {} : doc.global;
    return Object.values(table).sort((a, b) => b.points - a.points).slice(0, limit);
};

/** One person's lasting stats and global position. */
export const statsOf = async (who) => {
    await load();
    const key = personKey(who);
    const s = doc.global[key];
    if (!s) return null;
    const rank = Object.values(doc.global).filter((x) => x.points > s.points).length + 1;
    return { ...s, rank, players: Object.keys(doc.global).length };
};
