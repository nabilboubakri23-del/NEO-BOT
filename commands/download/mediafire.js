import { box, fields } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { assertUrl, downloadFile, fetchText, formatSize, MAX_FILE_BYTES, parseMediafire, sendFile } from './.lib.js';

/**
 * MediaFire downloads:
 *   .mediafire <link>   file from a public MediaFire link
 * The bot reads the file page itself (no third-party API), downloads the file
 * with size and type checks, then sends it as a document.
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

        const data = await downloadFile(file.url, { allowHosts: ['mediafire.com'], maxBytes: MAX_FILE_BYTES });
        await sendFile(sock, message, {
            kind: 'document',
            buffer: data.buffer,
            fileName: file.name,
            caption: box('MEDIAFIRE', fields({ '📁 File': file.name, '📦 Size': formatSize(data.size) }))
        });
    }
};
