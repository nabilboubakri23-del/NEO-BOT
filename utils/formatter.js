/**
 * NEO BOT message formatter. Every bot reply is built here so all
 * commands share one look. All output is plain WhatsApp text.
 *
 *   ╭━━━━━━ NEO BOT ━━━━━━╮
 *   ┃
 *   ┃ Command: .ping
 *   ┃ Status: Success
 *   ┃
 *   ╰━━━━━━━━━━━━━━━━━━━━╯
 */

const TOP = (title) => `╭━━━━━━ ${title} ━━━━━━╮`;
const BOTTOM = '╰━━━━━━━━━━━━━━━━━━━━╯';

/** Builds the standard NEO BOT box. `lines` is an array of strings ('' = spacer, null/false = skipped). */
export const box = (title, lines = []) =>
    [TOP(title), '┃', ...lines.filter((l) => l !== null && l !== undefined && l !== false).map((line) => (line ? `┃ ${line}` : '┃')), '┃', BOTTOM].join('\n');

/** Key/value lines: fields({ Status: 'Online', Ping: '45ms' }) → ['Status: Online', 'Ping: 45ms'] */
export const fields = (object) =>
    Object.entries(object)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${v}`);

/** A titled block inside a box: section('USERS', ['a', 'b']) → ['[ USERS ]', 'a', 'b'] */
export const section = (title, lines) => [`[ ${title} ]`, ...lines];

export const success = (title, lines = []) => box(title, ['✅ Done.', ...(lines.length ? ['', ...lines] : [])]);
export const failure = (title, lines = []) => box(title, ['❌ Failed.', ...(lines.length ? ['', ...lines] : [])]);
export const notice = (title, lines = []) => box(title, lines);

/** Usage reply generated from a command definition. */
export const usage = (command, prefix, reason = '') =>
    box('USAGE', [
        reason || null,
        reason ? '' : null,
        `${prefix}${command.name}${command.usage ? ` ${command.usage}` : ''}`,
        command.description || null,
        ...(command.examples?.length ? ['', 'Examples:', ...command.examples.map((e) => `• ${prefix}${command.name} ${e}`.trim())] : [])
    ]);

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

export const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
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
