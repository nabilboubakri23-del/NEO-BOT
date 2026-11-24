import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { box } from '../../utils/formatter.js';
import { UserError, describeError } from '../../utils/errors.js';
import { sendButtons, sendListMenu } from '../../systems/menus/interactiveMenu.js';
import { sendCarousel } from '../../systems/menus/carousel.js';
import { FlowSessions } from '../../systems/interaction/flowSessions.js';
import { captureInput, CANCEL_WORDS } from '../../systems/interaction/inputCapture.js';
import { parsePinLink, pinFromLink, searchPins, SCOPES } from './.pinterest-api.js';
import { classify, rank, searchQueryFor, subjectTerms, tokens } from './.pinterest-rank.js';
import { buildMp3, buildMp4, fetchImage, formatBytes, formatDuration, videoFormats } from './.pinterest-media.js';
import { compact, displayTitle, prepareCards } from './.pinterest-cards.js';

/**
 * .pinterest — smart Pinterest search & download.
 *
 *   .pinterest                    guide + buttons: Images / Edits / Cancel
 *   .pinterest <query>            image search          (also: .pinterest img <query>)
 *   .pinterest edit <query>       fan edits / AMVs      (also: .pinterest video <query>)
 *   .pinterest <pin link>         download one pin (pinterest.com/pin/... or pin.it/...)
 *
 * Results arrive as a swipeable carousel. Image cards show the picture; edit and
 * video cards carry a playable preview. Each card has its own buttons
 * (Download / Copy link / Similar or Audio MP3). Videos can be downloaded in any
 * quality Pinterest offers, as a file, or as MP3 audio.
 * Ranking: relevance to the query + popularity + resolution + Pinterest's order;
 * edits are told apart from ordinary videos by tags, wording and length.
 */

const log = child('pinterest');
const P = () => config.bot.prefix;
const sessions = new FlowSessions({ name: 'Pinterest', command: 'pinterest', maxActive: 2 });
const PAGE = { image: 8, edit: 5, video: 5 };
const MODE_LABEL = { image: 'Images', edit: 'Edits', video: 'Videos' };
const MODE_ALIASES = {
    image: /^(img|image|images|photo|photos|pic|pics|صور|صورة)$/i,
    edit: /^(edit|edits|amv|ايديت|إيديت|ايديتات)$/i,
    video: /^(video|videos|vid|فيديو|فيديوهات)$/i
};

const errorText = (error) => (error?.expose ? error.message : '⚠️ Something went wrong with Pinterest. Try again.');

// ── Screens ─────────────────────────────────────────────────────────────

const home = async (sock, m) => {
    const s = sessions.create(m);
    const body = box('PINTEREST', [
        'Find the best images and edits on Pinterest.',
        '',
        '🖼️ *Images*: wallpapers, characters, aesthetics.',
        `   ${P()}pinterest naruto wallpaper`,
        '🎬 *Edits*: fan edits, AMVs, velocity clips,',
        '   with a preview you can watch first.',
        `   ${P()}pinterest edit gojo`,
        '🔗 Or send a pin link to download it.',
        '',
        'Tap a button, then just type what you want.'
    ]);
    return sendButtons(sock, m.chat, {
        title: 'Pinterest',
        body,
        footer: 'Ranked by relevance and popularity',
        buttons: [
            { type: 'reply', text: '🖼️ Images', id: `pinterest:mode:${s.token}:image` },
            { type: 'reply', text: '🎬 Edits', id: `pinterest:mode:${s.token}:edit` },
            { type: 'reply', text: '↩️ Back / Cancel', id: `pinterest:cancel:${s.token}` }
        ]
    }, { quoted: m.raw, fallbackText: `${body}\n\n${P()}pinterest <query>\n${P()}pinterest edit <query>\n${P()}pinterest cancel` });
};

const askQuery = async (sock, m, token, mode) => {
    sessions.expect(m, token, mode);
    const s = sessions.get(m, token);
    s.mode = mode;
    const body = mode === 'image'
        ? box('PINTEREST • IMAGES', ['Type what you are looking for now.', 'A character, a theme, a style...', '', 'Example: gojo satoru aesthetic', 'Waiting 2 minutes.'])
        : box(`PINTEREST • ${MODE_LABEL[mode].toUpperCase()}`, ['Type the character, anime, player or theme now.', '', 'Example: itachi uchiha', 'Waiting 2 minutes.']);
    return sendButtons(sock, m.chat, {
        title: 'Pinterest',
        body,
        buttons: [
            { type: 'reply', text: '↩️ Back', id: `pinterest:home:${token}` },
            { type: 'reply', text: '✖️ Cancel', id: `pinterest:cancel:${token}` }
        ]
    }, { quoted: m.raw, fallbackText: `${body}\n${P()}pinterest cancel` });
};

