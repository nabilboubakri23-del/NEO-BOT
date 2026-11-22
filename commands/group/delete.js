import { deleteMessage } from '../../systems/moderation/actions.js';
import { UsageError, UserError } from '../../utils/errors.js';

/**
 * .delete — delete the replied message for everyone.
 * Group admins can delete members' messages (the bot must be admin);
 * anyone with access can delete the bot's own messages.
 */
export default {
    name: 'delete',
    aliases: ['del', 'd'],
    category: 'group',
    description: 'Delete the replied message for everyone.',
    usage: '(reply to a message)',
    permission: 'public',
    scope: 'group',
    requires: ['groupAdmin'],
    async execute(sock, message, args, ctx) {
        const key = message.quoted?.key;
        if (!key?.id) throw new UsageError('Reply to the message to delete.');
        if (!key.fromMe && !(await ctx.access.isBotAdmin())) throw new UserError('Make the bot a group admin first.');
        if (!(await deleteMessage(sock, key))) throw new UserError('WhatsApp refused to delete that message.');
        await deleteMessage(sock, message.raw.key); // tidy up the command itself when allowed
    }
};
