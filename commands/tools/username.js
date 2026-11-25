import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { MODES, choose, generateCandidates, isValidUsername, normalize, scoreUsername } from '../../systems/usernames/candidates.js';
import { aiIdeas, aiRank } from '../../systems/usernames/aiRank.js';
import { LIMITS, cached, checkNames, isBusy, quotaLeft } from '../../systems/usernames/checker.js';
import { isAiEnabled } from '../../systems/ai/aiClient.js';
import { IG_LIMITS, igCached, igCheckNames } from '../../systems/usernames/instagram.js';

/**
 * .username / .wu — finds WhatsApp usernames with no account on them yet.
 *   .wu 3                    triple (3 chars)
 *   .wu 4                    quad
 *   .wu semi                 triple-like: a.bc  ab_c  abc_
 *   .wu ai <theme>           AI ideas around a theme
 *   .wu check a b c          check names you already have (max 10)
 * Options: n:20 (how many to check, max 25), l (letters only), start:x end:x has:x shape:aba
 * Instagram filter (default on, ig:off to skip): names that match an Instagram account are
 * dropped first, because WhatsApp refuses them. Search modes then show only names free on both.
 * Results are ranked best → worst (local score + AI score when AI is set up).
 */

const P = () => config.bot.prefix;
const DEFAULT_N = 15;
let active = false; // one search at a time (Instagram + WhatsApp phases)

