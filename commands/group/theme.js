import config from '../../config/config.js';
import { box } from '../../utils/formatter.js';
import { UserError } from '../../utils/errors.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { COLORS, parseColor } from '../../systems/media/colorText.js';
import { clearTheme, defaultTheme, imageTheme, sendChatTheme, solidTheme } from '../../systems/groups/chatTheme.js';
import { allowedToAct } from './.messageActionAccess.js';

const P = () => config.bot.prefix;
const TITLE = 'CHAT THEME';
const GAP_MS = 30_000;
const lastSet = new Map(); // chat → time, so a theme cannot be flipped in a loop

const help = (m) => m.reply(box(TITLE, [
    'Sets the chat wallpaper for EVERYONE here.',
    '',
    `${P()}theme blue        → colour (name, أزرق, or #hex)`,
    `${P()}theme blue doodle → colour with WhatsApp doodles`,
    `${P()}theme  (send/reply to an image) → photo wallpaper`,
    `${P()}theme default     → WhatsApp default wallpaper`,
    `${P()}theme clear       → remove the shared theme`,
    '',
    `Colours: ${Object.keys(COLORS).join(', ')}`,
    'Only phones with WhatsApp\'s shared themes (beta 2.26.46+) show it.'
]));

export default {
    name: 'theme',
    aliases: ['wallpaper', 'خلفية', 'ثيم'],
    category: 'group',
    permission: 'public',
    description: 'Set the chat wallpaper for everyone in the chat (colour, photo, default or clear).',
    usage: '<colour> [doodle] · default · clear · (image)',
    examples: ['theme blue', 'theme #ff8800 doodle', 'theme clear'],
    cooldown: 10,
    async execute(sock, m, args, ctx) {
        const first = String(args[0] || '').toLowerCase();
        const image = findMedia(m, ['image']);
        if (!first && !image) return help(m);
        if (!(await allowedToAct(m, ctx, TITLE))) return undefined;
        const wait = (lastSet.get(m.chat) || 0) + GAP_MS - Date.now();
        if (wait > 0 && !ctx.access?.isOwner) throw new UserError(`⏳ Wait ${Math.ceil(wait / 1000)}s before changing the theme again.`);

        let setting; let label;
        if (['clear', 'off', 'remove', 'مسح', 'حذف'].includes(first)) { setting = clearTheme(); label = '🧹 Shared theme removed.'; }
        else if (['default', 'reset', 'افتراضي'].includes(first)) { setting = defaultTheme(); label = '🔄 Default WhatsApp wallpaper.'; }
        else if (image && !parseColor(first)) {
            await m.react?.('⏳');
            const buffer = await downloadMedia(sock, image, { maxBytes: 8 * 1024 * 1024 });
            setting = await imageTheme(sock, buffer);
            label = '🖼️ Photo wallpaper set.';
        } else {
            const hex = parseColor(first);
            if (!hex) return help(m);
            const doodles = args.slice(1).some((a) => /^(doodle|doodles|رسومات)$/i.test(a));
            setting = solidTheme(hex, { doodles });
            label = `🎨 Colour #${hex}${doodles ? ' with doodles' : ''}.`;
        }
        await sendChatTheme(sock, m.chat, setting);
        lastSet.set(m.chat, Date.now());
        await m.react?.('✅');
        return m.reply(box(TITLE, [label, 'Everyone with shared themes sees it.', 'Older WhatsApp versions ignore it.']));
    }
};
