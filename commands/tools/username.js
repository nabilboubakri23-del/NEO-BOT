import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { MODES, choose, generateCandidates, isValidUsername, normalize, scoreUsername } from '../../systems/usernames/candidates.js';
import { aiIdeas, aiRank } from '../../systems/usernames/aiRank.js';
import { LIMITS, cached, checkNames, isBusy, quotaLeft } from '../../systems/usernames/checker.js';
import { isAiEnabled } from '../../systems/ai/aiClient.js';

/**
 * .username / .wu — finds WhatsApp usernames with no account on them yet.
 *   .wu 3                    triple (3 chars)
 *   .wu 4                    quad
 *   .wu semi                 triple-like: a.bc  ab_c  abc_
 *   .wu ai <theme>           AI ideas around a theme
 *   .wu check a b c          check names you already have (max 10)
 * Options: n:20 (how many to check, max 25), l (letters only), start:x end:x has:x shape:aba
 * Results are ranked best → worst (local score + AI score when AI is set up).
 */

const P = () => config.bot.prefix;
const DEFAULT_N = 15;

/** Parses "3 n:20 l start:a shape:aba" → { mode, n, filters, theme, names }. */
export const parseArgs = (args) => {
    const out = { mode: null, n: DEFAULT_N, filters: {}, theme: '', names: [] };
    const words = [];
    for (const raw of args) {
        const a = String(raw).toLowerCase();
        let m;
        if (!out.mode && ['3', '4', 'semi', 'ai', 'check'].includes(a)) out.mode = a;
        else if (!out.mode && ['ثلاثي', 'تلاثي'].includes(a)) out.mode = '3';
        else if (!out.mode && a === 'رباعي') out.mode = '4';
        else if (!out.mode && ['شبه', 'شبيه'].includes(a)) out.mode = 'semi';
        else if ((m = a.match(/^n[:=](\d{1,3})$/))) out.n = Math.max(1, Math.min(LIMITS.perRun, Number(m[1])));
        else if (a === 'l' || a === 'letters') out.filters.letters = true;
        else if ((m = a.match(/^(start|end|has)[:=]([a-z0-9._]{1,3})$/))) out.filters[m[1]] = m[2];
        else if ((m = a.match(/^shape[:=]([a-d]{3,4})$/))) out.filters.shape = m[1];
        else words.push(raw);
    }
    if (out.mode === 'check') out.names = [...new Set(words.map(normalize))].slice(0, 10);
    else out.theme = words.join(' ').slice(0, 60);
    return out;
};

const help = (sock, m) => sendButtons(sock, m.chat, {
    title: 'USERNAME FINDER',
    body: [
        'Finds WhatsApp @usernames with no account on them.',
        '',
        ...Object.entries(MODES).map(([k, v]) => `${P()}wu ${k}  ${v}`),
        `${P()}wu check name1 name2  check your own ideas`,
        '',
        'Options: n:20  l (letters only)  start:a  end:x  has:z  shape:aba',
        `Up to ${LIMITS.perRun} names a run, ${LIMITS.perDay} a day (slow on purpose to keep the bot number safe).`,
        '',
        '"Free" means no account uses it. A name can still be reserved or held for its Instagram/Facebook owner: try it in WhatsApp > Settings > Account > Username.'
    ].join('\n'),
    footer: config.bot.footer,
    buttons: [
        { type: 'reply', text: '3️⃣ Triple', id: `${P()}wu 3` },
        { type: 'reply', text: '4️⃣ Quad', id: `${P()}wu 4` },
        { type: 'reply', text: '✨ Triple-like', id: `${P()}wu semi` }
    ]
}, { quoted: m.raw });

const ICON = { free: '✅', taken: '❌', unknown: '⚠️' };

/** Free first, then taken, then unknown; each best score first. */
export const orderResults = (rows) => {
    const rank = { free: 0, taken: 1, unknown: 2 };
    return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score);
};

export const formatResults = (rows, { ai, stopped, reason, mode }) => {
    const ordered = orderResults(rows);
    const free = ordered.filter((r) => r.status === 'free');
    const lines = ordered.map((r, i) => `${i + 1}. ${ICON[r.status]} @${r.u}  ⭐${r.score}${r.tag ? `  · ${r.tag}` : ''}`);
    const why = { 'daily-limit': 'Daily limit reached.', 'rate-limited': 'WhatsApp slowed the lookups, stopped early.', 'not-allowed': 'WhatsApp refused username lookups for this number (usernames may not be live in its region yet).', errors: 'Too many errors, stopped early.' };
    return [
        `Mode: ${MODES[mode] || 'Check'}${ai ? ' · AI ranked' : ''}`,
        `✅ ${free.length} free · ❌ ${ordered.filter((r) => r.status === 'taken').length} taken`,
        '',
        ...lines,
        ...(stopped ? ['', `⚠️ ${why[reason] || 'Stopped early.'}`] : []),
        '',
        '✅ = no account found. Confirm in WhatsApp > Settings > Account > Username before relying on it.'
    ].join('\n');
};