const controls = (sock, m, s, shown) => {
    const more = s.offset < s.items.length || s.bookmark;
    const buttons = [
        ...(more ? [{ type: 'reply', text: '➕ More results', id: `pinterest:more:${s.token}` }] : []),
        { type: 'reply', text: '🔄 New search', id: `pinterest:new:${s.token}` },
        { type: 'reply', text: '✖️ Close', id: `pinterest:cancel:${s.token}` }
    ];
    return sendButtons(sock, m.chat, {
        title: '',
        body: `📌 ${shown} ${MODE_LABEL[s.mode].toLowerCase()} for “${s.query}”. Results stay active for 5 minutes.`,
        buttons
    }, { quoted: m.raw });
};

// ── Search ──────────────────────────────────────────────────────────────

const status = async (sock, m, text) => {
    const sent = await m.reply(text).catch(() => null);
    return (next) => (sent?.key ? sock.sendMessage(m.chat, { text: next, edit: sent.key }).catch(() => {}) : m.reply(next).catch(() => {}));
};

/** Fetches and ranks enough candidates for the next page. */
const fill = async (s) => {
    const need = s.offset + PAGE[s.mode];
    let tries = 0;
    while (s.items.length < need && (s.bookmark !== null || !s.started) && tries < 3) {
        tries += 1;
        const page = await searchPins(searchQueryFor(s.query, s.mode), SCOPES[s.mode], { pages: s.started ? 1 : 2, bookmark: s.bookmark });
        s.started = true;
        s.bookmark = page.bookmark;
        const known = new Set(s.items.map((r) => r.pin.id));
        s.pool.push(...page.pins.filter((p) => !known.has(p.id)));
        const ranked = rank(s.pool, s.query, s.mode, { want: need });
        // Keep already-shown items fixed; append the best new ones.
        const shown = new Set(s.items.map((r) => r.pin.id));
        s.items.push(...ranked.filter((r) => !shown.has(r.pin.id)));
        if (!s.bookmark) break;
    }
};

const showPage = async (sock, m, s, update) => {
    await fill(s);
    if (s.offset >= s.items.length) {
        throw new UserError(s.offset ? 'No more results for this search.' : `No ${MODE_LABEL[s.mode].toLowerCase()} found for “${s.query}”. Try other words.`);
    }
    if (s.mode !== 'image') await update(`🎬 Found ${MODE_LABEL[s.mode].toLowerCase()} for “${s.query}”. Preparing previews...`);
    const { cards, indexes } = await prepareCards(sock, s, s.offset, PAGE[s.mode]);
    s.offset += PAGE[s.mode];
    if (s.cancelled) return;
    if (!cards.length) throw new UserError('Pinterest media did not load in time. Tap More results or try again.');
    const page = Math.ceil(s.offset / PAGE[s.mode]);
    await sendCarousel(sock, m.chat, {
        body: `*Pinterest • ${MODE_LABEL[s.mode]}* for “${s.query}”\nTop picks by relevance and popularity. Swipe ← → and use the buttons under each card.${page > 1 ? `\nPage ${page}` : ''}`,
        footer: `${config.bot.name} • Pinterest`,
        cards
    }, { quoted: m.raw });
    await update(`✅ ${cards.length} ${MODE_LABEL[s.mode].toLowerCase()} for “${s.query}”.`);
    s.shownIndexes.push(...indexes);
    await controls(sock, m, s, cards.length);
};

const search = (sock, m, query, mode) => sessions.run(m, 'search', 4_000, async () => {
    const q = query.trim();
    if (q.length < 2 || q.length > 100) throw new UserError('Type 2 to 100 characters to search.');
    const s = sessions.create(m);
    Object.assign(s, { mode, query: q, items: [], pool: [], offset: 0, bookmark: null, started: false, formats: {}, shownIndexes: [] });
    await m.react?.('🔎');
    const update = await status(sock, m, `🔎 Searching Pinterest ${MODE_LABEL[mode].toLowerCase()} for “${q}”...`);
    try {
        await showPage(sock, m, s, update);
        await m.react?.('✅');
    } catch (error) {
        await m.react?.('❌');
        await update(`❌ ${errorText(error)}`);
        if (!error?.expose) log.warn(`Pinterest search failed: ${describeError(error)}`);
    }
});

const more = (sock, m, token) => sessions.run(m, 'search', 4_000, async () => {
    const s = sessions.touch(sessions.get(m, token));
    const update = await status(sock, m, `🔎 Loading more ${MODE_LABEL[s.mode].toLowerCase()}...`);
    try {
        await showPage(sock, m, s, update);
    } catch (error) {
        await update(`❌ ${errorText(error)}`);
    }
});

