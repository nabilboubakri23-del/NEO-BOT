import { jidNormalizedUser } from 'baileys';
import config from '../../config/config.js';
import { child } from '../../core/logger.js';
import { requireImageLib } from '../../systems/media/imageLib.js';
import { downloadMedia, findMedia } from '../../utils/media.js';
import { box, success } from '../../utils/formatter.js';
import { UsageError, UserError } from '../../utils/errors.js';

/**
 * Owner tools for the bot account itself:
 *   .join <group link>   the bot joins a group
 *   .leave               the bot leaves this group
 *   .setbotpp            new profile picture for the bot (send or reply to an image)
 */

const log = child('owner');
const GROUP_LINK = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{10,})/i;

export const join = {
    name: 'join',
    category: 'owner',
    description: 'Make the bot join a group by invite link.',
    usage: '<https://chat.whatsapp.com/...>',
    permission: 'owner',
    minArgs: 1,
    cooldown: 10,
    async execute(sock, message, args) {
        const code = args.join(' ').match(GROUP_LINK)?.[1];
        if (!code) throw new UsageError('Send a chat.whatsapp.com invite link.');
        const jid = await sock.groupAcceptInvite(code).catch((e) => {
            throw new UserError(`Could not join: ${e.message}`);
        });
        log.info({ group: jid }, 'Joined a group by link.');
        await message.reply(success('JOIN', [jid ? `Joined: ${jid}` : 'Join request sent (the group may need admin approval).']));
    }
};

export const leave = {
    name: 'leave',
    aliases: ['leavegroup'],
    category: 'owner',
    description: 'Make the bot leave this group.',
    permission: 'owner',
    scope: 'group',
    async execute(sock, message) {
        await message.reply(box(config.bot.name, ['👋 Leaving the group. Goodbye!'])).catch(() => {});
        await sock.groupLeave(message.chat);
        log.info({ group: message.chat }, 'Left a group.');
    }
};

export const setbotpp = {
    name: 'setbotpp',
    aliases: ['botpp'],
    category: 'owner',
    description: 'Change the bot\'s profile picture (send or reply to an image).',
    permission: 'owner',
    cooldown: 10,
    async execute(sock, message) {
        const media = findMedia(message, ['image']);
        if (!media) throw new UsageError('Send an image with the command or reply to one.');
        await requireImageLib();
        const buffer = await downloadMedia(sock, media, { maxBytes: 5 * 1024 * 1024 });
        await sock.updateProfilePicture(jidNormalizedUser(sock.user.id), buffer).catch((e) => {
            throw new UserError(`WhatsApp refused the picture: ${e.message}`);
        });
        await message.reply(success('PROFILE', ['Bot picture updated.']));
    }
};

export default [join, leave, setbotpp];
