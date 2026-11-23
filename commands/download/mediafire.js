import { box, fields } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, fetchText, formatSize, MAX_FILE_BYTES, parseMediafire, remoteSize, sendFile } from './.lib.js';

/**
 * MediaFire downloads:
 *   .mediafire <link>   file from a public MediaFire link
 * The bot reads the file page itself (no third-party API), checks the size,
 * then sends the file as a document.
 */

const MF_HOSTS = ['mediafire.com'];

export default {
    name: 'mediafire',
    aliases: ['mf', 'ميديافاير'],
    category: 'download',
    description: 'Download a file from a public MediaFire link.',
    usage: '<mediafire link>',
    examples: ['mediafire https://www.mediafire.com/file/xxxxx/name.zip/file'],
    permission: 'public',
    cooldown: 30,
    minArgs: 1,
    async execute(sock, message, args) {
        const url = assertUrl(args[0], MF_HOSTS, 'MediaFire link');
        await message.react?.('⏳');

        const html = await fetchText(url, { allowHosts: ['mediafire.com'] });
        const file = parseMediafire(html);
        if (!file) throw new UserError('⚠️ No file found at that link. It may be removed, private, or a folder.');

        const size = await remoteSize(file.url, { allowHosts: ['mediafire.com'] });
        if (size > MAX_FILE_BYTES) throw new UserError(`⚠️ File too large (${formatSize(size)}). Maximum is ${formatSize(MAX_FILE_BYTES)}.`);

        await sendFile(sock, message, {
            kind: 'document',
            url: file.url,
            fileName: file.name,
            caption: box('MEDIAFIRE', fields({ '📁 File': file.name, '📦 Size': formatSize(size) || null }))
        });
    }
};