const similar = async (sock, m, token, index) => {
    const s = sessions.get(m, token);
    const item = s.items[Number(index)];
    if (!item) throw new UserError('Invalid choice. Search again.');
    const base = subjectTerms(s.query);
    const extra = [...item.pin.hashtags, ...tokens(displayTitle(item.pin))].filter((t) => t.length > 2 && !base.includes(t) && /^[\p{L}\p{N}]+$/u.test(t)).slice(0, 2);
    return search(sock, m, [...base, ...extra].join(' ') || s.query, s.mode);
};

// ── Downloads ───────────────────────────────────────────────────────────

const caption = (pin, extra = []) => [
    `📌 *${displayTitle(pin).slice(0, 120)}*`,
    pin.author ? `👤 ${pin.author}` : '',
    ...extra,
    `🔗 ${pin.url}`
].filter(Boolean).join('\n');

const sendImage = async (sock, m, pin) => {
    await m.react?.('⏳');
    const buffer = await fetchImage(pin, { full: true });
    await sock.sendMessage(m.chat, {
        image: buffer,
        caption: caption(pin, [`❤️ ${compact(pin.reactions)}${pin.width ? ` • 📐 ${pin.width}×${pin.height}` : ''} • ${formatBytes(buffer.length)}`])
    }, { quoted: m.raw });
    await m.react?.('✅');
};

const formatsOf = async (s, pin) => s.formats?.[pin.id] || ((s.formats ||= {})[pin.id] = await videoFormats(pin));

/** Quality picker for a video pin. */
const chooseQuality = async (sock, m, s, index) => {
    const { pin } = s.items[index];
    const formats = await formatsOf(s, pin);
    const best = formats.variants.at(-1);
    return sendListMenu(sock, m.chat, {
        title: 'Choose quality',
        body: box('PINTEREST • DOWNLOAD', [
            `${classify(pin).type === 'edit' ? '🎬' : '🎥'} ${displayTitle(pin).slice(0, 80)}`,
            pin.video.duration ? `⏱️ ${formatDuration(pin.video.duration)}` : '',
            `Available: ${formats.variants.map((v) => v.label).join(', ')}`,
            '',
            'Higher quality = bigger file, slower to send.'
        ].filter((l) => l !== '')),
        footer: `${config.bot.name} • Pinterest`,
        buttonText: 'Select quality',
        sections: [
            {
                title: 'Video',
                rows: [...formats.variants].reverse().map((v) => {
                    const i = formats.variants.indexOf(v);
                    return { id: `pinterest:q:${s.token}:${index}:${i}`, title: `🎞️ ${v.label}${v === best ? ' (best)' : ''}`, description: `${v.width}×${v.height} • about ${formatBytes(v.estBytes)}` };
                })
            },
            {
                title: 'Other formats',
                rows: [
                    { id: `pinterest:q:${s.token}:${index}:doc`, title: `📄 ${best.label} as file`, description: 'Original quality, no WhatsApp compression' },
                    ...(formats.audio ? [{ id: `pinterest:q:${s.token}:${index}:mp3`, title: '🎵 Audio only (MP3)', description: 'Just the sound of the edit' }] : [])
                ]
            }
        ]
    }, { quoted: m.raw });
};

const sendVideo = async (sock, m, s, index, choice) => {
    const { pin } = s.items[index];
    const formats = await formatsOf(s, pin);
    await m.react?.('⏳');
    const update = await status(sock, m, `⏳ Downloading ${choice === 'mp3' ? 'audio' : 'video'}: ${displayTitle(pin).slice(0, 60)}...`);
    try {
        if (choice === 'mp3') {
            const mp3 = await buildMp3(formats.audio);
            await sock.sendMessage(m.chat, { audio: mp3, mimetype: 'audio/mpeg', fileName: `${displayTitle(pin).slice(0, 60)}.mp3` }, { quoted: m.raw });
            await update(`✅ Audio sent • ${formatBytes(mp3.length)}`);
        } else {
            const variant = choice === 'doc' ? formats.variants.at(-1) : formats.variants[Number(choice)];
            if (!variant) throw new UserError('That quality is not available.');
            const mp4 = await buildMp4(variant, formats.audio);
            const details = [`⏱️ ${formatDuration(pin.video.duration)} • 🎞️ ${variant.label} • ${formatBytes(mp4.length)}`];
            const content = choice === 'doc'
                ? { document: mp4, mimetype: 'video/mp4', fileName: `${displayTitle(pin).slice(0, 60)} ${variant.label}.mp4`, caption: caption(pin, details) }
                : { video: mp4, mimetype: 'video/mp4', caption: caption(pin, details) };
            await sock.sendMessage(m.chat, content, { quoted: m.raw });
            await update(`✅ Sent ${variant.label} • ${formatBytes(mp4.length)}`);
        }
        await m.react?.('✅');
    } catch (error) {
        await m.react?.('❌');
        await update(`❌ ${errorText(error)}`);
        if (!error?.expose) log.warn(`Pinterest video failed: ${describeError(error)}`);
    }
};

