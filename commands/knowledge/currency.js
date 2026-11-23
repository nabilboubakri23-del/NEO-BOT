import { getJson } from '../../systems/knowledge/http.js';
import { box } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { formatNumber } from '../../systems/knowledge/calculator.js';

/**
 * .currency <amount> <from> [to] [more…] — live exchange rates (open.er-api.com, daily).
 * Accepts ISO codes and common Arabic names: .currency 100 usd mad eur  /  .currency 50 درهم دولار
 */

const NAMES = {
    'دولار': 'USD', 'يورو': 'EUR', 'درهم': 'MAD', 'ريال': 'SAR', 'جنيه': 'EGP', 'دينار': 'KWD',
    'ليرة': 'TRY', 'اماراتي': 'AED', 'إماراتي': 'AED', 'قطري': 'QAR', 'جزائري': 'DZD', 'تونسي': 'TND',
    'استرليني': 'GBP', 'ين': 'JPY', 'روبل': 'RUB', 'يوان': 'CNY',
    dollar: 'USD', euro: 'EUR', dirham: 'MAD', riyal: 'SAR', pound: 'GBP', yen: 'JPY', lira: 'TRY', bitcoin: 'BTC'
};
const DEFAULT_TARGETS = ['USD', 'EUR', 'MAD', 'SAR', 'AED', 'EGP'];

const code = (word) => {
    const w = String(word || '').trim();
    return NAMES[w] || NAMES[w.toLowerCase()] || (/^[a-z]{3}$/i.test(w) ? w.toUpperCase() : null);
};

export const parseConversion = (args) => {
    const words = args.join(' ').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/(\d)([a-z\u0600-\u06FF])/gi, '$1 $2').split(/\s+/).filter((w) => w && !/^(to|in|الى|إلى|ل|=)$/i.test(w));
    const amount = Number(words[0]?.replace(/,/g, ''));
    const rest = Number.isFinite(amount) ? words.slice(1) : words;
    const from = code(rest[0]);
    if (!from) throw new UsageError();
    const targets = rest.slice(1).map(code);
    if (targets.some((t) => !t)) throw new UserError(`Unknown currency: ${rest.slice(1)[targets.findIndex((t) => !t)]}`);
    return { amount: Number.isFinite(amount) ? amount : 1, from, targets: targets.length ? targets : DEFAULT_TARGETS.filter((t) => t !== from) };
};

export default {
    name: 'currency',
    aliases: ['convert', 'fx', 'rate', 'عملة'],
    category: 'knowledge',
    description: 'Live currency conversion (ISO codes or Arabic names).',
    usage: '<amount> <from> [to …]',
    examples: ['100 usd mad', '50 eur', '200 درهم دولار'],
    permission: 'public',
    cooldown: 4,
    minArgs: 1,

    async execute(sock, message, args) {
        const { amount, from, targets } = parseConversion(args);
        const data = await getJson(`https://open.er-api.com/v6/latest/${from}`, { ttl: 60 * 60 * 1000, notFound: `Unknown currency: ${from}` });
        if (data.result !== 'success') throw new UserError(`Unknown currency: ${from}`);
        const lines = [`💱 ${formatNumber(amount)} ${from}`, ''];
        for (const t of targets.slice(0, 8)) {
            const rate = data.rates[t];
            lines.push(rate ? `= ${formatNumber(Number((amount * rate).toFixed(amount * rate >= 1 ? 2 : 6)))} ${t}   (1 ${from} = ${formatNumber(Number(rate.toPrecision(6)))})` : `${t}: not available`);
        }
        lines.push('', `Updated: ${new Date(data.time_last_update_unix * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
        await message.reply(box('EXCHANGE', lines));
    }
};
