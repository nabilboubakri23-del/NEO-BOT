import { geocode, placeLabel } from '../../systems/knowledge/geo.js';
import { box } from '../../utils/formatter.js';

/** .time [city] — local time and date anywhere, with the offset from the bot's zone. */

const HOME_ZONE = process.env.BOT_TIMEZONE || 'Africa/Casablanca';

const offsetMinutes = (zone, at = new Date()) => {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
};

const fmtOffset = (mins) => `UTC${mins < 0 ? '-' : '+'}${String(Math.floor(Math.abs(mins) / 60)).padStart(2, '0')}:${String(Math.abs(mins) % 60).padStart(2, '0')}`;

export const describeZone = (zone, at = new Date()) => {
    const time = at.toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = at.toLocaleDateString('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const hijri = at.toLocaleDateString('ar-SA-u-ca-islamic-umalqura', { timeZone: zone, day: 'numeric', month: 'long', year: 'numeric' });
    return { time, date, hijri, offset: offsetMinutes(zone, at) };
};

export default {
    name: 'time',
    aliases: ['worldtime', 'clock', 'وقت'],
    category: 'knowledge',
    description: 'Local time, date and Hijri date in any city.',
    usage: '[city]',
    examples: ['Tokyo', 'مكة'],
    permission: 'public',
    cooldown: 3,

    async execute(sock, message, args) {
        let zone = HOME_ZONE;
        let label = HOME_ZONE.split('/').pop().replace(/_/g, ' ');
        if (args.length) {
            const place = await geocode(args.join(' '));
            zone = place.timezone;
            label = placeLabel(place);
        }
        const now = new Date();
        const here = describeZone(zone, now);
        const diff = here.offset - offsetMinutes(HOME_ZONE, now);
        const lines = [
            `📍 ${label}`,
            '',
            `🕒 ${here.time}`,
            `📅 ${here.date}`,
            `🌙 ${here.hijri}`,
            `🌐 ${zone} (${fmtOffset(here.offset)})`
        ];
        if (args.length && zone !== HOME_ZONE) {
            const h = diff / 60;
            lines.push('', diff === 0 ? 'Same time as the bot zone.' : `${Math.abs(h)} h ${diff > 0 ? 'ahead of' : 'behind'} ${HOME_ZONE.split('/').pop()}`);
        }
        await message.reply(box('WORLD TIME', lines));
    }
};