const itemAt = (m, token, index) => {
    const s = sessions.touch(sessions.get(m, token));
    const i = Number(index);
    if (!/^\d+$/.test(String(index)) || !s.items?.[i]) throw new UserError('Invalid choice. Search again.');
    return { s, i };
};

const get = (sock, m, token, index) => sessions.run(m, 'pick', 2_000, async () => {
    const { s, i } = itemAt(m, token, index);
    return s.items[i].type === 'image' ? sendImage(sock, m, s.items[i].pin) : chooseQuality(sock, m, s, i);
});

const quality = (sock, m, token, index, choice) => sessions.run(m, 'download', 5_000, async () => {
    const { s, i } = itemAt(m, token, index);
    if (!/^(\d+|doc|mp3)$/.test(String(choice))) throw new UserError('Invalid quality.');
    return sendVideo(sock, m, s, i, choice);
});

const fromLink = (sock, m, text) => sessions.run(m, 'download', 5_000, async () => {
    await m.react?.('🔗');
    const pin = await pinFromLink(text);
    if (pin.kind === 'image') return sendImage(sock, m, pin);
    const s = sessions.create(m);
    const type = classify(pin).type;
    Object.assign(s, { mode: type, query: displayTitle(pin), items: [{ pin, type, score: 0, relevance: 1, editScore: 0 }], pool: [], offset: 1, bookmark: null, formats: {}, shownIndexes: [0] });
    return chooseQuality(sock, m, s, 0);
});

const cancel = (m) => {
    const had = sessions.cancel(m);
    return m.reply(had ? '✖️ Pinterest closed.' : 'Nothing to cancel. Send .pinterest to start.');
};

/** Any free text: a pin link downloads, otherwise search in the given mode. */
const handleInput = (sock, m, text, mode = 'image') => (parsePinLink(text) ? fromLink(sock, m, text) : search(sock, m, text, mode));

captureInput({
    tag: 'command:pinterest:input',
    sessions,
    onInput: (sock, m, text, mode) => handleInput(sock, m, text, mode),
    onCancel: (sock, m) => cancel(m),
    onError: (sock, m, error) => m.reply(`❌ ${errorText(error)}`).catch(() => {})
});

// ── Command ─────────────────────────────────────────────────────────────

export default {
    name: 'pinterest',
    aliases: ['pint', 'pins', 'بنترست', 'بينترست'],
    category: 'download',
    permission: 'public',
    description: 'Smart Pinterest search: top images and edits as swipeable cards, with previews and quality choice.',
    usage: '[query | edit <query> | video <query> | pin link | cancel]',
    examples: ['pinterest', 'pinterest naruto wallpaper', 'pinterest edit gojo', 'pinterest https://pin.it/xxxx'],
    cooldown: 3,
    minArgs: 0,

    async execute(sock, m, args, ctx = {}) {
        const input = (ctx.argsText || args.join(' ')).trim();
        if (!input) return home(sock, m);
        if (CANCEL_WORDS.test(input)) return cancel(m);
        const first = args[0] || '';
        const mode = Object.keys(MODE_ALIASES).find((k) => MODE_ALIASES[k].test(first));
        if (mode) {
            const rest = input.slice(first.length).trim();
            if (!rest) {
                const s = sessions.create(m);
                return askQuery(sock, m, s.token, mode);
            }
            return handleInput(sock, m, rest, mode);
        }
        return handleInput(sock, m, input, 'image');
    },

    async onSelect(sock, m, parts) {
        const [action, token, a, b] = parts;
        if (action === 'cancel') {
            const current = sessions.peek(m);
            if (current && current.token !== token) throw new UserError('This Pinterest menu expired. Use the newest one or send .pinterest again.');
            return cancel(m);
        }
        if (action === 'home') { sessions.get(m, token); return home(sock, m); }
        if (action === 'mode' && MODE_LABEL[a]) return askQuery(sock, m, token, a);
        if (action === 'new') { const s = sessions.get(m, token); return askQuery(sock, m, token, s.mode || 'image'); }
        if (action === 'more') return more(sock, m, token);
        if (action === 'get') return get(sock, m, token, a);
        if (action === 'mp3') return quality(sock, m, token, a, 'mp3');
        if (action === 'q') return quality(sock, m, token, a, b);
        if (action === 'sim') return similar(sock, m, token, a);
        throw new UserError('Invalid choice. Send .pinterest again.');
    }
};

export { sessions as pinterestSessions };