/** Parses "3 n:20 l start:a shape:aba" → { mode, n, filters, theme, names }. */
export const parseArgs = (args) => {
    const out = { mode: null, n: DEFAULT_N, filters: {}, theme: '', names: [], ig: true };
    const words = [];
    for (const raw of args) {
        const a = String(raw).toLowerCase();
        let m;
        if (!out.mode && ['3', '4', 'semi', 'ai', 'check'].includes(a)) out.mode = a;
        else if (!out.mode && ['ثلاثي', 'تلاثي'].includes(a)) out.mode = '3';
        else if (!out.mode && a === 'رباعي') out.mode = '4';
        else if (!out.mode && ['شبه', 'شبيه'].includes(a)) out.mode = 'semi';
        else if ((m = a.match(/^n[:=](\d{1,3})$/))) out.n = Math.max(1, Math.min(LIMITS.perRun, Number(m[1])));
        else if (a === 'ig:off' || a === 'noig') out.ig = false;
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
        'Options: n:20  l (letters only)  start:a  end:x  has:z  shape:aba  ig:off',
        'Names used on Instagram are skipped (WhatsApp refuses them). Most 3-4 letter names are taken there, so expect few hits.',
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

const ICON = { free: '✅', taken: '❌', instagram: '📸', unknown: '⚠️' };

/** Free first, then taken, then unknown; each best score first. */
export const orderResults = (rows) => {
    const rank = { free: 0, taken: 1, instagram: 2, unknown: 3 };
    return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score);
};

export const formatResults = (rows, { ai, stopped, reason, mode, onlyFree = false, igChecked = 0, igFree = 0, ig = true }) => {
    const ordered = orderResults(rows);
    const free = ordered.filter((r) => r.status === 'free');
    const shown = onlyFree ? free : ordered;
    const lines = shown.map((r, i) => `${i + 1}. ${ICON[r.status]} @${r.u}  ⭐${r.score}${r.tag ? `  · ${r.tag}` : ''}`);
    const why = { 'daily-limit': 'Daily limit reached.', 'rate-limited': 'WhatsApp slowed the lookups, stopped early.', 'not-allowed': 'WhatsApp refused username lookups for this number (usernames may not be live in its region yet).', errors: 'Too many errors, stopped early.', 'ig-stopped': 'Instagram slowed the checks, stopped early.' };
    const counts = onlyFree
        ? `📸 ${igChecked} checked on Instagram · ${igFree} not on Instagram · ✅ ${free.length} free on WhatsApp too`
        : `✅ ${free.length} free · ❌ ${ordered.filter((r) => r.status === 'taken').length} taken${ig ? ` · 📸 ${ordered.filter((r) => r.status === 'instagram').length} on Instagram` : ''}`;
    return [
        `Mode: ${MODES[mode] || 'Check'}${ai ? ' · AI ranked' : ''}${ig ? ' · Instagram filter' : ''}`,
        counts,
        '',
        ...(lines.length ? lines : ['No free names this round. Tap More or loosen the options (digits, semi, 4).']),
        ...(stopped ? ['', `⚠️ ${why[reason] || 'Stopped early.'}`] : []),
        '',
        `✅ = no WhatsApp account${ig ? ' and no Instagram account' : ''}. Confirm in WhatsApp > Settings > Account > Username (Facebook pages can also hold a name).`
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
        if (active || isBusy()) throw new UserError('A username search is already running. Wait for it to finish.');
        active = true;
        try {
            return await run(sock, m, opts);
        } finally {
            active = false;
        }
    }
};

const run = async (sock, m, opts) => {
    const left = await quotaLeft();
    if (!left) throw new UserError(`Daily limit of ${LIMITS.perDay} lookups reached. Try again tomorrow (UTC).`);

    await m.react?.('🔎');
    const pool = await buildPool(opts);
    if (!pool.length) throw new UserError('No valid names match those options. Loosen the filters.');

    // AI ranks the pool before picking, so the lookups go to the most promising names.
    const { list: ranked, ai } = opts.mode === 'check' ? { list: pool, ai: false } : await aiRank(pool);
    const search = opts.mode !== 'check';
    const igOn = opts.ig;

    // 1) Instagram filter (no WhatsApp traffic). Search modes check a bigger batch here.
    let igRows = [];
    let igStopped = false;
    let candidates = ranked;
    if (igOn) {
        let batch = ranked;
        if (search) {
            const skip = new Set();
            for (const c of ranked) if ((await igCached(c.u)) === 'taken' || (await cached(c.u))) skip.add(c.u);
            batch = choose(ranked, IG_LIMITS.perRun, skip);
        }
        if (!batch.length) throw new UserError('Every name for these options was checked recently. Change the options.');
        const igStatus = await m.reply(`📸 Checking ${batch.length} names on Instagram…`).catch(() => null);
        const ig = await igCheckNames(batch.map((c) => c.u), {
            onProgress: (done, total) => { if (igStatus?.key && done % 10 === 0 && done < total) sock.sendMessage(m.chat, { text: `📸 Instagram… ${done}/${total}`, edit: igStatus.key }).catch(() => {}); }
        });
        if (ig.blind) {
            if (igStatus?.key) sock.sendMessage(m.chat, { text: '❌ Instagram check blocked.', edit: igStatus.key }).catch(() => {});
            throw new UserError('Instagram blocks checks from this server right now, so I cannot filter. Run the bot on Termux (home internet), set IG_SESSIONID on the server, or use ig:off.');
        }
        igStopped = ig.stopped;
        igRows = ig.results;
        const igMap = new Map(igRows.map((r) => [r.u, r.status]));
        const igFreeSet = new Set(igRows.filter((r) => r.status === 'free').map((r) => r.u));
        if (igStatus?.key) sock.sendMessage(m.chat, { text: `📸 ${igFreeSet.size}/${igRows.length} not on Instagram.`, edit: igStatus.key }).catch(() => {});
        candidates = search ? batch.filter((c) => igFreeSet.has(c.u)) : ranked.map((c) => ({ ...c, ig: igMap.get(c.u) || 'unknown' }));
    }

    // 2) WhatsApp lookup on what is left.
    let picked;
    if (!search) picked = candidates.filter((c) => !igOn || c.ig === 'free');
    else if (igOn) picked = candidates.slice(0, Math.min(opts.n, left));
    else {
        const skip = new Set();
        for (const c of ranked) if (await cached(c.u)) skip.add(c.u);
        picked = choose(ranked, Math.min(opts.n, left), skip);
        if (!picked.length) throw new UserError('Every name for these options was checked recently. Change the options.');
    }

    let res = { results: [], stopped: false, reason: '' };
    if (picked.length) {
        const secs = Math.round(picked.length * (LIMITS.minGapMs + LIMITS.jitterMs / 2) / 1000);
        const status = await m.reply(`🔎 Checking ${picked.length} names on WhatsApp (about ${secs} s)…`).catch(() => null);
        const edit = (text) => (status?.key ? sock.sendMessage(m.chat, { text, edit: status.key }).catch(() => {}) : null);
        try {
            res = await checkNames(sock, picked.map((c) => c.u), {
                onProgress: (done, total) => { if (done % 5 === 0 && done < total) edit(`🔎 Checking… ${done}/${total}`); }
            });
        } catch (error) {
            if (error.busy) throw new UserError('A username search is already running.');
            throw error;
        }
        if (!res.results.length) {
            edit('❌ No lookups done.');
            throw new UserError(res.reason === 'not-allowed' ? 'WhatsApp refused username lookups for this number. Usernames may not be live in its region yet.' : 'WhatsApp did not answer. Try later.');
        }
        edit(`✅ Checked ${res.results.length} names.`);
    }
    const byName = new Map(ranked.map((c) => [c.u, c]));
    const rows = res.results.map((r) => ({ ...byName.get(r.u), status: r.status }));
    if (!search && igOn) for (const c of candidates) if (c.ig !== 'free') rows.push({ ...c, status: c.ig === 'taken' ? 'instagram' : 'unknown' });
    const stoppedAny = res.stopped || igStopped;
    const reason = res.stopped ? res.reason : igStopped ? 'ig-stopped' : '';

    const free = orderResults(rows).filter((r) => r.status === 'free').map((r) => `@${r.u}`);
    const again = [opts.mode, opts.mode === 'ai' ? opts.theme : '', `n:${opts.n}`, opts.filters.letters ? 'l' : '', opts.ig ? '' : 'ig:off',
        ...['start', 'end', 'has', 'shape'].filter((k) => opts.filters[k]).map((k) => `${k}:${opts.filters[k]}`)].filter(Boolean).join(' ');
    const buttons = [];
    if (opts.mode !== 'check') buttons.push({ type: 'reply', text: '🔁 More', id: `${P()}wu ${again}` });
    if (free.length) buttons.push({ type: 'copy', text: '📋 Copy free', code: free.join('\n').slice(0, 500) });
    const body = formatResults(rows, { ai, stopped: stoppedAny, reason, mode: opts.mode, onlyFree: search && igOn, ig: igOn,
        igChecked: igRows.length, igFree: igRows.filter((r) => r.status === 'free').length });
    if (!buttons.length) return m.reply(box('USERNAMES', body.split('\n')));
    return sendButtons(sock, m.chat, { title: 'USERNAMES', body, footer: config.bot.footer, buttons }, { quoted: m.raw, fallbackText: body });
};
