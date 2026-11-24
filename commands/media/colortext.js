import crypto from 'node:crypto';
import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { makeSticker } from '../../systems/media/sticker.js';
import { FONTS } from '../../systems/media/fonts.js';
import { COLORS, CYCLE, cleanText, parseColor, pickFont, renderColorText } from '../../systems/media/colorText.js';

/**
 * .colortext — text on a coloured card, like a WhatsApp text status.
 *   .ct Hello                      random colour, font 1
 *   .ct red 2 السلام عليكم          background + font
 *   .ct navy/gold 3 NEO BOT         background/text colour
 *   .ct s pink Hi                   as a sticker
 *   (reply to a message with .ct [options] to use its text)
 * Buttons on the card: next colour, next font, sticker.
 */

const P = () => config.bot.prefix;
const CARDS = new Map(); // token → spec, so buttons can re-render without putting the text in the id
const TTL = 30 * 60_000;
const MAX_CARDS = 300;

const remember = (spec) => {
    const now = Date.now();
    for (const [k, v] of CARDS) if (v.expires < now || CARDS.size >= MAX_CARDS) CARDS.delete(k);
    const token = crypto.randomBytes(5).toString('hex');
    CARDS.set(token, { ...spec, expires: now + TTL });
    return token;
};

const help = (m) => m.reply(box('COLOR TEXT', [
    'Your text on a coloured card.',
    '',
    `${P()}ct <text>`,
    `${P()}ct red 2 <text>      colour + font`,
    `${P()}ct navy/gold <text>  background/text colour`,
    `${P()}ct s <text>          as a sticker`,
    'Reply to a message with .ct to use its text.',
    '',
    `Colours: ${Object.keys(COLORS).join(', ')} or #hex`,
    'Fonts:',
    ...FONTS.map((f) => `${f.id}. ${f.name} (${f.style}${f.arabic ? ', Arabic' : ''})`)
]));

/** Reads leading options (colour[/colour], font 1-6, s) and returns them with the remaining text. */
export const parseOptions = (raw) => {
    const opts = { bg: null, fg: null, font: null, sticker: false };
    let rest = String(raw || '').trim();
    for (let i = 0; i < 3; i += 1) {
        const m = rest.match(/^(\S+)(?:\s+|$)/);
        if (!m) break;
        const tok = m[1];
        const [a, b] = tok.split('/');
        if (!opts.sticker && /^(s|sticker|ملصق)$/i.test(tok)) opts.sticker = true;
        else if (!opts.font && /^[1-6]$/.test(tok)) opts.font = Number(tok);
        else if (!opts.bg && parseColor(a) && (b === undefined || parseColor(b))) {
            opts.bg = parseColor(a);
            opts.fg = b ? parseColor(b) : null;
        } else break;
        rest = rest.slice(m[0].length);
    }
    return { ...opts, text: rest };
};

const send = async (sock, m, spec) => {
    const png = await renderColorText(spec);
    if (spec.sticker) return sock.sendMessage(m.chat, { sticker: await makeSticker(png, { kind: 'image' }) }, { quoted: m.raw });
    const token = remember(spec);
    const fontName = spec.font.name;
    const notes = [spec.swapped ? 'Arabic text: switched to an Arabic font.' : '', spec.droppedEmoji ? 'Emoji removed (fonts have none).' : ''].filter(Boolean);
    const caption = [`🎨 ${fontName}`, ...notes].join('\n');
    return sendButtons(sock, m.chat, {
        title: '',
        image: png,
        body: caption,
        footer: config.bot.footer,
        buttons: [
            { type: 'reply', text: '🎨 Color', id: `${P()}colortext again ${token} color` },
            { type: 'reply', text: '🔤 Font', id: `${P()}colortext again ${token} font` },
            { type: 'reply', text: '🖼️ Sticker', id: `${P()}colortext again ${token} sticker` }
        ]
    }, { quoted: m.raw, fallbackText: caption });
};

const again = async (sock, m, token, what) => {
    const prev = CARDS.get(token);
    if (!prev || prev.expires < Date.now()) throw new UserError(`That card expired. Send ${P()}ct again.`);
    const spec = { ...prev, sticker: false, swapped: false };
    if (what === 'sticker') spec.sticker = true;
    else if (what === 'font') {
        let id = spec.font.id;
        do { id = (id % FONTS.length) + 1; } while (!FONTS[id - 1].arabic && /[\u0600-\u06FF]/.test(spec.text));
        spec.font = FONTS[id - 1];
    } else {
        const i = CYCLE.findIndex((n) => COLORS[n] === spec.bg);
        spec.bg = COLORS[CYCLE[(i + 1) % CYCLE.length]];
        spec.fg = null;
    }
    return send(sock, m, spec);
};

export default {
    name: 'colortext',
    aliases: ['ct', 'ctext', 'نص_ملون', 'لون'],
    category: 'media',
    permission: 'public',
    description: 'Your text on a coloured card (6 fonts, any colour), as a picture or sticker.',
    usage: '[colour[/text colour]] [font 1-6] [s] <text>',
    examples: ['ct Good morning', 'ct purple 2 السلام عليكم', 'ct navy/gold 3 NEO BOT', 'ct s pink hi'],
    cooldown: 5,
    async execute(sock, m, args, ctx) {
        if (args[0] === 'again' && args[1]) return again(sock, m, args[1], args[2]);
        const raw = [ctx.argsText, ctx.body].filter(Boolean).join('\n');
        const opts = parseOptions(raw);
        const source = opts.text || m.quoted?.text || '';
        if (!source.trim()) return help(m);
        const { text, droppedEmoji } = cleanText(source);
        if (!text) throw new UserError('Nothing left to draw (emoji only?). Send some words.');
        const { font, swapped } = pickFont(opts.font || 1, text);
        const bg = opts.bg || COLORS[CYCLE[Math.floor(Math.random() * CYCLE.length)]];
        await m.react?.('🎨');
        return send(sock, m, { text, bg, fg: opts.fg, font, sticker: opts.sticker, swapped: swapped && Boolean(opts.font), droppedEmoji });
    }
};
