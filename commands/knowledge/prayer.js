import { geocode, placeLabel } from '../../systems/knowledge/geo.js';
import { getJson } from '../../systems/knowledge/http.js';
import { box } from '../../utils/formatter.js';

/**
 * .prayer <city> — today's prayer times (AlAdhan, method picked for the region),
 * Hijri date and a countdown to the next prayer.
 */

const PRAYERS = [
    ['Fajr', 'الفجر', '🌄'],
    ['Sunrise', 'الشروق', '🌅'],
    ['Dhuhr', 'الظهر', '☀️'],
    ['Asr', 'العصر', '🌤️'],
    ['Maghrib', 'المغرب', '🌇'],
    ['Isha', 'العشاء', '🌙']
];

const localParts = (zone, at = new Date()) => {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .formatToParts(at)
            .map((p) => [p.type, p.value])
    );
    return { date: `${parts.day}-${parts.month}-${parts.year}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).slice(0, 5).split(':').map(Number);
    return h * 60 + m;
};

export const nextPrayer = (timings, nowMinutes) => {
    for (const [key, ar] of PRAYERS) {
        if (key === 'Sunrise') continue;
        const at = toMinutes(timings[key]);
        if (at > nowMinutes) return { key, ar, in: at - nowMinutes };
    }
    return { key: 'Fajr', ar: 'الفجر', in: 24 * 60 - nowMinutes + toMinutes(timings.Fajr) };
};

export default {
    name: 'prayer',
    aliases: ['salat', 'adhan', 'prayertimes', 'صلاة', 'اذان'],
    category: 'knowledge',
    description: 'Prayer times for any city, with the next prayer countdown.',
    usage: '<city>',
    examples: ['Casablanca', 'مكة'],
    permission: 'public',
    cooldown: 5,
    minArgs: 1,

    async execute(sock, message, args) {
        const place = await geocode(args.join(' '));
        const now = localParts(place.timezone);
        const url = `https://api.aladhan.com/v1/timings/${now.date}?latitude=${place.lat}&longitude=${place.lon}&timezonestring=${encodeURIComponent(place.timezone)}`;
        const { data } = await getJson(url, { ttl: 6 * 60 * 60 * 1000 });
        const t = data.timings;
        const next = nextPrayer(t, now.minutes);
        const hijri = data.date.hijri;
        const lines = [
            `📍 ${placeLabel(place)}`,
            `📅 ${data.date.readable}  ·  🌙 ${hijri.day} ${hijri.month.ar} ${hijri.year}`,
            ''
        ];
        for (const [key, ar, icon] of PRAYERS) {
            const mark = key === next.key ? '  ◀ next' : '';
            lines.push(`${icon} ${key.padEnd(8)} ${ar.padEnd(7)} ${t[key].slice(0, 5)}${mark}`);
        }
        lines.push('', `⏳ ${next.key} (${next.ar}) in ${Math.floor(next.in / 60)}h ${next.in % 60}m`, `Method: ${data.meta.method?.name || 'auto'}`);
        await message.reply(box('PRAYER TIMES', lines));
    }
};
