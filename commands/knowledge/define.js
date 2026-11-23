import { getJson, isArabic } from '../../systems/knowledge/http.js';
import { box } from '../../utils/formatter.js';

/**
 * .define <word> — dictionary meanings from Wiktionary (English and Arabic words,
 * definitions in English): part of speech, top senses and an example.
 */

const stripHtml = (html) =>
    String(html || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

export const pickSenses = (data, lang) => {
    const sections = data?.[lang] || data?.en || Object.values(data || {})[0] || [];
    return sections.slice(0, 3).map((s) => ({
        pos: s.partOfSpeech,
        defs: (s.definitions || [])
            .map((d) => ({ text: stripHtml(d.definition), example: stripHtml(d.parsedExamples?.[0]?.example || d.examples?.[0] || '') }))
            .filter((d) => d.text)
            .slice(0, 3)
    })).filter((s) => s.defs.length);
};

export default {
    name: 'define',
    aliases: ['dict', 'dictionary', 'meaning', 'معنى'],
    category: 'knowledge',
    description: 'Dictionary: meanings and examples (English or Arabic words).',
    usage: '<word>',
    examples: ['serendipity', 'كتاب'],
    permission: 'public',
    cooldown: 4,
    minArgs: 1,

    async execute(sock, message, args) {
        const raw = args.join(' ').trim();
        const word = isArabic(raw) ? raw : raw.toLowerCase();
        const lang = isArabic(word) ? 'ar' : 'en';
        const data = await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word.replace(/ /g, '_'))}`, {
            ttl: 24 * 60 * 60 * 1000,
            notFound: `No definition found for "${raw}".`
        });
        const senses = pickSenses(data, lang);
        if (!senses.length) return message.reply(box('DICTIONARY', [`No definition found for "${raw}".`]));
        const lines = [`📖 ${word}`];
        for (const s of senses) {
            lines.push('', `[ ${s.pos} ]`);
            s.defs.forEach((d, i) => {
                lines.push(`${i + 1}. ${d.text}`);
                if (d.example && i === 0) lines.push(`   e.g. "${d.example.slice(0, 160)}"`);
            });
        }
        lines.push('', '🌐 Wiktionary');
        await message.reply(box('DICTIONARY', lines));
    }
};
