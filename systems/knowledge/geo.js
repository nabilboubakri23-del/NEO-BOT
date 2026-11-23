import { getJson, isArabic } from './http.js';
import { UserError } from '../../utils/errors.js';

/**
 * Place lookup (Open-Meteo geocoding, free, no key).
 * Returns { name, country, admin, lat, lon, timezone, population }.
 */
export const geocode = async (query) => {
    const q = String(query || '').trim();
    if (!q) throw new UserError('Give a city name.');
    const lang = isArabic(q) ? 'ar' : 'en';
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=${lang}&format=json`;
    const data = await getJson(url, { ttl: 24 * 60 * 60 * 1000 });
    const place = data?.results?.[0];
    if (!place) throw new UserError(`Place not found: ${q}`);
    return {
        name: place.name,
        country: place.country || '',
        admin: place.admin1 || '',
        lat: place.latitude,
        lon: place.longitude,
        timezone: place.timezone || 'UTC',
        population: place.population || 0
    };
};

export const placeLabel = (p) => [p.name, p.admin && p.admin !== p.name ? p.admin : '', p.country].filter(Boolean).join(', ');
