/**
 * NEO BOT text formatting helpers. All output is plain WhatsApp text.
 */

const TOP = (title) => `╭━━━━━━ ${title} ━━━━━━╮`;
const BOTTOM = '╰━━━━━━━━━━━━━━━━━━━━╯';

/** Builds the standard NEO BOT box. `lines` is an array of strings ('' = spacer). */
export const box = (title, lines = []) =>
    [TOP(title), '┃', ...lines.map((line) => (line ? `┃ ${line}` : '┃')), '┃', BOTTOM].join('\n');

export const bold = (text) => `*${text}*`;
export const mono = (text) => '```' + text + '```';

export const formatDuration = (ms) => {
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
};

/** Terminal frame used by the authentication interface. */
export const terminalFrame = (title, lines = [], width = 32) => {
    const inner = width - 2;
    const pad = (text) => {
        const t = ` ${text}`;
        return `║${t}${' '.repeat(Math.max(0, inner - t.length))}║`;
    };
    const center = (text) => {
        const left = Math.floor((inner - text.length) / 2);
        return `║${' '.repeat(Math.max(0, left))}${text}${' '.repeat(Math.max(0, inner - left - text.length))}║`;
    };
    const titles = Array.isArray(title) ? title : [title];
    return [
        `╔${'═'.repeat(inner)}╗`,
        ...titles.map(center),
        `╠${'═'.repeat(inner)}╣`,
        pad(''),
        ...lines.map(pad),
        pad(''),
        `╚${'═'.repeat(inner)}╝`
    ].join('\n');
};