const buildPool = async (opts) => {
    if (opts.mode === 'check') return opts.names.filter(isValidUsername).map((u) => ({ u, score: scoreUsername(u) }));
    if (opts.mode === 'ai') {
        if (!isAiEnabled()) throw new UserError('AI is not set up on this bot (GROQ_API_KEY). Use .wu 3, .wu 4 or .wu semi.');
        const ideas = await aiIdeas(opts.theme, { filters: opts.filters });
        if (!ideas.length) throw new UserError('The AI gave no usable names. Try another theme.');
        return ideas.map((u) => ({ u, score: scoreUsername(u) })).sort((a, b) => b.score - a.score);
    }
    return generateCandidates(opts.mode, opts.filters, { size: 300 });
};

export default {
    name: 'username',
    aliases: ['wu', 'wauser', 'uname', 'يوزر', 'يوزرات'],
    category: 'tools',
    permission: 'owner',
    description: 'Finds free WhatsApp @usernames (triple, quad, triple-like, AI ideas), ranked best to worst.',
    usage: '<3|4|semi|ai <theme>|check names…> [n:15] [l] [start:x] [end:x] [has:x] [shape:aba]',
    examples: ['wu 3', 'wu 4 l n:20', 'wu semi start:n', 'wu ai gaming', 'wu check neo nabil'],
    cooldown: 20,
    async execute(sock, m, args) {
        const opts = parseArgs(args);
        if (!opts.mode) return help(sock, m);
        if (opts.mode === 'check' && !opts.names.length) throw new UserError(`Send names: ${P()}wu check name1 name2`);
        if (isBusy()) throw new UserError('A username search is already running. Wait for it to finish.');
        const left = await quotaLeft();
        if (!left) throw new UserError(`Daily limit of ${LIMITS.perDay} lookups reached. Try again tomorrow (UTC).`);

        await m.react?.('🔎');
        const pool = await buildPool(opts);
        if (!pool.length) throw new UserError('No valid names match those options. Loosen the filters.');

        // AI ranks the pool before picking, so the lookups go to the most promising names.
        const { list: ranked, ai } = opts.mode === 'check' ? { list: pool, ai: false } : await aiRank(pool);
        const skip = new Set();
        for (const c of ranked) if (opts.mode !== 'check' && (await cached(c.u))) skip.add(c.u);
        const count = Math.min(opts.n, left);
        const picked = opts.mode === 'check' ? ranked : choose(ranked, count, skip);
        if (!picked.length) throw new UserError('Every name for these options was checked recently. Change the options.');

        const secs = Math.round(picked.length * (LIMITS.minGapMs + LIMITS.jitterMs / 2) / 1000);
        const status = await m.reply(`🔎 Checking ${picked.length} names (about ${secs} s)…`).catch(() => null);
        const edit = (text) => (status?.key ? sock.sendMessage(m.chat, { text, edit: status.key }).catch(() => {}) : null);

        let res;
        try {
            res = await checkNames(sock, picked.map((c) => c.u), {
                onProgress: (done, total) => { if (done % 5 === 0 && done < total) edit(`🔎 Checking… ${done}/${total}`); }
            });
        } catch (error) {
            if (error.busy) throw new UserError('A username search is already running.');
            throw error;
        }
        const byName = new Map(picked.map((c) => [c.u, c]));
        const rows = res.results.map((r) => ({ ...byName.get(r.u), status: r.status }));
        if (!rows.length) {
            edit('❌ No lookups done.');
            throw new UserError(res.reason === 'not-allowed' ? 'WhatsApp refused username lookups for this number. Usernames may not be live in its region yet.' : 'WhatsApp did not answer. Try later.');
        }
        edit(`✅ Checked ${rows.length} names.`);

        const free = orderResults(rows).filter((r) => r.status === 'free').map((r) => `@${r.u}`);
        const again = [opts.mode, opts.mode === 'ai' ? opts.theme : '', `n:${opts.n}`, opts.filters.letters ? 'l' : '',
            ...['start', 'end', 'has', 'shape'].filter((k) => opts.filters[k]).map((k) => `${k}:${opts.filters[k]}`)].filter(Boolean).join(' ');
        const buttons = [];
        if (opts.mode !== 'check') buttons.push({ type: 'reply', text: '🔁 More', id: `${P()}wu ${again}` });
        if (free.length) buttons.push({ type: 'copy', text: '📋 Copy free', code: free.join('\n').slice(0, 500) });
        const body = formatResults(rows, { ai, stopped: res.stopped, reason: res.reason, mode: opts.mode });
        if (!buttons.length) return m.reply(box('USERNAMES', body.split('\n')));
        return sendButtons(sock, m.chat, { title: 'USERNAMES', body, footer: config.bot.footer, buttons }, { quoted: m.raw, fallbackText: body });
    }
};
