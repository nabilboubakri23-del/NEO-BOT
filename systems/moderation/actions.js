import { child } from '../../core/logger.js';
import { describeError } from '../../utils/errors.js';
import { invalidateGroup } from '../groups/groupCache.js';
import { getGroupOption } from './groupConfig.js';
import { addWarning, clearWarnings } from './warnings.js';

/**
 * WhatsApp-side moderation actions shared by commands and the message guard,
 * so ".warn" and an anti-link warning behave exactly the same.
 */

const log = child('moderation');

/** Deletes a message for everyone (the bot must be admin unless it is its own message). */
export const deleteMessage = async (sock, key) => {
    try {
        await sock.sendMessage(key.remoteJid, { delete: key });
        return true;
    } catch (error) {
        log.warn(`Delete failed: ${describeError(error)}`);
        return false;
    }
};

/** Removes one member. Returns true when WhatsApp accepted it. */
export const removeMember = async (sock, group, jid) => {
    try {
        const result = await sock.groupParticipantsUpdate(group, [jid], 'remove');
        invalidateGroup(group);
        const status = result?.[0]?.status;
        return !status || String(status) === '200';
    } catch (error) {
        log.warn(`Remove failed: ${describeError(error)}`);
        return false;
    }
};

/**
 * Gives a member one warning. At the group's warn limit they are removed
 * (when the bot can) and their warnings are cleared.
 * @returns {Promise<{ count: number, limit: number, kicked: boolean }>}
 */
export const applyWarning = async (sock, group, who, jid, { by = '', reason = '' } = {}) => {
    const limit = getGroupOption(group, 'warnlimit');
    const count = addWarning(group, who, { by, reason });
    if (count < limit) return { count, limit, kicked: false };
    const kicked = await removeMember(sock, group, jid);
    if (kicked) clearWarnings(group, who);
    return { count, limit, kicked };
};
