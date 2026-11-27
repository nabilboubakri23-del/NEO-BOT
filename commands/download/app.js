import { box, fields, formatBytes } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import config from '../../config/config.js';
import { sendListMenu } from '../../systems/menus/interactiveMenu.js';
import { appSearch, appVerify, downloadFile, formatSize, MAX_FILE_BYTES, pickApp, sanitizeFilename, sendFile } from './.lib.js';

/**
 * Android apps by name, from the Aptoide store (public API, no key):
 *   .app <name>       top matches as a pick list (tap one to download)
 *   .app <name> <n>   download match number n (1-5) directly
 * Only apps the store's malware screening marks TRUSTED can be downloaded;
 * others are shown as blocked, never sent. The badge is store malware
 * screening, not publisher identity verification or a safety guarantee.
 * The store state is checked again at download time before any file is fetched.
 */

const LIST_LIMIT = 5;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const TAP_GAP_MS = 15_000;

// List taps skip the text cooldown, so guard them here: one download per user at a time + a gap.
const busy = new Set();
const lastTap = new Map();

/** Re-check the app with the store, download it and send the APK. */
export const sendApp = async (sock, message, packageName, fallbackName = '') => {
    const fresh = await appVerify(packageName);
    if (!fresh.url) throw new UserError('⚠️ Could not confirm that app with the store. Try again later.');
    if (!fresh.trusted) throw new UserError('⚠️ The store no longer marks that app as screened. Download blocked.');
    if (fresh.size > MAX_FILE_BYTES) throw new UserError(`⚠️ App too large (${formatBytes(fresh.size)}). Maximum is ${formatSize(MAX_FILE_BYTES)}.`);

    await message.react?.('⏳');
    const data = await downloadFile(fresh.url, { allowHosts: ['aptoide.com'], maxBytes: MAX_FILE_BYTES, expect: ['archive'] });
    const name = fresh.name || fallbackName || packageName;
    await sendFile(sock, message, {
        kind: 'document',
        buffer: data.buffer,
        mimetype: 'application/vnd.android.package-archive',
        fileName: `${sanitizeFilename(name)}-${fresh.version || 'latest'}.apk`,
        caption: box('APP DOWNLOAD', [
            ...fields({ '📱 App': name, '🏷️ Version': fresh.version, '📦 Size': formatSize(data.size), '🔰 Store check': 'passed Aptoide malware screening' })
        ])
    });
    await message.react?.('✅');
};

/** Search results → { menu, text }: a pick list where only screened apps are tappable. */
export const resultsMenu = (query, apps, prefix = '.') => {
    const lines = apps.map((a, i) => `${i + 1}. ${a.name} ${a.version} ${a.trusted ? '✅' : '🚫'} (${formatSize(a.size) || 'size unknown'})`);
    const trusted = apps.filter((a) => a.trusted && PACKAGE.test(a.packageName));
    const rows = trusted.map((a) => ({
        id: `app:get:${a.packageName}`,
        title: `📱 ${a.name}`.slice(0, 72),
        description: [a.version && `v${a.version}`, formatSize(a.size)].filter(Boolean).join(' • ').slice(0, 72)
    }));
    const text = box('APP SEARCH', [...lines, '', `Download one: ${prefix}app ${query} <number>`, '✅ passed store malware screening · 🚫 not screened (blocked)']);
    const menu = rows.length ? {
        title: 'App search',
        body: box('APP SEARCH', [...lines, '', 'Tap "Choose an app" and pick one.', '✅ screened · 🚫 not screened (not offered)']),
        footer: `${config.bot.name} • Apps`,
        buttonText: 'Choose an app',
        sections: [{ title: 'Screened apps', rows }]
    } : null;
    return { menu, text };
};

const sendResults = (sock, message, query, apps, prefix) => {
    const { menu, text } = resultsMenu(query, apps, prefix);
    if (!menu) return message.reply(text);
    return sendListMenu(sock, message.chat, menu, { quoted: message.raw, fallbackText: text });
};

export default {
    name: 'app',
    aliases: ['apk', 'تطبيق', 'تطبيقات'],
    category: 'download',
    description: 'Search Android apps by name and download store-screened APKs.',
    usage: '<app name> [number]',
    examples: ['app whatsapp', 'app whatsapp 2'],
    permission: 'public',
    cooldown: 20,
    minArgs: 1,
    async execute(sock, message, args, ctx) {
        let pick = 0;
        const words = [...args];
        // ".app whatsapp 2" → download result #2 of the "whatsapp" search.
        if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
            pick = Number(words.pop());
            if (pick < 1 || pick > LIST_LIMIT) throw new UserError(`⚠️ Choose a number between 1 and ${LIST_LIMIT}.`);
        }
        const query = words.join(' ').trim();
        if (!query) throw new UsageError();
        if (query.length > 80) throw new UserError('⚠️ That app name is too long.');

        await message.react?.('🔎');
        const apps = await appSearch(query);
        if (!apps.length) throw new UserError('⚠️ No app matched that name.');

        if (pick === 0) return sendResults(sock, message, query, apps, ctx.prefix);
        const selected = pickApp(apps, pick); // throws for unknown numbers and unscreened apps
        return sendApp(sock, message, selected.packageName, selected.name);
    },

    async onSelect(sock, message, parts) {
        const [action, packageName] = parts;
        if (action !== 'get' || !PACKAGE.test(packageName || '')) throw new UserError('⚠️ Invalid choice. Search again.');
        const user = message.sender || message.chat;
        if (busy.has(user)) throw new UserError('⏳ Your app is still downloading.');
        const wait = (lastTap.get(user) || 0) + TAP_GAP_MS - Date.now();
        if (wait > 0) throw new UserError(`⏳ Wait ${Math.ceil(wait / 1000)}s before the next download.`);
        busy.add(user);
        lastTap.set(user, Date.now());
        try {
            await sendApp(sock, message, packageName);
        } finally {
            busy.delete(user);
        }
    }
};
