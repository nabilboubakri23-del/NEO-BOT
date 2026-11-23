import config from '../../config/config.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { getJson } from '../../systems/knowledge/http.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';

/**
 * .quran [surah:ayah] — a verse in Uthmani script with its English meaning
 * (Saheeh International), and a button to hear it recited (Mishary Alafasy).
 * No reference → a random verse. Source: alquran.cloud.
 */

const TOTAL_AYAHS = 6236;
const EDITIONS = 'quran-uthmani,en.sahih,ar.alafasy';

const toWestern = (s) => String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

export const parseRef = (args) => {
    const text = toWestern(args.join(' ')).trim();
    if (!text) return String(1 + Math.floor(Math.random() * TOTAL_AYAHS));
    const m = text.match(/^(\d{1,3})\s*[:\s.]\s*(\d{1,3})$/);
    if (!m) throw new UserError('Use surah:ayah, for example 2:255.');
    const surah = Number(m[1]);
    if (surah < 1 || surah > 114) throw new UserError('Surah must be between 1 and 114.');
    return `${surah}:${Number(m[2])}`;
};

const fetchAyah = async (ref) => {
    const { data } = await getJson(`https://api.alquran.cloud/v1/ayah/${ref}/editions/${EDITIONS}`, {
        ttl: 7 * 24 * 60 * 60 * 1000,
        notFound: 'That verse does not exist.'
    });
    const [ar, en, audio] = data;
    return { ar, en, audio: audio?.audio, surah: ar.surah, number: ar.numberInSurah };
};

export default {
    name: 'quran',
    aliases: ['ayah', 'verse', 'قران', 'آية'],
    category: 'knowledge',
    description: 'A Quran verse with meaning and recitation (random or surah:ayah).',
    usage: '[surah:ayah]',
    examples: ['2:255', '١١٢:١'],
    permission: 'public',
    cooldown: 5,

    async execute(sock, message, args) {
        const ayah = await fetchAyah(parseRef(args));
        const ref = `${ayah.surah.number}:${ayah.number}`;
        const text = box('QURAN', [
            `📖 ${ayah.surah.name}  ·  ${ayah.surah.englishName} ${ref}`,
            '',
            `﴿ ${ayah.ar.text} ﴾`,
            '',
            `“${ayah.en.text}”`,
            '',
            `${ayah.surah.revelationType} · ${ayah.surah.numberOfAyahs} verses · Juz ${ayah.ar.juz}`
        ]);
        const buttons = [];
        if (ayah.audio) buttons.push({ type: 'reply', text: '🔊 Listen', id: `quran:audio:${ref}` });
        if (ayah.number < ayah.surah.numberOfAyahs) buttons.push({ type: 'reply', text: '⏭️ Next verse', id: `${config.bot.prefix}quran ${ayah.surah.number}:${ayah.number + 1}` });
        buttons.push({ type: 'reply', text: '🎲 Random', id: `${config.bot.prefix}quran` });
        await sendButtons(sock, message.chat, { title: 'QURAN', body: text, footer: config.bot.footer, buttons }, { quoted: message.raw, fallbackText: text });
    },

    // id "quran:audio:<surah>:<ayah>"
    async onSelect(sock, message, [action, surah, verse]) {
        const ref = `${surah}:${verse}`;
        if (action !== 'audio' || !/^\d{1,3}:\d{1,3}$/.test(ref)) return;
        const ayah = await fetchAyah(ref);
        if (!ayah.audio?.startsWith('https://cdn.islamic.network/')) throw new UserError('Recitation not available.');
        await sock.sendMessage(message.chat, { audio: { url: ayah.audio }, mimetype: 'audio/mpeg' }, { quoted: message.raw });
    }
};
