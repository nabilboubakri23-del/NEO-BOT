import config from '../../config/config.js';
import { sendButtons } from '../../systems/menus/interactiveMenu.js';
import { clip, getJson, isArabic } from '../../systems/knowledge/http.js';
import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';

/**
 * .wiki <topic> — Wikipedia summary in Arabic or English (picked from the text,
 * or forced with "ar"/"en" as the first word). ".wiki random" for a random article.
 */

const LANGS = new Set(['ar', 'en', 'fr', 'es', 'de']);

const findTitle = async (lang, query) => {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
    const data = await getJson(url);
    return data?.query?.search?.[0]?.title || null;
};

const summary = async (lang, title) =>
    getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { notFound: 'No article found.' });

export const lookup = async (args) => {
    let lang = '';
    if (LANGS.has(args[0]?.toLowerCase()) && args.length > 1) lang = args.shift().toLowerCase();
    const query = args.join(' ').trim();
    if (!query) throw new UsageError();
    lang ||= isArabic(query) ? 'ar' : 'en';

    let page;
    if (/^(random|عشوائي)$/i.test(query)) {
        page = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/random/summary`, { ttl: 0 });
    } else {
        const title = await findTitle(lang, query);
        if (!title) throw new UserError(`Nothing on Wikipedia (${lang}) for: ${query}`);
        page = await summary(lang, title);
    }
    if (page.type === 'disambiguation') throw new UserError(`"${page.title}" has several meanings. Be more specific.`);
    return { lang, page };
};

export default {
    name: 'wiki',
    aliases: ['wikipedia', 'ويكي'],
    category: 'knowledge',
    description: 'Wikipedia summary of any topic (Arabic or English).',
    usage: '[ar|en|fr] <topic> | random',
    examples: ['المغرب', 'en black hole', 'random'],
    permission: 'public',
    cooldown: 5,
    minArgs: 1,

    async execute(sock, message, args) {
        const { lang, page } = await lookup([...args]);
        const link = page.content_urls?.mobile?.page || page.content_urls?.desktop?.page || '';
        const lines = [`📚 ${page.title}`];
        if (page.description) lines.push(`_${page.description}_`);
        lines.push('', clip(page.extract, 1100), '', `🌐 Wikipedia · ${lang.toUpperCase()}`);
        const text = box('KNOWLEDGE', lines);
        if (!link) return message.reply(text);
        await sendButtons(
            sock,
            message.chat,
            {
                title: 'WIKIPEDIA',
                body: text,
                footer: config.bot.footer,
                buttons: [
                    { type: 'url', text: 'Read full article', url: link },
                    { type: 'reply', text: '🎲 Random article', id: `${config.bot.prefix}wiki ${lang} random` }
                ]
            },
            { quoted: message.raw, fallbackText: `${text}\n\n${link}` }
        );
    }
};
