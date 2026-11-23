import { box, fields, formatBytes } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { appSearch, appVerify, downloadFile, formatSize, MAX_FILE_BYTES, pickApp, sanitizeFilename, sendFile } from './.lib.js';

/**
 * Android apps by name, from the Aptoide store (public API, no key):
 *   .app <name>       top matches with version, size and screening badge
 *   .app <name> <n>   download match number n (1-5) as an APK document
 * Only apps the store's malware screening marks TRUSTED can be downloaded;
 * others are shown as blocked, never sent. The badge is store malware
 * screening, not publisher identity verification or a safety guarantee.
 * The store state is checked again at download time before any file is fetched.
 */

const LIST_LIMIT = 5;

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

        if (pick === 0) {
            const lines = apps.map((a, i) => `${i + 1}. ${a.name} ${a.version} ${a.trusted ? '✅' : '🚫'} (${formatSize(a.size) || 'size unknown'})`);
            return message.reply(box('APP SEARCH', [
                ...lines,
                '',
                `Download one: ${ctx.prefix}app ${query} <number>`,
                '✅ passed store malware screening · 🚫 not screened (blocked)'
            ]));
        }

        const selected = pickApp(apps, pick); // throws for unknown numbers and unscreened apps

        // Re-resolve at download time: the store state or link may have changed.
        const fresh = await appVerify(selected.packageName);
        if (!fresh.url) throw new UserError('⚠️ Could not confirm that app with the store. Try again later.');
        if (!fresh.trusted) throw new UserError('⚠️ The store no longer marks that app as screened. Download blocked.');
        if (fresh.size > MAX_FILE_BYTES) throw new UserError(`⚠️ App too large (${formatBytes(fresh.size)}). Maximum is ${formatSize(MAX_FILE_BYTES)}.`);

        await message.react?.('⏳');
        const data = await downloadFile(fresh.url, { allowHosts: ['aptoide.com'], maxBytes: MAX_FILE_BYTES, expect: ['archive'] });
        await sendFile(sock, message, {
            kind: 'document',
            buffer: data.buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${sanitizeFilename(fresh.name || selected.name)}-${fresh.version || 'latest'}.apk`,
            caption: box('APP DOWNLOAD', [
                ...fields({ '📱 App': fresh.name || selected.name, '🏷️ Version': fresh.version, '📦 Size': formatSize(data.size), '🔰 Store check': 'passed Aptoide malware screening' })
            ])
        });
    }
};
