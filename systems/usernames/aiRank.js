import { chat, isAiEnabled } from '../ai/aiClient.js';
import { isValidUsername, normalize, scoreUsername } from './candidates.js';

/**
 * AI help for the username finder. Both functions fall back to the local score when
 * AI is off or answers badly, so the finder always works.
 */

const RANK_PROMPT = `You rate WhatsApp usernames for how valuable they are to own.
High: real English words, names, brandable and pronounceable, clean patterns (aaa, aba, abab), easy to say and type.
Low: random-looking letters, confusing digits, awkward separators.
Answer with JSON only: [{"u":"name","s":0-100,"t":"2-3 word reason"}] for every name given, nothing else.`;

const IDEA_PROMPT = `You suggest short WhatsApp usernames.
Rules: 3 to 6 characters, only a-z, 0-9, "." or "_", at least one letter, no dot at start or end.
Prefer real short words, names and brandable coinages. Answer with JSON only: ["name", ...].`;

/** Pulls the first JSON array out of a model reply. */
export const parseJsonArray = (text) => {
    const s = String(text || '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try {
        const v = JSON.parse(s.slice(start, end + 1));
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
};

/**
 * Re-ranks candidates: final = 40% local + 60% AI. Returns [{ u, score, tag }] best first.
 * Only the first `limit` names go to the AI; the rest keep their local score.
 */
export const aiRank = async (candidates, { limit = 80, chatImpl = chat } = {}) => {
    const base = candidates.map((c) => ({ u: c.u, score: c.score ?? scoreUsername(c.u), tag: '' }));
    if (!isAiEnabled() && chatImpl === chat) return { list: base, ai: false };
    const head = base.slice(0, limit);
    let reply;
    try {
        reply = await chatImpl([{ role: 'user', content: head.map((c) => c.u).join(' ') }], { systemPrompt: RANK_PROMPT });
    } catch {
        return { list: base, ai: false };
    }
    const rated = new Map();
    for (const r of parseJsonArray(reply) || []) {
        const u = normalize(r?.u);
        const s = Number(r?.s);
        if (u && Number.isFinite(s)) rated.set(u, { s: Math.max(0, Math.min(100, s)), t: String(r.t || '').slice(0, 24) });
    }
    if (!rated.size) return { list: base, ai: false };
    const list = base.map((c) => {
        const r = rated.get(c.u);
        return r ? { u: c.u, score: Math.round(c.score * 0.4 + r.s * 0.6), tag: r.t } : c;
    }).sort((a, b) => b.score - a.score);
    return { list, ai: true };
};

/** AI-made name ideas around a theme. Returns valid names only. */
export const aiIdeas = async (theme, { count = 60, filters = {}, chatImpl = chat } = {}) => {
    if (!isAiEnabled() && chatImpl === chat) return [];
    const ask = `Theme: ${String(theme || 'anything cool').slice(0, 60)}. Give ${count} names.` +
        (filters.start ? ` Start with "${filters.start}".` : '') + (filters.end ? ` End with "${filters.end}".` : '');
    let reply;
    try {
        reply = await chatImpl([{ role: 'user', content: ask }], { systemPrompt: IDEA_PROMPT });
    } catch {
        return [];
    }
    const seen = new Set();
    for (const v of parseJsonArray(reply) || []) {
        const u = normalize(v);
        if (u.length <= 8 && isValidUsername(u)) seen.add(u);
    }
    return [...seen];
};
