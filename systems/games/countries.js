/**
 * Countries for the flag quiz: [ISO 3166-1 alpha-2 code, English name, ...accepted alternatives].
 * Flags are built from the code (regional indicator symbols), so no images or network are needed.
 */
export const COUNTRIES = Object.freeze([
    ['MA', 'Morocco'], ['DZ', 'Algeria'], ['TN', 'Tunisia'], ['LY', 'Libya'], ['EG', 'Egypt'], ['SD', 'Sudan'],
    ['MR', 'Mauritania'], ['SN', 'Senegal'], ['ML', 'Mali'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['CI', 'Ivory Coast', "cote d'ivoire", 'cote divoire'],
    ['CM', 'Cameroon'], ['KE', 'Kenya'], ['ET', 'Ethiopia'], ['ZA', 'South Africa'], ['TZ', 'Tanzania'], ['UG', 'Uganda'],
    ['AO', 'Angola'], ['CD', 'DR Congo', 'democratic republic of the congo', 'drc'], ['ZW', 'Zimbabwe'], ['SO', 'Somalia'], ['RW', 'Rwanda'], ['MG', 'Madagascar'],
    ['SA', 'Saudi Arabia', 'ksa'], ['AE', 'United Arab Emirates', 'uae', 'emirates'], ['QA', 'Qatar'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['OM', 'Oman'],
    ['YE', 'Yemen'], ['JO', 'Jordan'], ['LB', 'Lebanon'], ['SY', 'Syria'], ['IQ', 'Iraq'], ['PS', 'Palestine'],
    ['TR', 'Turkey', 'turkiye'], ['IR', 'Iran'], ['AF', 'Afghanistan'], ['PK', 'Pakistan'], ['IN', 'India'], ['BD', 'Bangladesh'],
    ['LK', 'Sri Lanka'], ['NP', 'Nepal'], ['CN', 'China'], ['JP', 'Japan'], ['KR', 'South Korea', 'korea'], ['KP', 'North Korea'],
    ['MN', 'Mongolia'], ['VN', 'Vietnam'], ['TH', 'Thailand'], ['MY', 'Malaysia'], ['SG', 'Singapore'], ['ID', 'Indonesia'],
    ['PH', 'Philippines'], ['KZ', 'Kazakhstan'], ['UZ', 'Uzbekistan'], ['AZ', 'Azerbaijan'], ['GE', 'Georgia'], ['AM', 'Armenia'],
    ['GB', 'United Kingdom', 'uk', 'great britain', 'britain', 'england'], ['IE', 'Ireland'], ['FR', 'France'], ['DE', 'Germany'], ['ES', 'Spain'], ['PT', 'Portugal'],
    ['IT', 'Italy'], ['NL', 'Netherlands', 'holland'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['AT', 'Austria'], ['PL', 'Poland'],
    ['CZ', 'Czechia', 'czech republic'], ['SK', 'Slovakia'], ['HU', 'Hungary'], ['RO', 'Romania'], ['BG', 'Bulgaria'], ['GR', 'Greece'],
    ['RS', 'Serbia'], ['HR', 'Croatia'], ['BA', 'Bosnia and Herzegovina', 'bosnia'], ['AL', 'Albania'], ['UA', 'Ukraine'], ['RU', 'Russia'],
    ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['FI', 'Finland'], ['IS', 'Iceland'], ['EE', 'Estonia'],
    ['LV', 'Latvia'], ['LT', 'Lithuania'], ['US', 'United States', 'usa', 'america', 'united states of america'], ['CA', 'Canada'], ['MX', 'Mexico'], ['CU', 'Cuba'],
    ['JM', 'Jamaica'], ['BR', 'Brazil'], ['AR', 'Argentina'], ['CL', 'Chile'], ['CO', 'Colombia'], ['PE', 'Peru'],
    ['VE', 'Venezuela'], ['UY', 'Uruguay'], ['PY', 'Paraguay'], ['BO', 'Bolivia'], ['EC', 'Ecuador'], ['AU', 'Australia'],
    ['NZ', 'New Zealand'], ['FJ', 'Fiji'], ['CY', 'Cyprus'], ['MT', 'Malta'], ['LU', 'Luxembourg'], ['MC', 'Monaco']
]);

/** Flag emoji for an alpha-2 code. */
export const flagOf = (code) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
