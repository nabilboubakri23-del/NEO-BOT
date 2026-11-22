import { createAccess } from '../permissions/permissions.js';
import { getGroupOption, hasActiveGuards } from './groupConfig.js';

/**
 * Why group protection may not act, told to admins when they switch it on.
 * The guard needs the bot to be a group admin (WhatsApp refuses deletes otherwise),
 * and by default it never touches group admins, bot staff, or the bot's own number.
 */
export const readinessLines = async (sock, message) => {
    if (!message.isGroup || !hasActiveGuards(message.chat)) return [];
    const access = createAccess(sock, message);
    const lines = [];
    if (!(await access.isBotAdmin())) lines.push('⚠️ The bot is NOT a group admin here,', 'so nothing can be deleted. Make it admin.');
    if (getGroupOption(message.chat, 'exemptadmins')) {
        lines.push('ℹ️ Group admins and bot staff are not checked.', 'Test with a normal member, or turn', '"exemptadmins" off to test it yourself.');
    }
    if (message.fromMe) lines.push('ℹ️ Messages sent from the bot\'s own number', 'are never checked.');
    return lines.length ? ['', ...lines] : [];
};
