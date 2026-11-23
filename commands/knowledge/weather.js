import { geocode, placeLabel } from '../../systems/knowledge/geo.js';
import { getJson } from '../../systems/knowledge/http.js';
import { box } from '../../utils/formatter.js';

/** .weather <city> — current conditions and a 3-day forecast (Open-Meteo, no key). */

const CODES = {
    0: ['☀️', 'Clear sky'],
    1: ['🌤️', 'Mainly clear'],
    2: ['⛅', 'Partly cloudy'],
    3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'],
    48: ['🌫️', 'Icy fog'],
    51: ['🌦️', 'Light drizzle'],
    53: ['🌦️', 'Drizzle'],
    55: ['🌧️', 'Heavy drizzle'],
    56: ['🌧️', 'Freezing drizzle'],
    57: ['🌧️', 'Freezing drizzle'],
    61: ['🌦️', 'Light rain'],
    63: ['🌧️', 'Rain'],
    65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'],
    67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'],
    73: ['🌨️', 'Snow'],
    75: ['❄️', 'Heavy snow'],
    77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Rain showers'],
    81: ['🌧️', 'Rain showers'],
    82: ['⛈️', 'Violent showers'],
    85: ['🌨️', 'Snow showers'],
    86: ['❄️', 'Heavy snow showers'],
    95: ['⛈️', 'Thunderstorm'],
    96: ['⛈️', 'Thunderstorm, hail'],
    99: ['⛈️', 'Thunderstorm, hail']
};
export const describeCode = (code) => CODES[code] || ['🌡️', 'Unknown'];

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => DIRS[Math.round(((deg % 360) / 45)) % 8];
const round = (n) => Math.round(n);

export default {
    name: 'weather',
    aliases: ['wthr', 'forecast', 'طقس'],
    category: 'knowledge',
    description: 'Current weather and a 3-day forecast for any city.',
    usage: '<city>',
    examples: ['Casablanca', 'الرياض'],
    permission: 'public',
    cooldown: 5,
    minArgs: 1,

    async execute(sock, message, args) {
        const place = await geocode(args.join(' '));
        const url =
            `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
            '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max' +
            '&timezone=auto&forecast_days=4';
        const w = await getJson(url, { ttl: 15 * 60 * 1000 });
        const c = w.current;
        const [icon, label] = describeCode(c.weather_code);
        const d = w.daily;
        const lines = [
            `📍 ${placeLabel(place)}`,
            '',
            `${icon} ${label}`,
            `🌡️ ${round(c.temperature_2m)}°C  (feels ${round(c.apparent_temperature)}°C)`,
            `💧 Humidity ${c.relative_humidity_2m}%`,
            `💨 Wind ${round(c.wind_speed_10m)} km/h ${compass(c.wind_direction_10m)}`,
            `🔆 UV max ${round(d.uv_index_max[0])}  ·  🌅 ${d.sunrise[0].slice(11)}  🌇 ${d.sunset[0].slice(11)}`,
            '',
            '[ NEXT DAYS ]'
        ];
        for (let i = 1; i < d.time.length; i += 1) {
            const day = new Date(`${d.time[i]}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
            const [di] = describeCode(d.weather_code[i]);
            lines.push(`${day}  ${di}  ${round(d.temperature_2m_min[i])}° / ${round(d.temperature_2m_max[i])}°  ☔ ${d.precipitation_probability_max[i] ?? 0}%`);
        }
        lines.push('', `Local time: ${c.time.replace('T', ' ')} (${w.timezone_abbreviation || w.timezone})`);
        await message.reply(box('WEATHER', lines));
    }
};
