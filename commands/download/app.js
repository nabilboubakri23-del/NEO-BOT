import { box, fields, formatBytes } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';
import { appSearch, formatSize, MAX_FILE_BYTES, sanitizeFilename, sendFile } from './.lib.js';

/**
 * Android apps by name, from the Aptoide store (public API, no key):
 *   .app <name>       top matches with version, size and trust badge
 *   .app <name> <n>   download match number n (1-5) as an APK document
 * Apps marked TRUSTED by Aptoide are badged; others are flagged, never hidden.
 */

const LIST_LIMIT = 5;

export default {
    name: 'app',
    aliases: ['apk', 'تطبيق', 'تطبيقات'],
    category: 'download',
    description: 'Search Android apps by name and download the APK.',
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
            const lines = apps.map((a, i) => `${i + 1}. ${a.name} ${a.version} ${a.trusted ? '✅' : '⚠️'} (${formatSize(a.size) || 'size unknown'})`);
            return message.reply(box('APP SEARCH', [
                ...lines,
                '',
                `Download one: ${ctx.prefix}app ${query} <number>`,
                '✅ verified by the store · ⚠️ unverified'
            ]));
        }

        const app = apps[pick - 1];
        if (!app) throw new UserError('⚠️ No app with that number in the results.');
        if (app.size > MAX_FILE_BYTES) throw new UserError(`⚠️ App too large (${formatBytes(app.size)}). Maximum is ${formatSize(MAX_FILE_BYTES)}.`);

        await message.react?.('⏳');
        await sendFile(sock, message, {
            kind: 'document',
            url: app.url,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${sanitizeFilename(app.name)}-${app.version || 'latest'}.apk`,
            caption: box('APP DOWNLOAD', [
                ...fields({ '📱 App': app.name, '🏷️ Version': app.version, '📦 Size': formatBytes(app.size), '🔰 Store check': app.trusted ? 'TRUSTED' : 'UNVERIFIED - install at your own risk' })
            ])
        });
    }
};
